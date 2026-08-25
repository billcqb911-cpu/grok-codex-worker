# Changelog

## Unreleased

### Added
- **Canonical MCP tool manifest**: schemas, annotations, companion serializers, dynamic read/write classification, parallel/background capability, and approval class now come from one startup-validated manifest.
- **Invocation and environment identity**: jobs/results now persist an invocation id, MCP request id, job id, tool/backend/model/attempt, policy fingerprint, active/target/execution workspaces, root set, and stable environment id.
- **Policy composition evidence**: added redacted `requested`, plugin `authority`, and `effective` policy layers plus a stable SHA-256 fingerprint while retaining `workerPolicy` compatibility.
- **Append-only lifecycle journal**: each job records bounded/redacted NDJSON events with locked contiguous sequence numbers across acceptance, policy, process, cancellation, verification, rollback, and terminal publication.
- **Reusable MCP stdio harness**: source and installed-cache tests now share lifecycle, request-id, timeout, NDJSON, cancellation, stderr, and cleanup behavior.

### Reliability
- **Workspace write lease**: write-capable jobs are serialized per canonical workspace while read/status/result/cancel operations remain concurrent.
- **Confirmed cancellation**: MCP cancellation reaches the active worker, waits for process-tree close, forces rollback for cancelled writes, and prevents duplicate terminal publication.
- **Bounded atomic projections**: foreground/background captures and persistent logs expose retained/omitted byte evidence; job, progress, cancellation, state, and result writes are atomic. Detached jobs finalize and release their lease without requiring a later poll.

### Security
- **Dedicated Personal read boundary**: added `grok_personal_read` with static read-only/non-destructive MCP annotations and a minimal schema. It still declares open-world access because the sanitized staging copy is sent to the configured remote Grok upstream. Personal writes remain on destructive `grok_rescue`.
- **Task-local Personal project scope**: external project disclosure now requires `personalMode=once` plus an exact `authorizedProject` matching `cwd`. `on` is limited to the active workspace, while `off` and `status` do not read projects or call Grok.

### Changed
- **Approval routing**: Personal read-only analysis no longer enters the write-capable `grok_rescue` automatic approval path, which could time out before a Grok job was created. The dedicated tool forces sanitized disclosure, read-only mode, fresh/no-memory execution, no subagents/web search, and `grok-4.6 + high` defaults.
- **Personal shorthand and default effort**: `once`/`on` in the active workspace now imply one-task credential-redacted disclosure consent; external projects still require an exact `authorizedProject`. Rescue and read-oriented task defaults now use `grok-4.6` with `high` effort, while `fast` remains an explicit low-effort preset.

### Fixed
- **Explicit Codex workspace identity**: Personal MCP calls now require `activeWorkspace` from Codex `environment_context.cwd` and preserve it through companion CLI parsing, scope validation, job config, and policy evidence. The installed MCP server no longer mistakes its plugin-cache process directory for the current project.
- **Installed-cache regression**: added a real cached-plugin stdio test with full source/cache SHA-256 parity and mock Grok coverage for current-project success, external-project rejection without authorization, and exact one-request external authorization.

## 0.5.8

### Fixed
- **MCP workspace scoping**: every tool accepts `cwd` so installed-plugin MCP calls run against the active project (not the plugin cache). Companion spawn uses that directory for jobs, git, and artifacts.

### Notes
- Behavioral parity with grok-in-claude **v0.5.7** retained; this release is Codex-host-specific.


## 0.5.7

### Fixed
- **Live progress floor**: whitespace-only stream tokens no longer blank status; helper returns empty until real content, call sites use `|| "running"`.

