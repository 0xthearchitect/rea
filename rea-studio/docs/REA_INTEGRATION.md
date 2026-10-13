# REA integration contract

REA Studio is an independent frontend, without upstream endorsement. Research baseline: local upstream checkout `morluto/rea`, REA **6.4.0**, commit `11f8b7625788d747eaadd59af6efdf88587ed058`. Read alongside upstream `docs/cli.md`, `docs/mcp-contracts.md`, `docs/javascript-artifact-reconstruction.md`, and contracts in `src/contracts/`. No engine source changes are needed.

## Public boundary

Supported Studio workflows: static JavaScript/Electron analysis of a caller-selected directory or ASAR, and static inspection of caller-selected native files using existing REA providers. Opening a target never executes it. Required: Node 24.18.0, a built or installed REA 6.4.x, and platform desktop prerequisites. Native analysis also needs an applicable configured REA provider. The Rust host invokes an absolute Node executable with REA's public `scripts/rea.mjs` entrypoint using discrete arguments. No shell, npx, automatic installation, arbitrary MCP execution, provider mutation, or target runtime workflow is exposed.

CLI discovery executes `--version` and `capabilities --json`; these return live installation identity and provider status, not a static success flag. Actual upstream commands include `analyze-javascript-application PATH --json`, `analyze PATH --provider ID --json`, `search`, `function`, `decompile`, `instructions`, `xrefs`, `trace`, `providers --json`, `doctor --json`, `inspect-managed-artifact`, `inspect-managed-members`, `inspect-sqlite-database`, `inspect-go-binary`, `inspect-artifact`, `evidence-import`, `evidence-export`, and `compare`. Most are not exposed for execution in this MVP. Source selection uses repeated `--source-path`; integrity uses `--integrity-policy fail|record-and-continue`. CLI application output is always complete and progress JSON lines go to stderr.

## MCP adapter

The official SDK connects to `node /absolute/path/to/rea/scripts/rea.mjs mcp` via stdio. Initialization and paginated `tools/list` must succeed before reporting MCP connectivity. Named contracts are selected by tool name, never catalog order. Preserve live input/output schemas locally. The application adapter calls:

- `binary_session {}` for actual provider and availability status.
- `analyze_javascript_application {input_path, format:"auto", integrity_policy:"fail", detail:"summary"}`. Optional exact `source_paths` are retained. Summary delivery requires session retention.
- `export_evidence_bundle {path, overwrite:false}` to persist complete original records before disconnecting.

Native tasks additionally use `open_binary {path, provider_id?}`, `binary_session {}`, one of `binary_overview {}`, `search_procedures {pattern, mode:"literal", case_sensitive:false}`, `list_strings {}`, `analyze_function {procedure}`, `read_function_instructions {procedure}`, `xrefs {address}`, or `inspect_native_instruction {address}`, followed by complete export. The app retains the same REA session across valid queries and uses `close_binary {}` when retiring it. Successful close requires the contract’s `{result:null}` receipt; malformed replies do not release ownership. Provider omission preserves REA's existing preference; explicit `auto` stays explicit. Exact provider addresses are never recovered from display labels or reformatted before lookup. Navigation carries the original provider selection, including omission and explicit auto; the record’s resolved provider is display provenance, not a replacement caller choice. Admission checks the actual named input contracts and target-specific availability after opening. Provider candidates are parsed independently: malformed availability remains unknown without hiding valid peers. Catalog presence alone does not prove availability.

Capability admission requires those tools, compatible input properties, matching CLI/MCP versions, and explicit available status in `binary_session`'s lifecycle `structuredContent.result`. The published 6.4.0 package advertises 170 tools and individual `tool_availability` entries; the researched checkout advertises 191 tools and a compact `tool_availability.groups` inventory. The adapter parses both observed shapes at its owning boundary; it does not infer availability from catalog presence. REA 6.4.x is the admitted version range, with these additional live checks; unknown versions fail closed. The graph contract is `JavaScriptApplicationGraph`, with `node_id`, `kind`, `identity`, `observations`; directed edges use `edge_id`, `source_node_id`, `target_node_id`, `relation`, and `evidence`. Do not reinterpret a dependency edge as a function call.

## Evidence and lifecycle

