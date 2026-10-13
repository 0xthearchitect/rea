import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

const root = resolve(".local", `native-verification-${Date.now()}`);
await mkdir(root, { recursive: true });
const pe = process.argv.includes("--pe");
const reuse = process.argv.includes("--reuse");
if (process.argv.slice(2).some((arg) => arg !== "--pe" && arg !== "--reuse"))
  throw new Error("Usage: npm run test:native:live -- [--pe] [--reuse]");
const target = resolve(root, pe ? "native-demo.exe" : "native-demo");
await new Promise((ok, no) => {
  const cc = spawn(
    pe ? "x86_64-w64-mingw32-gcc" : "cc",
    ["-O0", "-g", resolve("tests/fixtures/native/demo.c"), "-o", target],
    { shell: false, stdio: "inherit" },
  );
  cc.once("error", no);
  cc.once("close", (code) =>
    code === 0
      ? ok()
      : no(new Error(`Native fixture compilation failed: ${code}`)),
  );
});
const digest = async () =>
  createHash("sha256")
    .update(await readFile(target))
    .digest("hex");
const before = await digest();
const rea = resolve(process.env.REA_STUDIO_REA_ENTRY ?? "../scripts/rea.mjs");
let persistent;
async function request(value) {
  const start = performance.now();
  const keep = reuse && value.action === "analyze_native";
  const child =
    keep && persistent
      ? persistent
      : spawn(process.execPath, [resolve("src-tauri/resources/bridge.mjs")], {
          shell: false,
          stdio: ["pipe", "pipe", "inherit"],
        });
  if (keep) persistent = child;
  const events = [];
  const lines = createInterface({ input: child.stdout });
  const result = await new Promise((ok, no) => {
    const fail = (error) => {
      lines.close();
      no(error);
    };
    child.once("error", fail);
    child.once("exit", (code) =>
      fail(new Error(`Bridge ended before terminal event: ${code}`)),
    );
    lines.on("line", (line) => {
      const event = JSON.parse(line);
      events.push(event);
      if (event.type !== "result" && event.type !== "error") return;
      lines.close();
      child.removeListener("error", fail);
      child.removeAllListeners("exit");
      if (event.type === "error") {
        persistent = undefined;
        child.stdin.end();
        no(new Error(JSON.stringify(event.value)));
      } else ok(event.value);
    });
    child.stdin.write(
      JSON.stringify({
        node: process.execPath,
        rea,
        ...value,
        keep_alive: keep,
      }) + "\n",
    );
  });
  if (!keep)
    await new Promise((ok, no) =>
      child.once("close", (code) =>
        code === 0 ? ok() : no(new Error(`Bridge exited ${code}`)),
      ),
    );
  return { result, elapsed_ms: Math.round(performance.now() - start), events };
}
process.on("exit", () => persistent?.stdin.end());
try {
  const connection = await request({ action: "detect" });
  await writeFile(
    resolve(root, "connection.json"),
    JSON.stringify(connection.result),
  );
  if (!connection.result.native?.can_open)
    throw new Error("Native contracts unavailable in actual installation");
  const provider = process.env.STUDIO_NATIVE_PROVIDER ?? "ghidra";
  let functionAddress = "";
  let referenceAddress = "";
  let sourceAddress = "";
  const runs = [];
  let firstFunction;
  for (const [operation, query] of [
    ["overview", ""],
    ["procedures", "main"],
    ["strings", ""],
    ["function", "main"],
    ["instructions", "main"],
    ["references", null],
    ["instruction", null],
    ["function", "main"],
  ]) {
    const directory = resolve(root, `${runs.length}-${operation}`);
    await mkdir(directory);
    const analysis = await request({
      action: "analyze_native",
      target,
      native_request: {
        operation,
        provider_id: provider,
        query:
          query ??
          (operation === "references" ? referenceAddress : sourceAddress),
      },
      output: resolve(directory, "evidence.json"),
      projection: resolve(directory, "projection.json"),
    });
    const projection = JSON.parse(
      await readFile(analysis.result.projection, "utf8"),
    );
    const bundle = JSON.parse(await readFile(analysis.result.raw_path, "utf8"));
    if (projection.target_sha256 !== before || projection.input_path !== target)
      throw new Error("Target identity changed");
    for (const node of projection.nodes)
      if (!bundle.records.some((r) => r.evidence_id === node.evidence_id))
        throw new Error("Finding lost original Evidence identity");
    if (
      operation === "overview" &&
      !projection.nodes.some((n) => n.label === ".text")
    )
      throw new Error("ELF segments absent");
    if (
      operation === "procedures" &&
      !projection.nodes.some((n) => n.label === "main")
    )
      throw new Error("Main procedure absent");
    if (
      operation === "strings" &&
      !projection.nodes.some((n) => n.label.includes("REA Studio native demo"))
    )
      throw new Error("Owned string absent");
    if (operation === "function") {
      const record = bundle.records.find(
        (r) => r.evidence_id === projection.evidence_id,
      );
      if (
        firstFunction &&
        !isDeepStrictEqual(firstFunction, record.normalized_result)
      )
        throw new Error("Repeated exact query changed normalized facts");
      firstFunction = record.normalized_result;
      const node = projection.nodes.find((n) => n.kind === "native-function");
      if (!node?.facts.view.code?.includes("calculate_total"))
        throw new Error("Real decompilation absent");
      functionAddress = node.facts.view.procedure;
      referenceAddress =
        node.facts.view.tables
          .flatMap((t) => t.links ?? [])
          .find((l) => l.query !== functionAddress)?.query ?? functionAddress;
      if (typeof functionAddress !== "string")
        throw new Error("Native function address absent");
    }
    if (
      operation === "instructions" &&
      !projection.nodes[0]?.facts.view.assembly?.length
    )
      throw new Error("Instructions absent");
    if (
      operation === "references" &&
      projection.nodes[0]?.facts.view.fields[0]?.value !== referenceAddress
    )
      throw new Error("Reference query changed");
    if (operation === "references") {
      sourceAddress =
        projection.nodes[0]?.facts.view.tables[0]?.links?.[0]?.query;
      if (!sourceAddress)
        throw new Error("No real caller address available for navigation");
    }
    if (
      operation === "instruction" &&
      projection.nodes[0]?.facts.value.address !== sourceAddress
    )
      throw new Error("Instruction navigation changed the observed address");
    if (reuse && runs.length && analysis.result.session_reused !== true)
      throw new Error("Native session was not reused");
    const run = {
      operation,
      nodes: projection.nodes.length,
      evidence_id: analysis.result.evidence_id,
      elapsed_ms: analysis.elapsed_ms,
      session_reused: analysis.result.session_reused,
      projection: analysis.result.projection,
    };
    runs.push(run);
    console.log(JSON.stringify(run));
  }
  if (persistent) {
    const child = persistent;
    persistent = undefined;
    const lines = createInterface({ input: child.stdout });
    await new Promise((ok, no) => {
      lines.on("line", (line) => {
        const event = JSON.parse(line);
        if (event.type === "error") no(new Error(JSON.stringify(event.value)));
      });
      child.once("close", (code) => {
        lines.close();
        code === 0
          ? ok()
          : no(new Error(`Retained bridge cleanup failed: ${code}`));
      });
      child.stdin.write(JSON.stringify({ action: "shutdown" }) + "\n");
    });
  }

  if ((await digest()) !== before)
    throw new Error("Selected target bytes were modified");
  await writeFile(resolve(root, "runs.json"), JSON.stringify(runs, null, 2));
  console.log(
    JSON.stringify({
      native_workflow: "passed",
      provider,
      session_reuse: reuse,
      target_sha256: before,
      artifacts: root,
      target_executed: false,
    }),
  );
} finally {
  persistent?.stdin.end();
}
