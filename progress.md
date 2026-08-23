# Progress

## 2026-08-21/22

- Cloned `stdevMac/grok-in-codex` into `E:\APP\CodexProject\grok-codex-worker`.
- Baseline: 113 tests, 110 passed, 3 Windows/path failures.
- Renamed `plugins/grok` to `plugins/grok-codex-worker`; updated manifest, MCP server, tests, and local marketplace.
- Fixed Windows binary lookup with `where.exe`, `grok.exe`, `grok.cmd`, and `%USERPROFILE%\.grok\bin` candidates.
- Fixed `.cmd` process execution without `shell=true` by invoking `ComSpec` with quoted arguments.
- Added `scripts/lib/contracts.mjs` for workspace-safe expected files, artifact verification, and check commands.
- `grok_plan` and `grok_document` now fail with `failed_artifact` when successful Grok narration has no real non-empty artifact.
- `grok_rescue`, `grok_plan`, and `grok_document` support `expectedFiles` and `checkCommand`; results persist and render contract evidence.
- Added contract and platform regression tests. Final suite: 119/119 passing, including result rendering evidence.
- Plugin validation passed.
- Registered local marketplace from repository root and installed `grok-codex-worker@grok-codex-worker` at cache version `0.1.0+codex.20260821183337`.
- Installed fork `grok_setup --json` passed: Grok 1.0.5, authenticated, doctor OK.
- Mock end-to-end `plan --json` correctly returned `failed_artifact` when Grok produced no plan file.

## Errors resolved

- PowerShell command execution required elevated ACL access for `E:\APP`.
- Codex marketplace must be added from the repository root, not `.agents\plugins` directly.
- Phase 2 scope enforcement completed: added strict allowlist/forbidden-path validation, `failed_scope` / `failed_scope_rolled_back` statuses, result diagnostics, MCP/CLI mappings, and end-to-end rollback coverage. Full suite: 126/126 passing.

## 2026-08-22 Phase 3

- Completed isolated acceptance items 1-5.
- Added fail-closed snapshot contract validation.
- Added Windows quoted check-command preservation and cleanup.
- Added combined scope/check status reporting and rollback residual verification.
- Added `tests/stage3-contract.test.mjs` and `tests/stage3-scope-check.test.mjs`.
- Verification: `npm.cmd test` passed 130/130; `validate_plugin.py` passed.
- Cachebuster updated to `0.1.0+codex.20260822033510`.

- Implemented hash-backed actual-change evidence in snapshot, contracts, companion finalization, and rendering modules.

- Added successful-write and no-op rollback end-to-end tests; final plugin suite: 135/135 passed.
- Plugin validation passed; cachebuster updated to 0.1.0+codex.20260822090452 and local marketplace reinstall completed.

## 2026-08-22 Phase 5

- Added pre-persistence redaction for streamed tool events in background job logs.
- Tool logs now retain only tool name, file paths, and execution status; content/output/result payloads are discarded.
- Added unit and executable-wrapper regression tests with `SECRET_FILE_BODY`; full suite passed 139/139.
- Plugin validation passed and cache version 0.1.0+codex.20260822142304 was installed.
- Real Grok 4.6 strict write acceptance completed as job `task-mt4hljyx-dw2ox2`.
- Snapshot evidence recorded exactly one modified file with distinct before/after SHA-256 hashes.
- Full target-project suite passed 283/283; contract verified, scope passed, and no rollback was needed.
- Audited real read-file logs: paths and statuses were retained, while every tool event used only the three approved fields.

## 2026-08-22 Phase 6

- Started stability hardening: state locking, snapshot exclusion evidence, prompt cleanup, and diagnostic log minimization.
- Added cross-process state locking and atomic state replacement, including locking for direct `saveState` callers.
- Added fail-closed `noSnapshot` validation for write-capable jobs and unverified snapshot change reporting.
- Added prompt lifecycle cleanup and stderr stream-log redaction in the detached worker.
- Added concurrency, snapshot, contract, and stderr/prompt cleanup regression tests.
- Final Phase 6 verification: `npm.cmd test` passed `142/142`; plugin validation passed; cache refreshed and reinstalled as `0.1.0+codex.20260822160938` with matching SHA-256 runtime files.
- Direct setup against the new cache returned `ready=true`, Grok 1.0.5, authenticated, and pluginRoot at the new cache path. The already-running Codex task still held the previous MCP process, so it must be restarted before MCP smoke calls use the new cache.

## 2026-08-23 Phase 7A

- Started permission and capability isolation across MCP invocation, companion policy, Grok process launch, and completion evidence.
- Confirmed current child launch paths inherit all host environment variables and write mode can run without an explicit sandbox.
- Baseline `npm.cmd test` could not start test workers in the current managed sandbox: all 25 test files failed at the Node test runner boundary with `spawn EPERM`; no test assertion ran.
- Replaced invalid `command:*` denials with documented Grok rules and removed the final low-level `--yolo` path.
- Forced strict/dontAsk or strict/plan profiles, workspace-specific write allows, MCP/shell/web denies, subagent/memory/workflow shutdown, and foreign compatibility discovery shutdown.
- Added explicit environment allowlisting, credential-path read denies, command guards, and Grok configuration preflight for hooks/MCP/LSP/plugins/permission grants.
- Added worker policy v2 evidence and made it a required input to `contract.verified`.
- Fixed Grok 1.0.5 session initialization by retaining the built-in tool graph and enforcing capability denies at permission evaluation time.
- Full suite passed `150/150`; source plugin validation passed.
- Real Grok 4.6 read-only acceptance passed as `task-mt4o9fje-cqyyhx` with exact response `PHASE7_GROK46_POLICY_OK` and `verified=true`.
- Real Grok 4.6 write acceptance passed as `task-mt4od1ce-1d66vq`: one added file, expected SHA-256, check exit 0, scope/policy/actual-change all passed, `verified=true`.
- Two deliberately failing write checks returned `failed_check_rolled_back` and left no residual files, confirming the failure path during live acceptance.
- Final Phase 7A gate: `npm.cmd test` passed `151/151`; `git diff --check` and source plugin validation passed.
- Refreshed and installed cache `0.1.0+codex.20260822175452`; six security-critical source/cache files have matching SHA-256 hashes.
- Direct setup from the installed cache returned `ready=true`, authenticated, with Grok `1.0.5`.
- Installed-cache Grok 4.6 smoke job `task-mt4ojocm-czui8c` returned exactly `PHASE7_INSTALLED_CACHE_OK` with policy evidence and completion contract both verified.
- Phase 7A permission and capability isolation is complete; a Codex App restart and new task are required to replace any MCP process loaded from an older cache.