MCP successful Evidence lives in `structuredContent`, with the same JSON in text content. Keep `evidence_id`, `subject`, `provider`, `analysis_profile` (including explicit null), `operation`, `parameters`, `raw_result`, `normalized_result`, confidence, authority, locations, links, and limitations. The application summary's `normalized_result.parent_evidence_id` identifies the retained full analysis. References are connection-local until bundle export. Bundles contain `records` and original manifests. Export while the owning connection remains open, then close the client and transport. SQLite stores projections and metadata; filesystem bundles remain the source of truth. Studio project/job UUIDs are local identifiers, never Evidence IDs.

The original graph evidence on each observation/edge preserves fact state, authority, confidence, available/unavailable artifact and location, extractor version, coverage, and limitations. An unknown or partial graph is never called exhaustive. Local rendering bounds are separate from upstream coverage.

## Failure, progress, and cancellation

Tool errors use `isError:true` and canonical JSON diagnostics in text; successful output schemas do not describe errors. Preserve diagnostic reasons, including invalid_request, unsupported_host, capability_unavailable, resource_constraint, timeout, cancelled, integrity failures, and cleanup_incomplete. Nonzero CLI status is failure even if stdout contains JSON. MCP progress is a sequence of observations, without a meaningful total. Display phase messages and elapsed time only.

MCP cancellation sends the request signal and remains pending until server response/cleanup is observed. Export may fail or cancellation may occur before any facts exist; do not manufacture a partial result. SDK shutdown can force its owned server process after its documented grace period; this does not establish cleanup of provider resources. Native close is attempted even after failed/cancelled opens; failed cleanup retains the original failure and the cleanup reason. Studio does not expose runtime providers. Interrupted Studio jobs are marked interrupted on restart rather than silently successful.

## Platform and bounds

Tauri targets Windows, macOS, and Linux; only the tested host/provider lanes are verified. Ghidra/IDA/Hopper are bring-your-own and are not needed for JavaScript analysis. Native verification currently covers Ghidra 12.1.2 on Linux with self-authored ELF and PE files; Mach-O, Hopper, IDA, and native desktop operation on Windows/macOS remain unverified. The official SDK has a 10 MiB receive-buffer budget. JavaScript summary + export avoids full graph expansion; native results use the existing full-response contracts and can reach that SDK bound. Studio admits complete exports up to 64 MiB and retains rejected oversized bundles. Inspector responses are bounded at 2 MiB, lists at 200 findings per page. Original Evidence remains accessible by export. Target execution, native relationship graphs and semantic comparison are not implemented. The Codex agent lane below reuses the listed static adapters.

## Licensing

Upstream REA is MIT; third-party code and tools retain their own licenses (`LICENSE`, `THIRD_PARTY_NOTICES.md`). Studio does not redistribute REA or commercial decompilers. See Studio's lockfiles for its dependencies. Exported target material remains subject to the user's rights and authorization.

The bridge newline protocol accepts one active request at a time. Native host requests explicitly keep it alive; `shutdown` closes the REA session and SDK transport before acknowledging and exiting. One-shot discovery/JavaScript workflows still exit after completion. No new REA operation or engine implementation was introduced.

## Codex agent adapter

bridge/agent.ts owns the installed Codex app-server stdio protocol. It initializes the client, reads account/configuration/skill facts through their owning RPCs, starts an ephemeral read-only thread with scoped dynamic tools, streams agent messages, handles turn/interrupt, and admits completion only from the owning turn/completed event. Unknown server requests are refused. Generated protocol bindings from the actual installed 0.162.1 binary were inspected; no generated binaries/bindings are committed. The app-server protocol and dynamic tools are experimental and other versions remain unverified. The official protocol reference is https://learn.chatgpt.com/docs/app-server.

rea_analyze invokes the same analyzeJavascript/analyzeNative adapters as deterministic UI jobs. rea_read_result pages retained projections from that question. Model arguments cannot select target, output path or provider. Native results export complete original Evidence before indexing; the host copies them into UUID-owned jobs before linking them to the turn. Temporary duplicates are removed after transport closure; failed cleanup retains the owning turn/path and reports activity. Source targets are never executable commands.

The installed client owns authentication and its model provider. No authentication responses or ambient environment map enter the Studio transcript. Global client configuration is read through its owner and unchanged; thread overrides disable other MCP registrations/plugins/skills and unrelated execution/browser/image/computer capabilities. A connection/account check does not establish model entitlement. Actual model/provider names and total turn token usage are observed from the runtime, with unavailable metrics left unknown.
