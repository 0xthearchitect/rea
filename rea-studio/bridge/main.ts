import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import { normalizeBundle, supportedVersion } from "./normalize";

const MAX_BUNDLE = 64 * 1024 * 1024;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const controller = new AbortController();
let running = false;
let finished = false;
lines.on("close", () => {
  if (running && !finished) controller.abort();
});
const emit = (type: string, value: unknown) =>
  process.stdout.write(JSON.stringify({ type, value }) + "\n");
lines.on("line", (line) => {
  try {
    const request = JSON.parse(line) as Record<string, unknown>;
    if (request.action === "cancel") {
      controller.abort();
      emit(
        "progress",
        "Cancellation requested. Waiting for transport shutdown; upstream cleanup may remain unknown.",
      );
      return;
    }
    if (running) throw new Error("A bridge accepts one request");
    running = true;
    void run(request)
      .then((value) => emit("result", value))
      .catch((error) =>
        emit("error", {
          message: error instanceof Error ? error.message : String(error),
          cancellation_requested: controller.signal.aborted,
        }),
      )
      .finally(() => {
        finished = true;
        lines.close();
        process.stdin.destroy();
      });
  } catch (error) {
    emit("error", { message: String(error) });
  }
});

async function cli(node: string, rea: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(node, [rea, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let errorBytes = 0;
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error("REA CLI health check timed out after 120 seconds"));
    }, 120000);
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 4 * 1024 * 1024) {
        child.kill();
        reject(new Error("REA discovery exceeded 4 MiB"));
      } else stdout.push(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      if (errorBytes < 65536) {
        stderr.push(data.subarray(0, 65536 - errorBytes));
        errorBytes += data.length;
      }
    });
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8");
      code === 0
        ? resolve(out)
        : reject(new Error(`REA CLI exited ${code}: ${err || out}`));
    });
  });
}
async function run(request: Record<string, unknown>) {
  const node = String(request.node ?? "");
  const rea = String(request.rea ?? "");
  if (!isAbsolute(node) || !isAbsolute(rea))
    throw new Error(
      "Choose absolute paths to the trusted Node executable and REA scripts/rea.mjs in Connection settings.",
    );
  let version: string | null = null;
  let cliAvailable = false;
  let mcpAvailable = false;
  let client: Client | undefined;
  try {
    const versionText = await cli(node, rea, ["--version"]);
    version = /\b(\d+\.\d+\.\d+)\b/.exec(versionText)?.[1] ?? null;
    cliAvailable = true;
    if (!version || !supportedVersion(version)) {
      if (request.action !== "detect")
        throw new Error(
          `Unsupported REA version: ${versionText}. Studio supports 6.4.x.`,
        );
      return {
        state: "incompatible",
        version,
        cli: true,
        mcp: false,
        can_analyze: false,
        tools: [],
        providers: null,
        message: `REA ${versionText}; Studio supports 6.4.x.`,
      };
    }
    // Provider overview belongs to connection discovery. Execution revalidates
    // version, live schemas and MCP availability without another CLI overview.
    const providers =
      request.action === "detect"
        ? (JSON.parse(
            await cli(node, rea, ["capabilities", "--json"]),
          ) as unknown)
        : null;
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const transport = new StdioClientTransport({
      command: node,
      args: [rea, "mcp"],
      stderr: "pipe",
      env: inherited,
    });
    let stderrBytes = 0;
    transport.stderr?.on("data", (data: Buffer) => {
      if (stderrBytes < 65536) {
        stderrBytes += data.length;
        emit("progress", data.toString("utf8").slice(0, 8192));
      }
    });
    client = new Client({ name: "rea-studio", version: "0.1.0" });
    await client.connect(transport, { timeout: 120000 });
    const serverVersion = client.getServerVersion()?.version;
    if (serverVersion !== version)
      throw new Error(
        `CLI/MCP version mismatch: CLI ${version}, MCP ${serverVersion ?? "unknown"}`,
      );
    const tools: {
      name: string;
      inputSchema: unknown;
      outputSchema?: unknown;
    }[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        timeout: 120000,
      });
      for (const tool of page.tools)
        tools.push({
          name: tool.name,
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        });
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor))
        throw new Error("REA repeated a catalog cursor");
      if (cursor) cursors.add(cursor);
      if (tools.length > 2000)
        throw new Error("REA catalog exceeds Studio discovery bound");
    } while (cursor);
    mcpAvailable = true;
    const names = new Set(tools.map((t) => t.name));
    const analysis = tools.find(
      (t) => t.name === "analyze_javascript_application",
    );
    const properties = (
      analysis?.inputSchema as
        | { properties?: Record<string, unknown> }
        | undefined
    )?.properties;
    const contractsMatch =
      [
        "binary_session",
        "analyze_javascript_application",
        "export_evidence_bundle",
      ].every((n) => names.has(n)) &&
      !!properties?.input_path &&
      !!properties?.detail &&
      !!properties?.integrity_policy;
    let availability:
      | { available?: boolean; reason?: string; remediation?: string | null }
      | undefined;
    let session: unknown = null;
    if (names.has("binary_session")) {
      const status = await client.callTool(
        {
          name: "binary_session",
          arguments: { expected_package_version: version },
        },
        undefined,
        { timeout: 60000 },
      );
      if (status.isError) throw new Error(JSON.stringify(status.content));
      session = status.structuredContent;
      const statusObject = (
        session as { result?: { tool_availability?: unknown } }
      ).result;
      const inventory = statusObject?.tool_availability;
      // The published 6.4.0 lifecycle result uses individual entries; the researched
      // source checkout uses the documented compact inventory. Parse once here.
      if (Array.isArray(inventory))
        availability = inventory.find(
          (g) => g?.name === "analyze_javascript_application",
        );
      else if (
        inventory &&
        typeof inventory === "object" &&
        "groups" in inventory &&
        Array.isArray(inventory.groups)
      )
        availability = inventory.groups.find(
          (g) =>
            Array.isArray(g?.names) &&
            g.names.includes("analyze_javascript_application"),
        );
    }
    const canAnalyze = contractsMatch && availability?.available === true;
    const supportsSourcePaths = !!properties?.source_paths;
    const readinessMessage = !contractsMatch
      ? "The live tool catalog does not provide the required Studio contracts."
      : !canAnalyze
        ? `Static analysis unavailable: ${availability?.reason ?? "availability unknown"}. ${availability?.remediation ?? "Inspect actual provider status below."}`
        : "CLI, MCP, and static-analysis availability checks passed.";
    if (request.action === "detect")
      return {
        state: canAnalyze
          ? "connected"
          : contractsMatch
            ? "missing_dependency"
            : "incompatible",
        version,
        cli: true,
        mcp: true,
        can_analyze: canAnalyze,
        supports_source_paths: supportsSourcePaths,
        tools,
        providers: { cli: providers, mcp: session },
        message: readinessMessage,
      };
    if (request.action !== "analyze" || !canAnalyze)
      throw new Error("Analysis is unavailable for this connection");
    const inputPath = String(request.target ?? "");
    const output = String(request.output ?? "");
    const projection = String(request.projection ?? "");
    if (![inputPath, output, projection].every(isAbsolute))
      throw new Error("Analysis paths must be absolute");
    const sourcePaths = request.source_paths;
    if (
      Array.isArray(sourcePaths) &&
      sourcePaths.length &&
      !supportsSourcePaths
    )
      throw new Error(
        "Source path selection is unavailable in this installation’s advertised analysis contract. Run full analysis or connect a REA build that advertises source_paths.",
      );
    if (
      sourcePaths !== undefined &&
      (!Array.isArray(sourcePaths) ||
        sourcePaths.some((p) => typeof p !== "string" || p.includes("\0")))
    )
      throw new Error("Invalid exact source path selection");
    emit(
      "progress",
      `REA ${version}: static analysis started. Imported code is not executed.`,
    );
    const reply = await client.callTool(
      {
        name: "analyze_javascript_application",
        arguments: {
          input_path: inputPath,
          format: "auto",
          integrity_policy: "fail",
          detail: "summary",
          ...(Array.isArray(sourcePaths) && sourcePaths.length
            ? { source_paths: sourcePaths }
            : {}),
        },
      },
      undefined,
      {
        signal: controller.signal,
        timeout: 30 * 60 * 1000,
        resetTimeoutOnProgress: true,
        onprogress: (update) =>
          emit(
            "progress",
            update.message ?? `Progress observation ${update.progress}`,
          ),
      },
    );
    if (reply.isError) throw new Error(JSON.stringify(reply.content));
    const summary = reply.structuredContent as
      | { normalized_result?: { parent_evidence_id?: unknown } }
      | undefined;
    const evidenceId = summary?.normalized_result?.parent_evidence_id;
    if (typeof evidenceId !== "string")
      throw new Error(
        "REA summary omitted the full-analysis Evidence reference",
      );
    controller.signal.throwIfAborted();
    emit(
      "progress",
      "Exporting complete original Evidence before closing the REA session.",
    );
    const receipt = await client.callTool(
      {
        name: "export_evidence_bundle",
        arguments: { path: output, overwrite: false },
      },
      undefined,
      { timeout: 120000 },
    );
    if (receipt.isError) throw new Error(JSON.stringify(receipt.content));
    if ((await stat(output)).size > MAX_BUNDLE)
      throw new Error(
        "Complete Evidence was saved, but exceeds the 64 MiB Studio indexing limit. Use REA source selection; the original export remains on disk.",
      );
    const normalized = normalizeBundle(
      JSON.parse(await readFile(output, "utf8")),
      evidenceId,
    );
    await writeFile(projection, JSON.stringify(normalized), {
      flag: "wx",
      mode: 0o600,
    });
    return { version, evidence_id: evidenceId, projection, raw_path: output };
  } catch (error) {
    if (request.action !== "detect") throw error;
    return {
      state: !cliAvailable ? "missing_dependency" : "error",
      version,
      cli: cliAvailable,
      mcp: mcpAvailable,
      can_analyze: false,
      tools: [],
      providers: null,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (client) await client.close();
  }
}
