# Security model

Imported targets and REA output are untrusted data. Studio exposes only deterministic static JavaScript application analysis; import never executes target code. REA static analysis and the desktop app run with the user's OS permissions, not a security sandbox. Do not assume static inspection makes an artifact safe to execute.

Native dialogs select target and dependency paths. The frontend has no filesystem or shell plugin permissions. The host invokes an absolute trusted Node binary with argument arrays; no shell strings or arbitrary REA tool names are accepted. No local HTTP API is exposed. The production CSP restricts scripts, worker, font, image, and IPC sources to local resources. External HTML is never rendered; output appears as escaped text or in a read-only editor. Commercial engines are not bundled.

Source navigation accepts exact relative paths without traversal, resolves them inside the selected directory, bounds bytes before allocation, and checks the read content against REA's recorded SHA-256 before returning text. Source files changed after analysis are rejected. ASAR extraction is delegated to REA and is not exposed through Studio. JSON indexing has explicit file/message/row/view bounds.

The original Evidence bundle retains caller-selected paths, digests, parameters, IDs, and outputs without inferring secrecy from names. Studio does not serialize the ambient environment. Authentication credentials should be redacted by their owning transport; this MVP has no authenticated remote transport. Exported target data can still be sensitive and should be handled under the user's own access policy.

Project deletion requires a native confirmation, validates Studio-owned UUID directories against the application store, and preserves target files. Exports require a new caller-selected path and refuse to overwrite existing files. Failed cleanup remains reported. Cancellation does not establish provider cleanup merely because the client promise ended. Windows ACLs follow the per-user app-data directory; Unix data-root permissions are narrowed to the owner.

The `e2e` build feature enables an isolated test-data override and fixed self-owned file-dialog selection. Only verification builds enable it; production builds ignore those environment overrides. Debug WebView endpoints are used only by the native E2E runner, never normal application launch.
