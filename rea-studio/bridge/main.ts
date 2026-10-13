import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";

import { analyzeJavascript } from "./javascript";
import { runAgent, detectAgent } from "./agent";
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import { supportedVersion } from "./normalize";
import {
  analyzeNative,
  availability,
  nativeDiscovery,
  NativeSession,
} from "./native";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let controller = new AbortController();
let retained:
  | {
      node: string;
      rea: string;
      version: string;
      native: ReturnType<typeof nativeDiscovery>;
      session: NativeSession;
    }
  | undefined;
async function shutdown() {
  if (!retained) return;
  const owned = retained;
  let failure: unknown;
  try {
    await owned.session.close();
  } catch (error) {
    failure = error;
  }
  try {
    await owned.session.client.close();
  } catch (error) {
    failure = new Error(
      `${failure ? String(failure) + "; " : ""}Transport cleanup remains unknown: ${String(error)}`,
    );
  }
  if (failure) {
    process.exitCode = 1;
    throw failure;
  }
  retained = undefined;
}
let running = false;
let finished = false;
lines.on("close", () => {
  if (running && !finished) controller.abort();
  else
    void shutdown().catch((error) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
    });
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
    if (running) throw new Error("A bridge accepts one active request");
    running = true;
    finished = false;
    controller = new AbortController();
    let keep = request.keep_alive === true;
    void (
      request.action === "shutdown"
        ? shutdown().then(() => ({ closed: true }))
        : run(request)
    )
      .then((value) => emit("result", value))
      .catch(async (error) => {
        keep = false;
        let cleanup = "";
        try {
          await shutdown();
        } catch (e) {
          cleanup = `; ${String(e)}`;
        }
        emit("error", {
          message:
            (error instanceof Error ? error.message : String(error)) + cleanup,
          cancellation_requested: controller.signal.aborted,
        });
      })
      .finally(() => {
        finished = true;
        running = false;
        if (!keep) {
          lines.close();
          process.stdin.destroy();
        }
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
  if (request.action === "detect_agent") return detectAgent(request);
  if (retained) {
    if (
      request.action === "analyze_native" &&
      request.keep_alive === true &&
      retained.node === node &&
      retained.rea === rea
    )
      return analyzeNative(
        retained.session.client,
        request,
        controller.signal,
        emit,
        retained.version,
        retained.native,
        retained.session,
      );
    await shutdown();
  }
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
    const catalogNames = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        timeout: 120000,
      });
      for (const tool of page.tools) {
        if (catalogNames.has(tool.name))
          throw new Error(
            `REA advertised duplicate tool identity: ${tool.name}`,
          );
        catalogNames.add(tool.name);
        tools.push({
          name: tool.name,
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        });
      }
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
    }
    const applicationStatus = availability(session).find(
      (s) => s.name === "analyze_javascript_application",
    );
    const native = nativeDiscovery(session, tools);
    const canAnalyze = contractsMatch && applicationStatus?.available === true;
    const supportsSourcePaths = !!properties?.source_paths;
    const readinessMessage = [
      "CLI and MCP checks passed.",
      canAnalyze
        ? "JavaScript analysis is available."
        : `JavaScript analysis unavailable: ${contractsMatch ? (applicationStatus?.reason ?? "availability unknown") : "required contracts missing"}. ${applicationStatus?.remediation ?? ""}`,
      native.can_open
        ? "Native opening is available; provider and target support are checked when opening."
        : "Native lifecycle contracts or availability are missing.",
    ].join(" ");
    if (request.action === "detect")
      return {
        state:
          canAnalyze || native.can_open
            ? "connected"
            : contractsMatch
              ? "missing_dependency"
              : "incompatible",
        version,
        cli: true,
        mcp: true,
        can_analyze: canAnalyze,
        supports_source_paths: supportsSourcePaths,
        native,
        tools,
        providers: { cli: providers, mcp: session },
        message: readinessMessage,
      };
    if (request.action === "agent") {
      const session = new NativeSession(client);
      try {
        return await runAgent(
          request,
          controller.signal,
          emit,
          async (task) => {
            if (request.workflow === "native")
              return analyzeNative(
                client!,
                task,
                controller.signal,
                emit,
                version!,
                native,
                session,
              );
            if (!canAnalyze)
              throw new Error(
                "JavaScript analysis is unavailable for this connection",
              );
            return analyzeJavascript(
              client!,
              task,
              controller.signal,
              emit,
              version!,
              supportsSourcePaths,
            );
          },
        );
      } finally {
        try {
          await session.close();
        } catch (error) {
          process.exitCode = 1;
          throw error;
        }
      }
    }
    if (request.action === "analyze_native") {
      const session = new NativeSession(client);
      if (request.keep_alive === true)
        retained = { node, rea, version, native, session };
      return await analyzeNative(
        client,
        request,
        controller.signal,
        emit,
        version,
        native,
        session,
      );
    }
    if (request.action !== "analyze" || !canAnalyze)
      throw new Error("Analysis is unavailable for this connection");
    return analyzeJavascript(
      client,
      request,
      controller.signal,
      emit,
      version,
      supportsSourcePaths,
    );
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
    if (client && retained?.session.client !== client) await client.close();
  }
}
