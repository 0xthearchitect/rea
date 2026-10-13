import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(".local", `failure-verification-${Date.now()}`);
await mkdir(root, { recursive: true });
const rea = resolve(process.env.REA_STUDIO_REA_ENTRY ?? "../scripts/rea.mjs");
async function check(request, cancel = false) {
  const child = spawn(
    process.execPath,
    [resolve("src-tauri/resources/bridge.mjs")],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "inherit"] },
  );
  const events = [];
  let remainder = "";
  let cancellationSent = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    remainder += chunk;
    let index;
    while ((index = remainder.indexOf("\n")) >= 0) {
      const event = JSON.parse(remainder.slice(0, index));
      remainder = remainder.slice(index + 1);
      events.push(event);
      if (
        cancel &&
        !cancellationSent &&
        event.type === "progress" &&
        event.value.includes("static analysis started")
      ) {
        cancellationSent = true;
        child.stdin.write('{"action":"cancel"}\n');
      }
    }
  });
  child.stdin.write(
    JSON.stringify({ node: process.execPath, rea, ...request }) + "\n",
  );
  await new Promise((ok, no) => {
    child.once("error", no);
    child.once("exit", (code) =>
      code === 0 ? ok() : no(new Error(`Bridge exit ${code}`)),
    );
  });
  return events;
}
const missing = await check({
  action: "detect",
  rea: resolve(root, "absent-rea.mjs"),
});
if (
  missing.find((e) => e.type === "result")?.value.state !== "missing_dependency"
)
  throw new Error("Missing dependency was not reported");
console.log("Missing dependency: verified");
const invalid = await check({
  action: "analyze",
  target: resolve("tests/fixtures/application"),
  source_paths: ["file-that-does-not-exist.js"],
  output: resolve(root, "invalid-evidence.json"),
  projection: resolve(root, "invalid-projection.json"),
});
if (
  !invalid.some(
    (e) =>
      e.type === "error" &&
      (e.value.message.includes("invalid_request") ||
        e.value.message.includes("Source path selection is unavailable")),
  ) ||
  invalid.some((e) => e.type === "result")
)
  throw new Error(
    `Source-selection failure was not reported: ${JSON.stringify(invalid)}`,
  );
console.log(
  "Unsupported or invalid source selection is rejected from actual installation contracts: verified",
);
const cancelled = await check(
  {
    action: "analyze",
    target: resolve("tests/fixtures/application"),
    output: resolve(root, "cancelled-evidence.json"),
    projection: resolve(root, "cancelled-projection.json"),
  },
  true,
);
if (
  !cancelled.some(
    (e) => e.type === "error" && e.value.cancellation_requested === true,
  ) ||
  cancelled.some((e) => e.type === "result")
)
  throw new Error(
    "Cancellation was incorrectly reported as successful analysis",
  );
console.log(
  "Cancellation request remains distinct from success; upstream cleanup unknown: verified",
);
