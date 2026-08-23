# Findings

- Upstream used Unix `which`; Windows needs `where.exe` and explicit `.exe/.cmd` candidates.
- Upstream completion status trusted Grok exit code and could report `completed` without a plan/document file.
- A local marketplace is recognized by Codex when added from the repository root containing `.agents/plugins/marketplace.json`.
- The fork uses plugin name `grok-codex-worker` so the original cache remains untouched.
- Use model/profile `grok-4.5` in this environment; CC Switch routes it to the configured upstream Grok 4.6 endpoint.
- Non-Git directories can run rescue/plan/document tasks, but review/worktree/PR features remain Git-dependent.
- Phase 2 snapshots only files inside `cwd`, keeps metadata outside the workspace state root, and rolls back from an explicit recorded manifest.
- Strict scope is explicit: `allowedChangedFiles` is an exact-file allowlist and `forbiddenChangedPaths` covers files or directories. Scope violations fail closed and can trigger automatic rollback.

## Phase 3 findings

- A scope allowlist without a snapshot cannot be verified safely; the CLI now rejects it before creating a job.
- Passing a nested quoted command directly to Windows cmd.exe can silently alter arguments and exit status; checks now use a temporary batch file.
- Rollback success is rechecked by rebuilding the workspace change set; residual files turn the result into `failed_rollback`.

## Phase 4 implementation notes

- Snapshot manifests now declare SHA-256 and emit a canonical changedFiles list with before/after hashes.
- Completion now evaluates actual changed paths after Grok exits; write no-ops and unchanged expected files fail closed.

## Phase 5 finding

- The detached background wrapper appended raw stdout chunks before parsing streaming NDJSON, so `tool_call_update.content` could expose complete file bodies through job logs and `grok_status.logTail`.
- Real Grok 1.0.5 events expose safe path metadata through `rawInput.target_file` and `locations[].path`; file bodies live under `content` and `rawOutput.FileContent`, which the sanitizer never traverses or persists.
- A strict write acceptance correctly rejected no-op responses, max-turn failures, and failing tests before the final verified run, with rollback leaving zero residual changes each time.

## Phase 6 findings

- `validateSnapshotContract` previously accepted `writeCapable + noSnapshot`; finalization then returned `failed_snapshot` without a rollback path. Write tasks must fail before Grok starts when snapshots are disabled.
- `state.json` updates used read-modify-write without an inter-process lock, so concurrent background jobs could lose index updates.
- Snapshot inventory skipped files above the size limit and symlinks without exposing changed-skip evidence; hardening will fail closed for those changes.
- Temporary prompt files were created per job but had no lifecycle cleanup, and raw stderr was appended to persistent stream logs.

## Phase 6 resolution

- `state.json` now uses a tokenized cross-process lock with stale-lock recovery, and all state-file replacements are atomic.
- Write-capable jobs fail before Grok starts when `noSnapshot` is requested.
- Snapshot inventories retain SHA-256 metadata for oversized files and explicit metadata for symlinks; changed skipped entries are surfaced as `unverified` and prevent verification/rollback claims.
- Companion-owned prompt files are removed on foreground completion, background process close/error, and setup failures.
- Background stream logs no longer persist raw stderr text; result payloads retain stderr for diagnostic inspection.

## Phase 7A findings

- The Codex MCP tool registry is host-owned and is not handed to the Grok CLI, but the current MCP server and Grok launch paths both copy the complete `process.env`.
- Current write jobs add `--yolo` unless explicitly disabled, while `sandbox` is optional; callers can also request `sandbox=off` or `permissionMode=bypassPermissions`.
- Snapshot, hash, scope, and rollback checks are post-execution integrity controls. They cannot prevent pre-execution secret reads, command escalation, or data egress.
- The worker needs a non-overridable policy floor: explicit execution profiles, environment allowlisting, host-tool handoff rejection, command boundaries, and structured policy evidence.
- Codex sandbox execution in this managed Windows task rejects Node test-runner child processes with `spawn EPERM`; final test execution must run through the approved outer command path.

## Phase 7A resolution

- Grok 1.0.5 documents permission rules as `Bash(...)`, `MCPTool(...)`, `WebFetch`, and `WebSearch`; legacy `command:*` rules are not a valid boundary.
- `dontAsk` is the bounded headless mode: only explicitly approved writes run, while all other non-read operations are denied. `acceptEdits` and `bypassPermissions` are too broad for the Windows worker boundary.
- Grok's `workspace` and `read-only` profiles can read the entire machine. The worker now requests `strict` for both read and write work, then adds read/write permission rules according to task type.
- Grok documentation only specifies kernel sandbox mechanisms for Linux and macOS. On Windows the worker must rely on Grok tool permissions, configuration preflight, credential-path denies, command guards, snapshots, scope validation, checks, and rollback.
- Removing `run_terminal_cmd` with `--disallowed-tools` breaks Grok 1.0.5 session initialization because `kill_task` and `get_task_output` declare a background-terminal dependency. Keeping the tool graph intact and denying `Bash(*)` blocks invocation without breaking session creation.
- Grok can discover its own global/project hooks, MCP, LSP, plugins, and permission grants independently of Codex. A preflight now rejects those executable/configurable extensions; Claude/Cursor compatibility discovery is also disabled by environment.
- A transient third-party `429` occurred during live acceptance; a retry succeeded without policy changes, confirming it was upstream capacity rather than a plugin contract failure.
