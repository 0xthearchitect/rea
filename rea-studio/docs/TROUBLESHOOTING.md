# Troubleshooting

**Native operations require the desktop app:** `npm run dev` is a frontend browser preview. Run the Tauri desktop build for file dialogs, persistence, and real REA calls.

**Missing dependency:** choose absolute trusted Node and REA script paths. REA must be installed/built, not just cloned. On Windows use a published package with its shipped `native/windows/build` artifacts. Use upstream `rea doctor --json` and `rea mcp doctor --json` for actual diagnostics. Studio does not install providers or tools.

**Incompatible:** this release admits REA 6.4.x and validates named contracts plus live session availability. Catalogs can differ even at the same package version; retain the reported live schemas. CLI/MCP identity mismatch or missing required fields disables execution rather than guessing.

**Timeout during first discovery:** Windows can take longer on a cold installation. CLI discovery and MCP initialization have explicit deadlines and report errors; retry after resolving load/dependency issues. No success is cached as current without a new check on execution.

**Analysis failed:** read Jobs & activity for the actual diagnostic. No placeholder findings are created. An existing successful analysis remains available and labeled by its REA version. Source selection uses exact relative paths and does not expand imports automatically.

**Native provider unavailable/ambiguous:** inspect the provider status in Connection settings and use REA's existing configuration guide. Select a concrete available provider when automatic selection is ambiguous. Studio does not install providers, silently replace the selected provider, or treat target-free availability as proof of support for a particular file. Native tasks currently repeat provider startup/analysis between sessions.

**Native source unavailable:** use **Code & references** for the returned pseudocode/instructions. Pseudocode is decompiler-generated and is not the original source file. Native caller/callee and reference tables retain REA's coverage and limitations; empty tables do not establish absent runtime relationships.

**Source changed/unavailable:** source inspection requires an available artifact/location digest and a directory target. Reanalyze changed source. ASAR and unavailable source locations remain explicitly unavailable in this viewer; export the complete Evidence for other supported REA inspections.

**Resource constraint:** oversized complete bundles remain on disk. Narrow the upstream source selection and run another analysis. Graph render limits are local view bounds; view the selected node's neighborhood, filter types, or export complete Evidence. Inspector payloads larger than 2 MiB require complete-bundle export.

**Interrupted/cancellation requested:** the client request stopped or Studio exited without a terminal record. This does not prove upstream cleanup. Review the actual REA diagnostic and any retained files before starting a new operation. Normal window close is blocked during active jobs.

**Export refuses an existing path:** choose a new filename. The application never silently overwrites user exports.

**Older Studio cannot open this workspace:** native workflows use schema 2. Migration from schema 1 creates `studio-v1-backup-<UUID>.sqlite`. Keep the upgraded workspace and restore the backup into a separate data directory when using an older binary; never replace a database while Studio is running.

**Native build cannot find link.exe:** load your Visual C++ developer environment and install the Tauri prerequisites explicitly. VS Code does not provide a C++ compiler. A cancelled UAC prompt leaves the compiler uninstalled.

**Native queries repeat startup:** reuse requires the same project, selected path, SHA-256 and exact provider choice. Changing REA default to an explicit provider intentionally opens a new session. Navigation preserves the original choice in newly indexed results. A restart, failed/cancelled task or retention-bound rotation also starts a new session. Historical projections without that choice use the current task selection.

**Cleanup unknown:** Studio retains the failed session owner and refuses replacement when native closure or process exit cannot be confirmed. Preserve the activity log; an app restart recovers unfinished job metadata but does not establish upstream cleanup.

**File dialog missing in a virtual display:** the desktop portal must inherit the isolated DISPLAY and GDK_BACKEND=x11. Use a separate dbus-run-session and a GTK portals.conf under the test XDG_CONFIG_HOME; inherited Wayland variables can otherwise send the portal to another display. This is test-environment setup, not a change to your desktop configuration.
