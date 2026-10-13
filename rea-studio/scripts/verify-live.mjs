import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
const node = process.execPath;
const rea = resolve(process.env.REA_STUDIO_REA_ENTRY ?? "../scripts/rea.mjs");
const dir = resolve(".local", `verification-${Date.now()}`);
await mkdir(dir, { recursive: true });
async function request(action, extra = {}) {
  const start = performance.now();
  const child = spawn(node, [resolve("src-tauri/resources/bridge.mjs")], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin.write(JSON.stringify({ action, node, rea, ...extra }) + "\n");
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  await new Promise((ok, no) => {
    child.once("error", no);
    child.once("exit", (code) =>
      code === 0 ? ok() : no(new Error(`Bridge exited ${code}`)),
    );
  });
  const events = output
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  const error = events.find((e) => e.type === "error");
  if (error) throw new Error(JSON.stringify(error.value));
  const result = events.find((e) => e.type === "result");
  if (!result) throw new Error("No result");
  return {
    result: result.value,
    elapsed_ms: Math.round(performance.now() - start),
    progress_observations: events.filter((e) => e.type === "progress").length,
  };
}
const connection = await request("detect");
await writeFile(
  resolve(dir, "connection.json"),
  JSON.stringify(connection.result),
);
if (connection.result.state !== "connected")
  throw new Error(
    JSON.stringify({
      state: connection.result.state,
      message: connection.result.message,
      version: connection.result.version,
    }),
  );
console.log(
  JSON.stringify({
    phase: "connection",
    version: connection.result.version,
    cli: connection.result.cli,
    mcp: connection.result.mcp,
    tools: connection.result.tools.length,
    elapsed_ms: connection.elapsed_ms,
  }),
);
const analysis = await request("analyze", {
  target: resolve("tests/fixtures/application"),
  output: resolve(dir, "evidence.json"),
  projection: resolve(dir, "projection.json"),
});
const projection = JSON.parse(
  await readFile(analysis.result.projection, "utf8"),
);
if (
  !projection.nodes.some((n) => n.label.includes("parser")) ||
  !projection.edges.some((e) => e.relation === "imports")
)
  throw new Error(
    "Real analysis did not return expected sample module relationships",
  );
console.log(
  JSON.stringify({
    phase: "analysis",
    version: analysis.result.version,
    evidence_id: analysis.result.evidence_id,
    nodes: projection.nodes.length,
    edges: projection.edges.length,
    coverage: projection.coverage,
    elapsed_ms: analysis.elapsed_ms,
    progress_observations: analysis.progress_observations,
    projection: analysis.result.projection,
    evidence: analysis.result.raw_path,
  }),
);
