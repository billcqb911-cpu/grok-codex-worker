# grok-codex-worker Fork Development Plan

## Goal
Build an independently installable fork of `stdevMac/grok-in-codex` that Windows Codex can use to delegate real work to Grok through the configured `grok-4.5` profile and CC Switch route.

## Phases

- [x] Clone upstream and establish Windows baseline.
- [x] Rename the plugin and MCP server to `grok-codex-worker`.
- [x] Fix Windows CLI discovery and `.cmd` process execution.
- [x] Add completion contracts for artifacts, expected files, and check commands.
- [x] Add regression tests and make the full suite pass.
- [x] Validate the plugin manifest and install the local marketplace plugin.
- [x] Phase 2a: add write snapshots and deterministic change manifests.
- [x] Phase 2b: add failure rollback for non-Git and Git workspaces.
- [x] Phase 2c: add richer check policies and regression tests.

## Acceptance

- `npm.cmd test`: 130 tests pass.
- `validate_plugin.py`: passes.
- `grok_setup --json`: ready, Grok 1.0.5, authenticated, doctor passed.
- Installed cache exposes MCP server `grok-codex-worker` version `0.1.0`; refreshed plugin cache: `0.1.0+codex.20260821183337`.

## Known limits

- Git review, worktree, PR, and execute-plan flows still require a Git repository.
- Strict scope controls require explicit `allowedChangedFiles` / `forbiddenChangedPaths`; snapshot jobs can automatically roll back scope violations.
- The original `grok@grok-in-codex` plugin remains installed and unchanged.

## Phase 3

- [x] Reject scope/rollback contracts when snapshots are disabled.
- [x] Preserve Windows check-command quoting through temporary batch wrappers.
- [x] Report combined scope/check failures and verify rollback leaves no residual changes.
- [x] Add regression tests and complete suite verification.

## Phase 3 Acceptance

- Isolated acceptance items 1-5 passed.
- Plugin suite: 130/130 tests passed.
- Plugin validation: passed.

## Phase 4: Strict Actual-Change Contracts

- [x] Trace snapshot manifests, workspace diff generation, and rescue completion contracts.
- [x] Add SHA-256 before/after hashing and canonical changed-file manifests.
- [x] Require expectedFiles to be present in the actual changed-file set.
- [x] Fail write contracts when the actual changed-file set is empty.
- [x] Make file scope, check, and actual-change evidence jointly required for completed / verified.
- [x] Add regression tests for no-op writes, successful writes, and check failures.
- [x] Run the full suite, validate the plugin, update the cachebuster, and reinstall the local plugin.

## Phase 4 Acceptance

- Snapshot diffs are derived from SHA-256 manifests, not Grok narration.
- A requested write with zero changes cannot return completed / verified.
- Every expectedFiles entry is an actual changed path in the final manifest.
- Scope and check failures remain fail-closed and rollback-aware.
- Plugin tests and manifest validation pass after reinstall.

## Phase 4 final verification

- Plugin suite: 135/135 tests passed.
- Plugin validation: passed.
- Installed cache: 0.1.0+codex.20260822090452, installed and enabled.
- New MCP task verification remains to be run after restarting Codex App.

## Phase 5: Redacted Tool Logs

- [x] Redact streamed tool events before background job logs are written.
- [x] Retain only tool name, file paths, and execution status for tool events.
- [x] Add regression coverage using a sentinel file body.
- [x] Run the full suite, validate, reinstall, and execute strict single-file acceptance.

## Phase 5 Acceptance

- Plugin suite: 139/139 tests passed.
- Plugin validation: passed.
- Installed cache: 0.1.0+codex.20260822142304.
- Real Grok 4.6 job `task-mt4hljyx-dw2ox2`: completed and verified.
- Exactly one file changed: `tests/unit/test_narrative.py`.
- Target SHA-256 changed from `51acb1c6...dec5` to `52ef4135...c6a6`.
- Project suite: 283 tests passed; scope violations: 0.
- Tool-log schema audit: every tool event contains only `toolName`, `filePaths`, and `status`.

## Phase 6: Stability Hardening

- [x] Add cross-process state locking and atomic state-file replacement.
- [x] Reject write-capable `noSnapshot` jobs before Grok starts.
- [x] Track skipped large/symlink files as unverified changes instead of silently ignoring them.
- [x] Clean temporary prompt files after foreground/background jobs finish.
- [x] Keep stderr diagnostics out of persistent stream logs and add regression coverage.
- [x] Run full tests, validate/reinstall, and record the hardening acceptance evidence.

