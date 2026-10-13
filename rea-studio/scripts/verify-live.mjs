import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createPackage } from "@electron/asar";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
const node = process.execPath;
const rea = resolve(process.env.REA_STUDIO_REA_ENTRY ?? "../scripts/rea.mjs");
const dir = resolve(".local", `verification-${Date.now()}`);
await mkdir(dir, { recursive: true });
const args = process.argv.slice(2);
if (
  args.some((arg) => !["--asar", "--large", "--dense"].includes(arg)) ||
  (args.includes("--large") && args.includes("--dense"))
)
  throw new Error("Usage: npm run test:live -- [--asar] [--large | --dense]");
let target = resolve("tests/fixtures/application");
if (args.includes("--large") || args.includes("--dense")) {
  target = resolve(dir, "application");
  await cp(resolve("tests/fixtures/application"), target, { recursive: true });
  const main = await readFile(resolve(target, "main.js"), "utf8");
  const imports = [];
  const count = args.includes("--dense") ? 48 : 200;
  for (let i = 0; i < count; i++) {
    const dependencies = args.includes("--dense")
      ? Array.from({ length: i }, (_, j) =>
          `import { value${j} } from './module-${j}.js';\n`,
        ).join("")
      : "";
    await writeFile(
      resolve(target, `module-${i}.js`),
      dependencies + `export function value${i}(input) { return input + ${i}; }\n`,
      { flag: "wx" },
    );
    imports.push(`import { value${i} } from './module-${i}.js';`);
  }
  await writeFile(
    resolve(target, "main.js"),
    main + "\n" + imports.join("\n") +
      "\nexport const transforms = [" +
      Array.from({ length: count }, (_, i) => `value${i}`).join(", ") + "];\n",
  );
}
if (args.includes("--asar")) {
  const archive = resolve(dir, "application.asar");
  await createPackage(target, archive);
  target = archive;
}
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
    child.once("close", (code) =>
      code === 0 ? ok() : no(new Error(`Bridge exited ${code}`)),
    );
  });
  const events = output
    .trim()
    .split("\n")
    .filter(Boolean)
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
  target,
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
if (projection.input_path !== target)
  throw new Error("Real analysis returned another target path");
if (
  args.includes("--large") &&
  (projection.nodes.length <= 300 || projection.edges.length <= 800)
)
  throw new Error("Large sample did not exceed both graph rendering limits");
if (
  args.includes("--dense") &&
  (projection.nodes.length > 300 || projection.edges.length <= 800)
)
  throw new Error("Dense sample must fit the node limit and exceed the edge limit");
console.log(
  JSON.stringify({
    phase: "analysis",
    target_format: args.includes("--asar") ? "asar" : "directory",
    large: args.includes("--large"),
    dense: args.includes("--dense"),
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
