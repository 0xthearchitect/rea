# REA integration contract

REA Studio is an independent frontend, without upstream endorsement. Research baseline: local upstream checkout `morluto/rea`, REA **6.4.0**, commit `11f8b7625788d747eaadd59af6efdf88587ed058`. Read alongside upstream `docs/cli.md`, `docs/mcp-contracts.md`, `docs/javascript-artifact-reconstruction.md`, and contracts in `src/contracts/`. No engine source changes are needed.

## Public boundary

Supported Studio workflow: static JavaScript/Electron application analysis of a caller-selected directory or ASAR. Opening a target never executes it. Required: Node 24.18.0 (repository pin), a built or installed REA 6.4.x, and platform desktop prerequisites. The Rust host invokes an absolute Node executable with REA's public `scripts/rea.mjs` entrypoint using discrete arguments. No shell, npx, automatic installation, native provider, or runtime workflow is exposed.

CLI discovery executes `--version` and `capabilities --json`; these return live installation identity and provider status, not a static success flag. Actual upstream commands include `analyze-javascript-application PATH --json`, `analyze PATH --provider ID --json`, `search`, `function`, `decompile`, `instructions`, `xrefs`, `trace`, `providers --json`, `doctor --json`, `inspect-managed-artifact`, `inspect-managed-members`, `inspect-sqlite-database`, `inspect-go-binary`, `inspect-artifact`, `evidence-import`, `evidence-export`, and `compare`. Most are not exposed for execution in this MVP. Source selection uses repeated `--source-path`; integrity uses `--integrity-policy fail|record-and-continue`. CLI application output is always complete and progress JSON lines go to stderr.

## MCP adapter

The official SDK connects to `node /absolute/path/to/rea/scripts/rea.mjs mcp` via stdio. Initialization and paginated `tools/list` must succeed before reporting MCP connectivity. Named contracts are selected by tool name, never catalog order. Preserve live input/output schemas locally. The adapter only calls:

- `binary_session {}` for actual provider and availability status.
- `analyze_javascript_application {input_path, format:"auto", integrity_policy:"fail", detail:"summary"}`. Optional exact `source_paths` are retained. Summary delivery requires session retention.
- `export_evidence_bundle {path, overwrite:false}` to persist complete original records before disconnecting.

Capability admission requires those tools, compatible input properties, matching CLI/MCP versions, and explicit available status in `binary_session`'s lifecycle `structuredContent.result`. The published 6.4.0 package advertises 170 tools and individual `tool_availability` entries; the researched checkout advertises 191 tools and a compact `tool_availability.groups` inventory. The adapter parses both observed shapes at its owning boundary; it does not infer availability from catalog presence. REA 6.4.x is the admitted version range, with these additional live checks; unknown versions fail closed. The graph contract is `JavaScriptApplicationGraph`, with `node_id`, `kind`, `identity`, `observations`; directed edges use `edge_id`, `source_node_id`, `target_node_id`, `relation`, and `evidence`. Do not reinterpret a dependency edge as a function call.

## Evidence and lifecycle

MCP successful Evidence lives in `structuredContent`, with the same JSON in text content. Keep `evidence_id`, `subject`, `provider`, `analysis_profile` (including explicit null), `operation`, `parameters`, `raw_result`, `normalized_result`, confidence, authority, locations, links, and limitations. The application summary's `normalized_result.parent_evidence_id` identifies the retained full analysis. References are connection-local until bundle export. Bundles contain `records` and original manifests. Export while the owning connection remains open, then close the client and transport. SQLite stores projections and metadata; filesystem bundles remain the source of truth. Studio project/job UUIDs are local identifiers, never Evidence IDs.

The original graph evidence on each observation/edge preserves fact state, authority, confidence, available/unavailable artifact and location, extractor version, coverage, and limitations. An unknown or partial graph is never called exhaustive. Local rendering bounds are separate from upstream coverage.

## Failure, progress, and cancellation

Tool errors use `isError:true` and canonical JSON diagnostics in text; successful output schemas do not describe errors. Preserve diagnostic reasons, including invalid_request, unsupported_host, capability_unavailable, resource_constraint, timeout, cancelled, integrity failures, and cleanup_incomplete. Nonzero CLI status is failure even if stdout contains JSON. MCP progress is a sequence of observations, without a meaningful total. Display phase messages and elapsed time only.

MCP cancellation sends the request signal and remains pending until server response/cleanup is observed. Export may fail or cancellation may occur before any facts exist; do not manufacture a partial result. SDK shutdown can force its owned server process after its documented grace period; this does not establish cleanup of provider resources. Studio does not expose runtime providers. Interrupted Studio jobs are marked interrupted on restart rather than silently successful.

## Platform and bounds

Tauri targets Windows, macOS, and Linux; only the host actually tested is verified. Ghidra/IDA/Hopper are bring-your-own, and are not required for this workflow. Windows historical-source import is unsupported upstream. Static graph analysis has its own source/memory deadlines and limitations. Native Windows upstream behavior must be verified with a real permitted sample. The official SDK has a 10 MiB receive-buffer budget; summary + export avoids full MCP result expansion. Studio admits exported bundles up to 64 MiB, bounds graph rendering and pages lists. Larger bundles are explicitly rejected and retained on disk; no truncation is labeled complete. Agent integration, native decompilation, runtime execution, graph relationship queries beyond loaded data, and semantic comparison are not implemented.

## Licensing

Upstream REA is MIT; third-party code and tools retain their own licenses (`LICENSE`, `THIRD_PARTY_NOTICES.md`). Studio does not redistribute REA or commercial decompilers. See Studio's lockfiles for its dependencies. Exported target material remains subject to the user's rights and authorization.
