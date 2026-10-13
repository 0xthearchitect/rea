# REA Studio

An independent, open-source graphical frontend for [REA — Reverse Engineer Anything](https://github.com/morluto/rea). REA is the analysis engine; Studio is the local investigation workspace. This project does not imply endorsement by REA's maintainers.

Studio 0.1 focuses on one static workflow: import a JavaScript application directory or Electron ASAR, analyze it with your actual REA installation, explore application entities and relationships, inspect original Evidence, and reopen the investigation from SQLite. No account, telemetry, subscription, cloud service, or AI provider is required.

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
2. Choose **New investigation**, name it, and select a directory or ASAR through the native dialog.
3. Choose **Run analysis**. Optionally supply exact artifact-relative source paths, one per line.
4. Search and filter the findings, or open **Application graph**. Select a node or an edge to inspect its original provenance.
5. Open **Evidence** to inspect the record header and selected facts, or export the complete original bundle to a new file.
6. Restart Studio; projects and analysis history reopen from the local store.

Source inspection is read-only and restricted to directory files whose SHA-256 still matches REA's recorded artifact digest. A changed source requires a new analysis. Decompiled pseudocode is not implemented. Source extraction from ASAR is not exposed.

`Ctrl/Cmd K` focuses investigation search. `Ctrl/Cmd O` creates an investigation. Arrow keys navigate findings. Drag panel separators or use their arrow keys to resize; theme, panel layout, active views, and graph viewport preferences persist locally.

## Current scope and bounds

Findings reflect available application graph entity kinds. Relationships are exactly those returned by REA; a module import is not called a function call. Coverage, inference, unknowns, and original identifiers are retained. Each graph view displays at most 300 entities and 800 edges, labels the subset, and supports selecting a loaded entity's direct observed neighborhood. Exported graph JSON describes that view, including its coverage and rendering limits. Full graph facts remain in the original Evidence bundle.

One analysis can run at a time. Progress reports real phase observations and elapsed time without percentages. Cancellation requests use MCP; a stopped client request does not prove server resource cleanup. Unverified cancellation and interrupted application sessions remain explicitly interrupted. Failed jobs retain logs and any exported original Evidence.

The current indexing admission bound is 64 MiB per complete exported bundle; oversized exports remain on disk and produce an actionable error. Search pages contain up to 200 entities and are virtualized. Source reads and inspector responses are bounded at 2 MiB. The UI does not preload raw Evidence documents.

Native provider/decompiler workflows, semantic version comparison, AI-agent conversation/execution, graph image exports, whole-workspace cross-analysis search, and arbitrary artifact formats are not implemented. The agent page states that explicitly. There is no target execution or provider mutation interface.

## Development and verification

```sh
npm run build
npm test
npm run test:e2e
node scripts/verify-live.mjs
cargo test --manifest-path src-tauri/Cargo.toml
```

The live verifier uses self-authored source under `tests/fixtures/application`, invokes actual CLI/MCP interfaces, exports a genuine bundle, and checks its import relationships. Set `REA_STUDIO_REA_ENTRY` to your installed absolute REA script if the parent source checkout is not ready. Local verification outputs live under ignored `.local/`. Normalization tests based on exported data report skipped coverage until a successful live export exists; this is not a provider simulation.

Native end-to-end verification is opt-in: build with the Cargo `e2e` feature, then run `node scripts/native-e2e.mjs`. It uses an isolated local SQLite store, a self-authored sample selected through the real import command, actual analysis, and a WebView2 debug endpoint. The feature's file-dialog substitution and isolated-data override are absent from normal builds. Never distribute an `e2e` build. See [verification](docs/VERIFICATION.md) for actual results and limitations.

Read the [integration contract](docs/REA_INTEGRATION.md), [architecture](docs/ARCHITECTURE.md), [security](docs/SECURITY.md), [installation](docs/INSTALLATION.md), and [troubleshooting](docs/TROUBLESHOOTING.md). See [contributing](CONTRIBUTING.md).

## License and attribution

Studio is MIT licensed. Upstream REA is MIT licensed and retains its own authorship and third-party notices. REA and commercial analysis providers are not bundled into Studio. Dependency licenses remain applicable; target source and exported analysis material remain subject to your rights and authorization.
