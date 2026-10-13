# Installation and development

Use the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your host. Studio does not install them. The preferred Windows toolchain is Rust MSVC with Visual C++ Build Tools, a Windows SDK, and WebView2. The optional portable MinGW route used for local verification must supply compatible runtime/startup objects; see verification notes for what actually compiled.

Install Node 24.18.0, npm 11.16.0, Rust, and REA 6.4.x explicitly. `npm ci` in `rea-studio/` installs Studio's locked dependencies only. The upstream source checkout has its own lockfile and build commands. Keep these dependency directories separate. Windows REA source builds need the upstream shipped native artifact: the official package includes it, whereas the helper build lane currently requires Linux/MinGW. Never treat an absent helper as evidence that the artifact is unsupported.

`npm run desktop` builds bridge/frontend assets and launches the development desktop with a Vite server. `npm run tauri -- build --debug --no-bundle --features custom-protocol` embeds the frontend and selects distributed bridge resources. `npm run package` builds a release installer; signing is a separate release responsibility. On macOS/Linux change Tauri bundle targets to suit the host, and verify those real platforms before claiming support.

Connection settings accepts a trusted absolute Node executable and `scripts/rea.mjs` from a trusted REA installation. It preserves prior configuration in SQLite and verifies the exact installation with actual CLI and MCP calls. Dependencies and providers are never automatically installed by the application. Both CLI and MCP must agree on version and expose the needed contracts and availability. Browser previews cannot run native operations.

The app stores projects and original Evidence beneath Tauri's per-user application-data directory for `tools.rea.studio`. Source targets are referenced in place. Preserve the entire data directory when moving a workspace; original target paths may need restoring for source inspection. There is no mandatory login or telemetry.

Native workflows require an already configured REA provider. Use REA's existing provider setup and environment; Studio preserves inherited configuration and offers an explicit provider selector. Connection settings show actual availability. This change installs or upgrades no provider, Java, or other toolchain. Schema 1 workspaces are migrated to schema 2 with a unique consistent SQLite backup; preserve that backup when rolling back to an older Studio binary.
