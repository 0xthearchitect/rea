import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readFile, writeFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { normalizeBundle } from "./normalize";
export async function analyzeJavascript(
  client: Client,
  request: Record<string, unknown>,
  signal: AbortSignal,
  emit: (type: string, value: unknown) => void,
  version: string,
  supportsSourcePaths: boolean,
) {
  const inputPath = String(request.target ?? "");
  const output = String(request.output ?? "");
  const projection = String(request.projection ?? "");
  if (![inputPath, output, projection].every(isAbsolute))
    throw new Error("Analysis paths must be absolute");
  const sourcePaths = request.source_paths;
  if (Array.isArray(sourcePaths) && sourcePaths.length && !supportsSourcePaths)
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
      signal: signal,
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
    throw new Error("REA summary omitted the full-analysis Evidence reference");
  signal.throwIfAborted();
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
  if ((await stat(output)).size > 64 * 1024 * 1024)
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
}
