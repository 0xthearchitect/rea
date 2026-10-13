# REA Studio

An independent, open-source graphical frontend for [REA — Reverse Engineer Anything](https://github.com/morluto/rea). REA is the analysis engine; Studio is the local investigation workspace. This project does not imply endorsement by REA's maintainers.

Studio exposes existing REA static workflows through a local desktop workspace: JavaScript/Electron application analysis and native binary inspection. Native tasks cover overview/sections, function discovery, strings, function dossiers/pseudocode, instructions, and references. Projects and original Evidence reopen from SQLite. Static investigation requires no account, subscription, cloud service, or AI provider. The optional Agent workspace uses your installed Codex client and its configured model provider. Studio has no telemetry. The REA engine is unchanged.

## Run from source

Install the pinned Node 24.18.0/npm 11.16.0 toolchain, Rust, and [Tauri desktop prerequisites](https://v2.tauri.app/start/prerequisites/) yourself. On Windows the standard toolchain requires Visual C++ Build Tools, a Windows SDK, and WebView2. macOS/Linux require their corresponding Tauri system dependencies.

```sh
cd rea-studio
npm ci
npm run build
npm run desktop
```

For a compiled application with embedded frontend assets, use `npm run tauri -- build --debug --no-bundle --features custom-protocol`, then launch the generated executable. `npm run package` builds an installer. Windows NSIS is the configured package target; set an appropriate Tauri bundle target when packaging another platform. Generated installers are unsigned unless you configure your own signing credentials.

Install a trusted REA **6.4.x** package separately. On Windows, use a published package that includes its native filesystem helper; building REA's helper from source currently requires the upstream Linux/MinGW lane. Select an absolute Node executable and the installed REA package's `scripts/rea.mjs` under **Connection settings**. The app checks CLI version, CLI capabilities, MCP initialization, the live catalog, and session availability before enabling analysis. A version number alone is insufficient.

## First investigation

1. Open Connection settings and check the actual installation.
2. Choose **New investigation**, name it, and choose a JavaScript directory, Electron ASAR, or native binary file through the native dialog.
3. Choose **Run analysis**. Optionally supply exact artifact-relative source paths, one per line.
4. Search and filter the findings, or open **Application graph**. Select a node or an edge to inspect its original provenance.
5. Open **Evidence** to inspect the record header and selected facts, or export the complete original bundle to a new file.
6. Restart Studio; projects and analysis history reopen from the local store.

JavaScript source inspection is read-only and restricted to directory files whose SHA-256 still matches REA's recorded artifact digest. A changed source requires a new analysis. Source extraction from ASAR is not exposed.

For a native binary, **Run analysis** opens a task and provider selector. Choose a configured provider or leave REA's existing preference intact; explicit automatic selection is also available. Each task checks target-specific availability, records progress, exports complete original Evidence, and retains its owned session for subsequent queries. Choose **Find functions** to search by literal name; select a finding and use **Inspect this function** to inspect its exact provider address. **Code & references** displays sections, strings, decompiler pseudocode, provider instructions, and returned caller/callee or reference tables as applicable. Pseudocode is explicitly marked as decompiler-generated rather than original source.

Native providers remain bring-your-own and use REA's existing configuration, including its environment variables. Connection settings show actual provider availability and diagnostics. Studio neither installs providers nor modifies their configuration. Native files are handed to REA for format and target support decisions; Linux/Ghidra verification covers self-authored ELF and PE samples. Mach-O and other provider/host combinations remain unverified. Native `.app` directory import is not exposed.

`Ctrl/Cmd K` focuses investigation search. `Ctrl/Cmd O` creates an investigation. Arrow keys navigate findings. Drag panel separators or use their arrow keys to resize; theme, panel layout, active views, and graph viewport preferences persist locally.

## Current scope and bounds

Findings reflect available application graph entity kinds. Relationships are exactly those returned by REA; a module import is not called a function call. Coverage, inference, unknowns, and original identifiers are retained. Each graph view displays at most 300 entities and 800 edges, labels the subset, and supports selecting a loaded entity's direct observed neighborhood. Exported graph JSON describes that view, including its coverage and rendering limits. Full graph facts remain in the original Evidence bundle.

One analysis can run at a time. Progress reports real phase observations and elapsed time without percentages. Cancellation requests use MCP; a stopped client request does not prove server resource cleanup. Unverified cancellation and interrupted application sessions remain explicitly interrupted. Failed jobs retain logs and any exported original Evidence.

The current indexing admission bound is 64 MiB per complete exported bundle; oversized exports remain on disk and produce an actionable error. Search pages contain up to 200 entities and are virtualized. Source reads and inspector responses are bounded at 2 MiB. The UI does not preload raw Evidence documents.

Semantic version comparison, other agent clients, graph image exports, whole-workspace cross-analysis search, native relationship graphs, and other format-specific workflows are not implemented. Native relationships remain provider-reported tables and original Evidence. Agent workspace connects an installed Codex client to the existing static REA workflows, with project conversations, streamed answers, cancellation, context review and original Evidence links. There is no target execution or provider mutation interface.

Native queries reuse one open REA session for the same project, target bytes and provider choice. Target/provider/connection changes, failures, deletion and normal closure retire the session. Sessions rotate after 128 successful queries or 32 MiB of cumulative exported Evidence; every task keeps its original export. Reuse is in-process; snapshots are not persisted. Caller/callee and reference addresses are clickable in Code & references. Native findings have local projection identities separate from original Evidence IDs, and each finding retains its own record metadata. SQLite schema 3 additionally stores agent conversations, turns and Evidence links. Schema 2 upgrades create a consistent studio-v2-backup-<UUID>.sqlite before the additive migration. Schema 2 added project workflow identity and shared record headers; upgrading a schema 1 workspace creates a consistent `studio-v1-backup-<UUID>.sqlite` before migration. Older Studio versions cannot open the upgraded workspace.

## Development and verification

```sh
npm run build
npm test
npm run test:e2e
npm run test:live
npm run test:live -- --asar --large
npm run test:live -- --asar --dense
npm run test:failures
npm run test:native:live -- --reuse
# Optional PE lane; requires an already installed MinGW compiler:
npm run test:native:live -- --reuse --pe
cargo test --manifest-path src-tauri/Cargo.toml
```

The live verifier uses self-authored source under `tests/fixtures/application`, invokes actual CLI/MCP interfaces, exports a genuine bundle, and checks its import relationships. Set `REA_STUDIO_REA_ENTRY` to your installed absolute REA script if the parent source checkout is not ready. Local verification outputs live under ignored `.local/`. Normalization tests based on exported data report skipped coverage until a successful live export exists; this is not a provider simulation.

`--asar` packages the owned fixture before analysis. `--large` generates 200 additional modules to exercise the graph's node bound; `--dense` generates 48 interdependent modules to exercise its edge bound. These targets are only parsed, never executed. Run the ignored Rust storage test against each resulting `projection.json` using `STUDIO_TEST_PROJECTION` and `-- --include-ignored`; it verifies source inspection, graph bounds and neighborhoods, search, and restart persistence. ASAR source inspection must report unsupported.

Browser tests use Playwright's Chromium by default; install it with `npx playwright install chromium`, or choose an installed channel such as `STUDIO_BROWSER_CHANNEL=chrome` or `STUDIO_BROWSER_CHANNEL=msedge`. The scripted desktop E2E lane currently requires Windows/WebView2. Normal Linux native dialogs were additionally checked in an isolated Xvfb/DBus/GTK portal workspace; see verification for scope.

The native live verifier compiles `tests/fixtures/native/demo.c` using an existing compiler, never executes the resulting target, and exercises seven static operations, including a repeated function query through the production bridge and actual CLI/MCP. Configure REA's existing provider environment first and set `REA_STUDIO_REA_ENTRY` as needed. `STUDIO_NATIVE_PROVIDER` defaults to `ghidra`. Use the resulting function `evidence.json` as `STUDIO_NATIVE_TEST_BUNDLE` for Vitest, and its `projection.json` as `STUDIO_NATIVE_TEST_PROJECTION` for the ignored Rust native-storage test. Set `STUDIO_NATIVE_TARGET` to the self-authored executable to include real native failures/cancellation in `npm run test:failures`.

Native end-to-end verification is opt-in: build with the Cargo `e2e` feature, then run `node scripts/native-e2e.mjs`. It uses an isolated local SQLite store, a self-authored sample selected through the real import command, actual analysis, and a WebView2 debug endpoint. The feature's file-dialog substitution and isolated-data override are absent from normal builds. Never distribute an `e2e` build. See [verification](docs/VERIFICATION.md) for actual results and limitations.

Read the [integration contract](docs/REA_INTEGRATION.md), [architecture](docs/ARCHITECTURE.md), [security](docs/SECURITY.md), [installation](docs/INSTALLATION.md), and [troubleshooting](docs/TROUBLESHOOTING.md). See [contributing](CONTRIBUTING.md).

## License and attribution

Studio is MIT licensed. Upstream REA is MIT licensed and retains its own authorship and third-party notices. REA and commercial analysis providers are not bundled into Studio. Dependency licenses remain applicable; target source and exported analysis material remain subject to your rights and authorization.

The ignored Rust session lifecycle test accepts STUDIO_SESSION_TARGET (a self-owned native fixture), STUDIO_SESSION_NODE and STUDIO_SESSION_REA (absolute existing trusted paths). Supply the real configured provider environment and both projection variables before running all ignored tests. It verifies default provider selection, reuse, failure recovery, target-byte invalidation and closure; it does not execute the fixture.

## Agent workspace

Choose an investigation and open **Agent workspace**. This area uses an open canvas with a central prompt; **History**, **Context** and **Codex settings** open on demand. Use the project name to switch investigations and the back arrow to return to the existing analysis views. Configure the trusted installed Codex executable and optional model in **Codex settings**, then check the connection. Authentication belongs to Codex; Studio does not collect API keys or edit global client configuration. Ask a question in your own language, optionally attach the selected finding or analysis metadata with **+**, and review the context before sending. The question, completed conversation history and selected facts go to the model provider configured in Codex. REA analysis remains local.

Responses render Markdown, fenced code and tables. Model-provided HTML, links and images remain inert; original Evidence opens through the host-owned result links. The loading indicator follows reported states and activity, without manufactured phases or percentages. **Stop** requests cancellation and preserves the distinction between a request and the final interrupted state. Enter sends and Shift+Enter inserts a new line. Animations respect reduced-motion preferences. The inspector and jobs-panel preferences reappear when you return to the other investigation views.

Codex can request Studio's existing JavaScript workflow or the seven static native tasks. Target, output storage and provider choices are bound by the host. Shell, target execution, image/computer/browser actions, other MCP registrations, plugins and skills are excluded from this scoped thread. Original bundles are indexed as normal REA jobs and accessible from each turn's Evidence links. Answers are stored separately as analyst inferences, never minted as REA Evidence.

Conversations survive app restarts. Each question uses an ephemeral Codex thread and explicitly replays completed conversation text; external thread resumption and cross-question native session reuse are not implemented in this lane. Native queries within one question reuse the existing native session. Context and tool replies are bounded at 128 KiB; oversized history requires a new conversation rather than silently dropping earlier messages. Replies are bounded at 1 MiB, paginated five turns at a time. Cancellation remains interrupted until the runtime reports a terminal state and transport closes. Claude Code and other clients are not wired yet.

`npm run test:agent:live` uses the installed Codex client and its configured model provider with a self-authored fixture. This can use model quota. `--connection-only` verifies transport/account readiness without inference; `--cancel` verifies actual turn interruption. Set STUDIO_CODEX_ENTRY or STUDIO_AGENT_MODEL for caller-selected values. STUDIO_AGENT_TEST_ROOT enables the ignored Rust storage test against a genuine saved run. See verification for observed costs and platform scope.