## Phase 6 Acceptance

- Plugin suite: `142/142` tests passed.
- `validate_plugin.py`: passed.
- State writes are serialized by `state.json.lock`; direct and helper writes use atomic replacement.
- Write-capable `noSnapshot` requests are rejected before a Grok job is created.
- Large-file and symlink snapshot skips are represented as `unverifiedChanges`; any such change fails closed.
- Foreground and detached jobs remove companion-owned temporary prompt files after completion or failure.
- Persistent stream logs retain stderr status only (`diagnostics emitted`); raw stderr remains available in result diagnostics.
- Installed cache: `0.1.0+codex.20260822160938`; source/cache SHA-256 matches for hardened runtime modules.
- Direct setup against the new cache returned `ready=true`; restart Codex App/new task is required to replace an already-running MCP process that points at the previous cache.

## Phase 7A: Permission and Capability Isolation

- [x] Force read-only and workspace-write execution profiles; callers may only narrow them.
- [x] Reject unsafe sandbox/permission modes and remove implicit unbounded write execution.
- [x] Replace inherited process environments with an explicit Grok runtime allowlist.
- [x] Restrict delegated network capability to model transport and disable auxiliary web access by default.
- [x] Block Codex/plugin/MCP/credential command delegation from Grok tasks.
- [x] Add a host-tool handoff contract so Codex-only capabilities stay with Codex.
- [x] Make MCP approval describe one bounded worker invocation, not blanket child approval.
- [x] Persist structured policy evidence without secrets or file contents.
- [x] Add fail-closed privilege-escalation regression tests and complete reinstall acceptance.

## Phase 7A Acceptance

- Grok never receives the Codex MCP registry or Codex/OpenAI/GitHub credentials through the child environment.
- All jobs force Grok's `strict` profile. Read jobs additionally deny Edit/Write; write jobs receive only workspace-specific Edit/Write rules and require a snapshot contract.
- `sandbox=off`, bypass permission modes, host-tool requests, and forbidden command requests fail before Grok starts.
- Web search is disabled by default; any explicit relaxation is rejected unless enabled by trusted plugin policy.
- Codex remains the only principal allowed to invoke other plugins/MCP tools or request user approval.
- Security policy, scope evidence, actual changes, and checks must all pass before `completed / verified`.
- Full tests, plugin validation, cache refresh, reinstall, and new-task smoke checks pass.

## Phase 7A implementation result

- Low-level launch always reapplies policy; direct `write:true` can no longer create `--yolo`.
- Normal jobs use `dontAsk`; plans use `plan`. Caller allow rules, custom agents, memory, subagents, and broader permission modes fail closed.
- Documented permission rules deny `Bash(*)`, `MCPTool(*)`, `WebFetch`, and `WebSearch`; compatibility discovery is disabled.
- Grok child environments are allowlisted and omit Codex/OpenAI/GitHub/XAI credentials.
- Startup rejects active Grok hooks, MCP, LSP, plugins, or permission sections before delegation.
- Completion verification now requires policy evidence, Grok success, artifacts/files, actual SHA-256 changes, scope, and any requested check.
- Windows evidence explicitly reports tool-policy/snapshot enforcement rather than an undocumented kernel guarantee.
- Real Grok 4.6 read-only job `task-mt4o9fje-cqyyhx`: completed, exact response, policy passed, verified.
- Real Grok 4.6 one-file write job `task-mt4od1ce-1d66vq`: completed, exactly one added file, SHA-256 `123cfa35f3d366868770af45f7db5e8594ba2a11a7be4c0e72578be097372ec1`, check passed, scope passed, verified.

## Phase 7A final verification

- Final plugin suite: `151/151` tests passed.
- `git diff --check`: passed (Windows line-ending warnings only).
- Source plugin validation: passed.
- Installed cache: `0.1.0+codex.20260822175452`.
- Source/cache SHA-256 matches for `security.mjs`, `grok.mjs`, `contracts.mjs`, `grok-companion.mjs`, `mcp/server.mjs`, and `render.mjs`.
- Installed-cache setup returned `ready=true`, Grok `1.0.5`, authenticated, with the expected cache path.
- Installed-cache Grok 4.6 smoke job `task-mt4ojocm-czui8c` returned exactly `PHASE7_INSTALLED_CACHE_OK`; `status=completed`, `contract.policy.ok=true`, and `contract.verified=true`.
