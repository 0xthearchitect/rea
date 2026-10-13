# Contributing

Use Node from `.nvmrc` and npm from `package.json#packageManager`. Keep Studio separate from the engine: integrate documented CLI/MCP contracts by name, inspect live schemas and availability, and retain complete original Evidence. Do not add target execution, injection, mutation, or protection-recovery workflows without resolving the upstream repository's maintainer scope requirements.

Run TypeScript/build, meaningful boundary tests, the browser suite, and Rust checks for affected changes. Real-provider claims require actual CLI/MCP verification with owned or permitted artifacts; simulated replies are not provider evidence. The `e2e` Cargo feature is only for automated verification and must never be packaged for users.

Keep fixtures small and self-authored, or document their source/license. Test exports and production bundles live in ignored directories. Do not commit target binaries, raw user investigations, credentials, dependency directories, executables, or installers. Preserve malformed-response, path traversal, cancellation/cleanup uncertainty, capacity, and persistence coverage.

Use Conventional Commit subjects. Describe behavior, validation, supported REA versions/contracts, platform scope, and remaining unknowns. Assess the producing integration boundary before repairing downstream consumers. Add migrations with backups; never silently rewrite a newer SQLite schema.
