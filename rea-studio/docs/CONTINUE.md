# Continue development on another machine

The checkpoint is on `feat/rea-studio` in the independent fork. The upstream engine remains unchanged; Studio is a standalone package in `rea-studio/`.

```sh
git clone --branch feat/rea-studio https://github.com/0xthearchitect/rea.git
cd rea/rea-studio
npm ci
npm run build
npm run desktop
```

Use Node 24.18.0/npm 11.16.0 and Rust ≥1.89, with the appropriate [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your machine. The preferred Windows route is Visual C++ Build Tools, a Windows SDK, and WebView2. This workstation used a portable GCC/MinGW compiler and GNU Rust after the Microsoft installer could not pass UAC.

The toolchains, installed REA runtime, generated icons/bridge/frontend assets, binaries, SQLite stores, and raw analysis outputs live in ignored `.cache/`, `.local/`, dependency, and build directories. They are not in the fork. Recreate them from the documented commands; do not copy private investigations into Git.

Install a trusted REA 6.4.x separately, then choose its `scripts/rea.mjs` and your Node executable in Connection settings. On Windows the official published package includes the native filesystem helper; building that helper from source uses upstream's Linux/MinGW lane. The researched source checkout and official package advertise different contracts even at version 6.4.0; Studio checks the actual schemas and availability.

Read [verification status](VERIFICATION.md) first. The complete Windows native vertical slice passed, including real analysis, Evidence, graph rendering, and restart persistence. Linux now has real directory/ASAR analysis, source inspection, graph bounds, storage verification, and a normal desktop build smoke check. Normal Linux native import/save/delete dialogs, linked function/reference navigation, retained-session reuse and restart were subsequently verified in an isolated workspace. Windows/macOS dialogs, end-to-end ASAR UI import, release installers/signing and the Windows linker warning remain pending.

```sh
# Set REA_STUDIO_REA_ENTRY to the installed absolute scripts/rea.mjs.
npm run test:live
npm run test:live -- --asar --large
npm run test:live -- --asar --dense
npm run test:failures
npm run test:native:live
npm run test:native:live -- --pe
npm test
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
```

The live verifier creates `.local/verification-<timestamp>/projection.json`. Set `STUDIO_TEST_PROJECTION` to its absolute path, then run `cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored` to exercise the real-Evidence storage test.

Repeat that storage check for the directory, large ASAR, and dense ASAR exports. The tests inspect exact retained facts, verify directory source bytes and unsupported ASAR source access, exercise both graph limits and focused neighborhoods, and reopen SQLite. The test suite also works before `.local/` exists, reporting the two real-export normalization tests as skipped. Browser verification defaults to Chromium; select an installed browser with `STUDIO_BROWSER_CHANNEL=chrome` or `STUDIO_BROWSER_CHANNEL=msedge`.

Native workflows now use the existing REA contracts for overview/sections, function search, strings, dossiers/pseudocode, instructions, and references. No engine code changed. Configure the existing REA provider environment before running the native live lane; Ghidra/Java remain bring-your-own. The ELF verifier needs an existing `cc`; `--pe` needs an existing `x86_64-w64-mingw32-gcc`. Neither target is executed. Use the native function export as `STUDIO_NATIVE_TEST_BUNDLE` for Vitest and its projection as `STUDIO_NATIVE_TEST_PROJECTION` for Rust. Set both Rust projection variables before `-- --include-ignored` to cover JavaScript and native storage together. `STUDIO_NATIVE_TARGET` enables native failure/cancellation verification in `test:failures`.

Schema 2 stores workflow identity and shared record headers. Schema 1 migration makes a unique consistent backup first. The reuse/link/validation slice is complete on Linux with real REA/Ghidra: in-process sessions, exact address links, failure recovery, target-digest invalidation and real import/save/delete dialogs. Remaining work includes Mach-O/other providers/platforms, Windows/macOS dialogs, persisted snapshots across restarts, native relationship graphs and release packaging checks.

For desktop UI automation on Windows:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --features e2e
npm run test:native
```

The `e2e` feature provides an isolated store and the self-authored target through the normal import command. Never distribute that build. Do not run browser/native suites simultaneously: they share Vite port 1420. The native runner verifies create/import, actual REA analysis, search, original Evidence, graph rendering, and restart persistence through WebView2.

For a normal standalone executable with embedded assets, use `npm run tauri -- build --debug --no-bundle --features custom-protocol`. `npm run package` builds the release installer. Normal builds omit test-data overrides. The initial Codex agent lane now supports scoped static investigation, project conversations, context review, cancellation and original Evidence links. Other clients, external thread resumption, semantic comparisons, whole-workspace search and other format workflows remain pending.