### Parity
- Feature parity with [grok-in-claude](https://github.com/stdevMac/grok-in-claude) v0.5.7 mapped to Codex MCP tools + skills.

## 0.5.6

### Fixed
- **Progress helper coverage**: embed `formatStreamProgressMessage` source into the background worker (no drifted copy); tests assert against the embedded string.
- **Version lockstep**: marketplace metadata + plugin entry share package/plugin version.

## 0.5.5

### Fixed
- **Live progress (thinking)**: status tails accumulated `thought` stream events the same way as text.

## 0.5.4

### Fixed
- **Zombie background jobs**: `hasResultFile` requires a complete parseable `result.json` (not mere exists); corrupt/truncated files fail cleanly instead of staying `running` forever.
- **Atomic result write**: background wrapper writes via tmp + `renameSync` so partial files never appear as complete.
- **Live progress**: status message uses a tail of accumulated text, not only the last streamed token.

## 0.5.3

### Fixed
- **Background result race**: do not reaper-fail when complete `result.json` exists; reconcile false-failed jobs on status/result so plan.md is harvested.
- **Plan result text**: apply `preferPlanArtifactText` on all plan result render paths.
- **Session path keys**: try `/var` and `/private/var` encodings when locating session artifacts (macOS).
- **Plugin data trust**: only trust this plugin’s data dirs / `GROK_CODEX_PLUGIN_STATE` / `~/.grok/codex-plugin/state` (reject foreign host plugin dirs).

## 0.5.2

### Fixed
- **expandArgv** + array options (`--allow` / `--deny`) for control surface parsing.
- **`--dry-run` / `--validate-only`**: no longer grant `--yolo` (read-only tool posture).
- **babysit list**: read-only (no yolo); add/check/remove remain write-capable.
- **status log tail**: truncates multi-KB NDJSON `available_commands` lines.

## 0.5.1

### Added
- Design / workflow / plan / document artifact harvest helpers.
- `execute-plan --latest` resolves newest design under `.grok-designs/`.
- Post-pending policy: skip empty findings; empty/oversize diff guards; recoverable findings under `.grok-reviews/`.
- Status/result show usage and artifact paths.
- Mock Grok binary finish-path tests (`tests/helpers/mock-grok.mjs`).
- Routing skill: plan → design → execute-plan depth pipeline.

### Improved
- Stop-gate / setup min CLI version floor (`0.2.118`), denylist posture.
- README documents artifact dirs, control flags, and state env.

## 0.5.0

### Added (depth surface + reliability)
- MCP tools: `grok_plan`, `grok_workflow`, `grok_design`, `grok_execute_plan`, `grok_babysit`, `grok_document`, `grok_sessions`.
- Control surface on long-running jobs: sandbox, plan/permission-mode, agent, no-subagents, memory, allow/deny, disable-web-search, fork-session, max-turns.
- Job schema v3: `config`, `usage`, `artifacts` on finished jobs.
- Background review post-pending finalize path.
- Reliability: complete-result reaper, atomic result write, stream progress accumulate, plan text preference.

## 0.1.0

### Added
- Initial Codex MCP plugin: setup, rescue, review, adversarial review, image, video, status, result, cancel, transfer.
## Unreleased

- Fixed Grok 1.0.5 compatibility: plugin-level `check` and `bestOfN` controls
  are no longer sent as unsupported `--check`/`--best-of-n` CLI arguments.
  `check` is now expressed in the completion prompt, while `bestOfN > 1`
  fails before job creation with an explicit compatibility error.
- Personal Grok Auto now relays failed delegation evidence without silently
  substituting a local analysis.

- Fixed MCP job serialization so policy-enforced `memory: { enable: false }` cannot become `--memory`; disabled memory now emits at most one `--no-memory` flag.
- Kept MCP policy validation separate from caller CLI serialization, preventing original-workspace allow rules from breaking Personal staging after its workspace path changes.
- Removed always-rejected agent, memory-enablement, and caller-allow inputs from public MCP schemas; Personal disclosure controls are now exposed only by `grok_rescue`.
- Personal staging now skips conventional dependency/build/cache directories and files larger than 10 MiB before reading them.
- Renamed the original skill UI entry to `Grok Auto (Standard)` and added the explicit-only `Grok Auto (Personal)` entry.
- Added the `personal-sanitized` data policy with explicit source-disclosure consent, credential-aware temporary staging, prompt/result redaction, and worker-policy evidence.
- Personal read/write tasks keep the Phase 7 execution boundary. Writes run fresh in the foreground, require rollback plus an exact changed-file allowlist, preflight every staged change atomically, and never write back files that contained redactions.
- Added the explicit-only `grok-auto` skill as a task-local unified entry point, with `on`, `once`, `status`, and `off` modes and no `AGENTS.md` persistence.
- Added a detailed Chinese user guide covering Grok Auto, direct MCP calls, safety contracts, background jobs, permission boundaries, installation, updates, and troubleshooting.
- Added Phase 7A permission and capability isolation.
- Grok tasks now force the `strict` sandbox with `dontAsk`/`plan`, reject yolo, custom agents, memory, caller allow rules, unsafe permission/sandbox requests, and host-tool handoffs.
- Documented Grok rules deny all Bash, Grok MCP, web-fetch, and web-search tools; Claude/Cursor compatibility discovery, subagents, workflows, telemetry, and memory are disabled in the child environment.
- Grok child processes receive an explicit non-secret environment allowlist and temporary command guards for Codex, plugin, MCP, credential, remote-shell, and network CLIs.
- Completion verification now requires valid structured worker-policy evidence in addition to Grok success, artifacts/files, actual SHA-256 changes, scope, and any requested check command.
- Windows results explicitly report tool-policy/snapshot enforcement rather than claiming an undocumented Grok kernel sandbox.
- Added redacted worker-policy evidence and MCP approval annotations; Codex remains the only host-tool principal.
