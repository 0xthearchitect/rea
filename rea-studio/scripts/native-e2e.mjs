import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(".local", `native-e2e-${Date.now()}`);
await mkdir(root, { recursive: true });
const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
  { windowsHide: true, stdio: "ignore" },
);
const binary = resolve(
  process.env.STUDIO_E2E_BINARY ?? "src-tauri/target/debug/rea-studio.exe",
);
let app;
async function launch() {
  app = spawn(binary, [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      STUDIO_E2E_DATA: root,
      STUDIO_E2E_TARGET: resolve("tests/fixtures/application"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--remote-debugging-port=9223 --remote-debugging-address=127.0.0.1",
    },
  });
  app.once("error", (error) => {
    console.error(error);
  });
  app.stderr.pipe(process.stderr);
  let browser;
  for (let i = 0; i < 120; i++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9223", {
        timeout: 2000,
      });
      break;
    } catch {
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
  if (!browser) throw new Error("Native WebView2 debug endpoint did not start");
  let page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error("No native Studio window");
  await page.waitForLoadState("domcontentloaded");
  console.log("Native WebView2 connected");
  return { browser, page };
}
try {
  const { browser, page } = await launch();
  await page
    .getByRole("heading", { name: "Start with the evidence." })
    .waitFor({ timeout: 120000 });
  await page
    .getByRole("button", { name: "New investigation", exact: true })
    .last()
    .click();
  await page.getByLabel("Investigation name").fill("Native vertical slice");
  await page.getByRole("button", { name: "Choose target & create" }).click();
  await page.getByRole("heading", { name: "Native vertical slice" }).waitFor();
  console.log("Native project import and SQLite persistence created");
  console.log(
    JSON.stringify(
      await page.evaluate(async () => {
        const settings =
          await window.__TAURI_INTERNALS__.invoke("get_settings");
        const result =
          await window.__TAURI_INTERNALS__.invoke("detect_connection");
        return { settings, state: result.state, message: result.message };
      }),
    ),
  );
  const run = page.getByRole("button", { name: "Run analysis", exact: true });
  await run.waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent?.trim() === "Run analysis" && !b.disabled,
      ),
    undefined,
    { timeout: 180000 },
  );
  await run.click();
  await page
    .getByRole("button", { name: "Start analysis", exact: true })
    .click();
  await page
    .getByRole("listbox", { name: "Analysis findings" })
    .waitFor({ timeout: 240000 });
  console.log("Real REA findings rendered in native UI");
  await page.getByLabel("Search investigation").fill("parser");
  const findings = page.getByRole("listbox", { name: "Analysis findings" });
  const parserFinding = findings
    .getByRole("option")
    .filter({ hasText: "parser.js" })
    .first();
  await parserFinding.waitFor();
  await parserFinding.click();
  await page
    .getByRole("button", { name: "Inspect original provenance" })
    .click();
  await page.getByText("REA EVIDENCE IDENTIFIER", { exact: true }).waitFor();
  const evidenceId = await page
    .locator(".evidence-document > .evidence-id")
    .textContent();
  if (!/^ev_[a-f0-9]{64}$/.test(evidenceId ?? ""))
    throw new Error("No real Evidence identifier in native UI");
  await page
    .getByRole("tab", { name: "Application graph", exact: true })
    .click();
  await page.locator(".graph-canvas canvas").first().waitFor();
  await page.screenshot({ path: resolve(root, "native-graph.png") });
  // A normal close goes through the same native close guard and storage lifecycle.
  await page
    .evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("plugin:window|close", {
        label: "main",
      });
    })
    .catch(() => {});
  await browser.close();
  if (app.exitCode === null)
    await new Promise((ok) => {
      app.once("exit", ok);
      setTimeout(ok, 5000);
    });
  if (app.exitCode === null) {
    app.kill();
    await new Promise((ok) => app.once("exit", ok));
  }
  const reopened = await launch();
  await reopened.page
    .getByRole("heading", { name: "Native vertical slice" })
    .waitFor({ timeout: 120000 });
  await reopened.page
    .getByRole("tab", { name: "Evidence", exact: true })
    .click();
  await reopened.page.getByText(evidenceId, { exact: true }).first().waitFor();
  await reopened.page.screenshot({
    path: resolve(root, "native-reopened.png"),
  });
  await reopened.browser.close();
  console.log(
    JSON.stringify({
      native_vertical_slice: "passed",
      evidence_id: evidenceId,
      persisted: true,
      artifacts: root,
    }),
  );
} finally {
  app?.kill();
  server.kill();
}
