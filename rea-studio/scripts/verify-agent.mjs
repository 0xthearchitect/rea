import { spawn } from "node:child_process";
import { mkdir, cp, readFile, writeFile, stat } from "node:fs/promises";
import { resolve, delimiter, join } from "node:path";
import { createInterface } from "node:readline";

const root = resolve(".local", `agent-verification-${Date.now()}`);
await mkdir(root, { recursive: true });
const target = resolve(root, "application");
await cp(resolve("tests/fixtures/application"), target, { recursive: true });
const directory = resolve(root, "turn");
await mkdir(directory);
const rea = resolve(
  process.env.REA_STUDIO_REA_ENTRY ??
    ".local/rea-runtime/node_modules/rea-agents/scripts/rea.mjs",
);
let agent = process.env.STUDIO_CODEX_ENTRY;
if (!agent) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(
      directory,
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    if (
      await stat(candidate)
        .then((s) => s.isFile())
        .catch(() => false)
    ) {
      agent = resolve(candidate);
      break;
    }
  }
}
if (!agent)
  throw new Error(
    "Set STUDIO_CODEX_ENTRY to an existing absolute Codex executable",
  );
async function request(input) {
  const child = spawn(
    process.execPath,
    [resolve("src-tauri/resources/bridge.mjs")],
    { stdio: ["pipe", "pipe", "pipe"], shell: false },
  );
  const events = [];
  let failure;
  let cancelled = false;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const event = JSON.parse(line);
    events.push(event);
    if (
      process.argv.includes("--cancel") &&
      input.action === "agent" &&
      event.type === "agent_event" &&
      event.value.type === "session" &&
      !cancelled
    ) {
      cancelled = true;
      child.stdin.write(JSON.stringify({ action: "cancel" }) + "\n");
    }
    if (event.type === "error") failure = event.value;
  });
  child.stderr.resume();
  child.stdin.write(
    JSON.stringify({ node: process.execPath, rea, ...input }) + "\n",
  );
  const code = await new Promise((ok, no) => {
    child.once("error", no);
    child.once("close", ok);
  });
  await writeFile(
    resolve(root, input.action + "-events.json"),
    JSON.stringify(events),
  );
  if (code !== 0 || failure) throw new Error(JSON.stringify({ code, failure }));
  const result = events.find((e) => e.type === "result")?.value;
  if (!result) throw new Error("Bridge omitted result");
  return { result, events };
}
const connection = await request({ action: "detect_agent", agent });
console.log(JSON.stringify({ agent_connection: connection.result }));
if (process.argv.includes("--connection-only")) process.exit(0);
const started = performance.now();
const turn = await request({
  action: "agent",
  agent,
  model: process.env.STUDIO_AGENT_MODEL ?? "",
  target,
  workflow: "javascript",
  directory,
  history: [],
  context: { target, workflow: "javascript", selected_evidence: null },
  question:
    "Use rea_analyze with source_paths: [] to inspect this self-authored JavaScript fixture. Explain what it does in a short answer, cite an original ev_ Evidence ID returned by REA, and distinguish what remains unknown. Do not execute any code.",
});
if (process.argv.includes("--cancel")) {
  if (turn.result.status !== "interrupted")
    throw new Error("Cancellation was promoted into success");
  console.log(
    JSON.stringify({ agent_cancellation: "interrupted", artifacts: root }),
  );
  process.exit(0);
}
if (turn.result.status !== "completed")
  throw new Error(JSON.stringify(turn.result));
const analyses = turn.events.filter(
  (e) => e.type === "agent_event" && e.value.type === "analysis",
);
if (!analyses.length)
  throw new Error("Agent did not use the real REA workflow");
for (const { value } of analyses) {
  const bundle = JSON.parse(await readFile(value.raw_path, "utf8"));
  if (!bundle.records.some((r) => r.evidence_id === value.evidence_id))
    throw new Error("Original Evidence identity lost");
}
if (!analyses.some((e) => turn.result.answer.includes(e.value.evidence_id)))
  throw new Error("Agent answer did not cite produced Evidence");
await writeFile(resolve(root, "result.json"), JSON.stringify(turn.result));
console.log(
  JSON.stringify({
    agent_workflow: "passed",
    model: turn.result.model,
    provider: turn.result.model_provider,
    analyses: analyses.length,
    usage: turn.result.usage,
    elapsed_ms: Math.round(performance.now() - started),
    artifacts: root,
    target_executed: false,
  }),
);
