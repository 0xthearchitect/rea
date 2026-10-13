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

Read [verification status](VERIFICATION.md) first. The latest fix compiled but the complete native E2E acceptance gate is not yet complete. The existing UI and analyses must not be presented as a finished production release until that journey is verified.

```sh
# Set REA_STUDIO_REA_ENTRY to the installed absolute scripts/rea.mjs.
npm run test:live
npm test
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
```

The live verifier creates `.local/verification-<timestamp>/projection.json`. Set `STUDIO_TEST_PROJECTION` to its absolute path, then run `cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored` to exercise the real-Evidence storage test.

For desktop UI automation on Windows:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --features e2e
npm run test:native
```

The `e2e` feature provides an isolated store and the self-authored target through the normal import command. Never distribute that build. Do not run browser/native suites simultaneously: they share Vite port 1420. The native runner verifies create/import, actual REA analysis, search, original Evidence, graph rendering, and restart persistence through WebView2.

For a normal standalone executable with embedded assets, use `npm run tauri -- build --debug --no-bundle --features custom-protocol`. `npm run package` builds the release installer. Normal builds omit test-data overrides. Native decompilation, agent execution, semantic comparisons, and whole-workspace search are not implemented.
