# Grok Codex Worker

Use [Grok](https://grok.com) from inside Codex for code reviews, delegated coding, planning, multi-agent workflows, design→execute pipelines, PR babysitting, and image/video/document generation.

Detailed Chinese guide: [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md)

**Plugin version:** 0.1.0. Codex stays the orchestrator. A thin MCP server + companion script hands real work to Grok on your machine via the local CLI (Grok Build ≥ **0.2.118** recommended).

Artifact dirs (gitignored): `.grok-plans/`, `.grok-designs/`, `.grok-workflows/`, `.grok-docs/`, `.grok-reviews/`, `.grok-media/`.

Using Claude Code instead? Use the sibling plugin: [grok-in-claude](https://github.com/stdevMac/grok-in-claude).

## What you get

| Codex MCP tool | Purpose |
| --- | --- |
| `grok_setup` | Check CLI + auth + version floor + doctor; toggle stop review gate |
| `grok_personal_read` | Credential-redacted Personal source analysis (strictly read-only; remote Grok upstream) |
| `grok_rescue` | Delegate investigation / fixes (write-capable; full control flags) |
| `grok_plan` | Plan mode only (explore → plan.md under `.grok-plans/`) |
| `grok_review` | Structured read-only review (tree / branch / PR; optional `postPending`) |
| `grok_adversarial_review` | Challenge design, tradeoffs, and assumptions |
| `grok_workflow` | List/run Grok Rhai multi-agent workflows |
| `grok_design` | Design doc + PR plan (writer/reviewer loop → `.grok-designs/`) |
| `grok_execute_plan` | Execute a design-doc PR Plan DAG |
| `grok_babysit` | Watch PRs / fix CI & review comments (`list` is read-only) |
| `grok_document` | Generate docx / pdf / pptx → `.grok-docs/` |
| `grok_image` | Generate or edit images → `.grok-media/image/` |
| `grok_video` | Generate short videos → `.grok-media/video/` |
| `grok_sessions` | List / search / export Grok sessions |
| `grok_transfer` | Build context-transfer guidance for Grok |
| `grok_status` | Jobs + live progress / log tail + usage when available |
| `grok_result` | Final output (plan.md preferred for plan jobs; usage + artifacts) |
| `grok_cancel` | Cancel a background job |

**Control flags** (rescue/plan/review and long-running jobs): `sandbox`, `planMode` / `permissionMode`, `deny`, `disableWebSearch`, `forkSession`, `maxTurns`. Phase 7 applies a non-overridable floor: effective sandbox is always `strict`, normal headless work uses `dontAsk`, and plan jobs use `plan`. Caller `allow` rules, custom agents, memory, `acceptEdits`, `auto`, `bypassPermissions`, `off`, and `devbox` are rejected.

**Capability boundary:** Codex remains the only principal that can call other Codex plugins/MCP tools, browsers, connectors, credentials, logins, uploads, or external submissions. Grok receives only a bounded project-worker handoff. Set `hostToolRequired=true` on an MCP request when the task requires a host capability; the worker rejects that delegation before Grok starts. Child execution uses an explicit environment allowlist, disables web search/fetch, subagents, memory, workflows, telemetry, and Claude/Cursor compatibility discovery, forces the `strict` sandbox, and denies `Bash(*)`, `MCPTool(*)`, `WebFetch`, and `WebSearch`. Temporary command guards add defense in depth for host, credential, remote-shell, and network CLIs.

For a task that needs a Codex capability, use this handoff instead of asking Grok to invoke it:

```text
Codex calls the host plugin/MCP -> sanitize the minimum result -> grok_rescue for project work -> Codex verifies -> Codex performs the external action.
```

The `grok_rescue` MCP approval authorizes only that one bounded worker invocation. It is not blanket approval for actions Grok might attempt inside its child process. Worker results retain the backward-compatible redacted `workerPolicy` record and also include `policyEvidence` (`requested`, plugin `authority`, `effective`, and a stable SHA-256 fingerprint), an `invocation` identity, and an `executionEnvironment` with explicit active/target/execution workspace roles. These records never include prompt/file contents, environment values, or credentials.

The MCP server uses one startup-validated tool manifest as the source of truth for model-visible schemas, CLI serialization, read/write classification, parallel/background support, and approval class. Missing serializers, duplicate/reserved names, and incomplete capability/schema metadata fail before the server accepts work.

On Windows, Grok 1.0.5 does not document a kernel-enforced sandbox implementation. The worker therefore reports `tool-policy-plus-snapshot` filesystem enforcement and `tool-policy-only` child-network enforcement on Windows; it does not claim Linux/macOS kernel guarantees. Write tasks remain protected by exact workspace Edit/Write rules, SHA-256 snapshots, scope validation, independent checks, and rollback, but this is not a VM boundary.

Skills: brand/media recipes, routing (including plan→design→execute-plan), runtime contracts, workflows, prompting.

### One-command automatic routing

Select **Grok Auto (Standard)** from the `/` skills menu, or explicitly
invoke `$grok-auto`. For personal source disclosure, select **Grok Auto
(Personal)** and invoke `$grok-auto-personal`; `once` is the one-request consent
for the active workspace and
stages a credential-redacted project copy. Dependency/build/cache directories,
binary files, and files larger than 10 MiB are omitted from that copy. Both modes are limited to the
current Codex task and never
writes project guidance:

```text
$grok-auto on       # AUTO for this task
$grok-auto once     # automatic routing for one request, then OFF
$grok-auto status   # show the current task-local mode
$grok-auto off      # stop new Grok delegation in this task
$grok-auto-personal on  # PERSONAL for the active workspace only
```

For the active workspace, the short form is sufficient:

```text
$grok-auto-personal once
需求：只读分析这个项目是做什么的。
```

Personal tasks default to `grok-4.6` with `high` effort. Use `fast` or an
explicit lower effort only when a faster, cheaper run is intended.

Personal read-only requests use the dedicated `grok_personal_read` MCP tool.
Its static MCP contract is read-only and non-destructive, while accurately
declaring that the sanitized staging copy goes to the configured remote Grok
upstream. This prevents Codex from sending ordinary source analysis through
the write-capable `grok_rescue` approval path. Personal implementation tasks
still use `grok_rescue` with snapshots, an exact changed-file allowlist, checks,
and rollback.

Personal mode does not retain access to projects outside the active workspace.
For an external project, use a task-local authorization and keep the project
path separate from the request:

```text
$grok-auto-personal once
授权项目："E:\\APP\\MoneyPrinterTurbo\\MoneyPrinterTurbo"
需求：只读分析合成视频逻辑，不修改文件。
```

Every Personal MCP call receives `activeWorkspace=<Codex environment_context.cwd>`.
For the active project, `cwd` is the same path and `authorizedProject` is omitted.
For the external form above, `activeWorkspace` remains the Codex task workspace while
`cwd` and `authorizedProject` both use the exact external path. Passing
`authorizedProject` for the active workspace is rejected. `on` never authorizes an external path; `off` and `status`
do not read projects or call Grok. The one-time authorization is cleared after
the request and is not inherited by later tasks or context continuations.

In the Codex App UI, typing `/` opens the skills menu; select the Standard or
Personal entry and enter the mode or task after the inserted skill chip.

In `AUTO`, Codex decides whether the request is small enough to handle directly
or should use rescue, plan, design, review, or another Grok MCP tool. Codex still
owns verification and all host-only plugins, MCP, browser, credential, GitHub,
and external actions. Turning the mode off does not cancel a background job that
was already started; cancellation remains explicit. Every new Codex task starts
`OFF` until the skill is invoked there.

The public MCP schema omits custom-agent, memory-enablement, and caller-allow inputs because the worker can never honor them. Legacy or direct CLI attempts remain rejected by the runtime policy.

## Requirements

- **Node.js 18.18 or later**
- **[Grok Build CLI](https://grok.com)** (`grok`) on your `PATH`
- **Grok authentication** (`grok login`)
- **GitHub CLI (`gh`)** only if you use `grok_review` with PRs or post-pending

Typical CLI location: `~/.grok/bin/grok` (ensure it is on `PATH`).

## Install

Local fork (the current development checkout):

```powershell
codex plugin marketplace add E:\APP\CodexProject\grok-codex-worker
codex plugin add grok-codex-worker@grok-codex-worker
```

Then start a new Codex thread so the plugin skills and MCP tools are loaded.

### Install locally

```bash
codex plugin marketplace add E:\APP\CodexProject\grok-codex-worker
codex plugin add grok-codex-worker@grok-codex-worker
```

Run setup:

```bash
node plugins/grok-codex-worker/scripts/grok-companion.mjs setup
```

Or ask Codex to call `grok_setup`.

## Quick start

```text
Ask Grok to review this branch against main.
Use Grok to plan the auth rewrite.
Generate a design doc with Grok, then execute the latest plan dry-run.
Start a background Grok rescue job for the retry redesign.
Generate a 16:9 launch banner with Grok.
Show Grok job status.
```

Direct MCP tool examples:

```text
grok_plan prompt="plan the auth rewrite" background=true
grok_design prompt="design multi-tenant billing" background=true
grok_execute_plan latest=true dryRun=true
grok_workflow action=list
grok_review base=main focus="auth, data loss, and race conditions"
grok_rescue prompt="investigate why npm test is failing" background=true
grok_babysit action=list
grok_document type=pdf prompt="one-pager for the launch"
grok_sessions action=list
grok_status
grok_result jobId="plan-abc123"
grok_image aspect="16:9" prompt="Dark developer-tool launch banner"
grok_video image="./.grok-media/image/hero.png" duration="6" prompt="gentle camera push-in"
```

### Workspace selection

Codex starts an installed plugin MCP server from the plugin cache, so its process working directory
does not identify the active project. Pass the target directory as `cwd`. Personal calls must also
pass the unchanged Codex `environment_context.cwd` as `activeWorkspace`; this is how the worker
distinguishes the current project from an external target. The companion then runs in `cwd` and
keeps jobs, git inspection, and artifacts scoped to the intended workspace.

For direct local calls, use for example:

```text
grok_review cwd="/path/to/project" base=main
grok_status cwd="/path/to/project" json=true
```

## Depth pipeline

For multi-PR or ambiguous product work, prefer:

1. **`grok_plan`** — explore + harvest `plan.md`
2. **`grok_design`** — design doc + PR plan under `.grok-designs/`
3. **`grok_execute_plan`** with `latest=true` — implement the PR DAG
4. **`grok_review`** / **`grok_babysit`** — quality and CI loop

## Job control semantics

- **Concurrent multi-job support** — read/status/result/cancel calls can run concurrently. Write-capable jobs are serialized per canonical target workspace so snapshots and rollback cannot overlap; a second writer fails before Grok starts.
- **Status** — live progress is a tail of accumulated text *and* thought streams; empty/whitespace-only stream tokens floor to `running`.
- **Result** — plan jobs prefer harvested `plan.md` body over narration; finished jobs persist `config`, `usage`, and `artifacts` (v3 schema).
- **Cancellation** — MCP and `grok_cancel` first publish `cancel_requested`, terminate the owned process tree, wait for confirmed process close, then verify rollback and publish one terminal result.
- **Reaper** — dead pid + complete parseable `result.json` reconciles to completed; dead pid + empty/truncated/incomplete result → terminal **failed** with distinct diagnostics (no forever-`running` zombies).
- **Atomic and bounded persistence** — state, job, progress, cancellation, and background result projections use atomic replacement. Foreground/background output and persistent log tails are bounded and report retained/omitted byte counts.
- **Lifecycle journal** — each job has an append-only `${jobId}.events.ndjson` beside its job files. Cross-process appends receive contiguous `seq` values and cover acceptance, policy, snapshot, process, cancellation, verification, rollback, and the single terminal outcome. Payloads redact sensitive keys and are bounded to 16 KiB per line.
- **PR post-pending** — runs on background completion too; skips empty findings; empty/oversize diffs fail closed with recoverable findings under `.grok-reviews/`.

## Completion contract

This fork treats Grok's narrative as untrusted until the requested result is verified.

- `grok_plan` fails with `failed_artifact` when no non-empty plan exists under `.grok-plans/`.
- `grok_document` fails with `failed_artifact` when no non-empty document exists in the requested output directory.
- `grok_rescue`, `grok_plan`, and `grok_document` accept `expectedFiles` and `checkCommand`.
- `expectedFiles` must stay inside `cwd`, be non-empty, and `checkCommand` must exit with code 0.
- `allowedChangedFiles` is a strict allowlist for snapshot-detected added/modified/deleted files.
- `forbiddenChangedPaths` rejects changes anywhere below the listed files or directories.
- A scope violation is reported as `failed_scope`; with `rollbackOnFailure=true`, all snapshot-detected changes are restored and the terminal status is `failed_scope_rolled_back`.
- Job results include a `contract` object containing checked paths, command output, and verification status.

Example:

```text
grok_rescue cwd="C:\\work\\app" prompt="write the test report" expectedFiles=["reports\\unit.md"] allowedChangedFiles=["reports\\unit.md"] forbiddenChangedPaths=["src"] snapshot=true rollbackOnFailure=true checkCommand="npm.cmd test"
```

A successful Grok process with a missing file is therefore reported as a failed task, so Codex can retry or ask for clarification.

### Workspace safety and evidence

Write-capable jobs create a snapshot before Grok starts. The snapshot is stored in the plugin state directory, outside the project. On completion the job records an `added` / `modified` / `deleted` change set and exposes the snapshot manifest in `grok_result` and `grok_status`.

  - `snapshot=true` forces a snapshot; write jobs use it by default and cannot disable it.
  - `noSnapshot=true` is only valid for read-only jobs with no scope or rollback contract.
  - Snapshot inventory records SHA-256 hashes for large files and symlink metadata; changes to
    files excluded from copy/restore are reported as `unverified` and fail closed.
  - `rollbackOnFailure=true` restores the pre-job files when artifact or check validation fails.
- Scope controls require a snapshot; combining `noSnapshot=true` with `allowedChangedFiles`, `forbiddenChangedPaths`, or `rollbackOnFailure` is rejected before Grok starts.
- Windows completion checks preserve nested quotes by running through a temporary `.cmd` file.
  - Rollback is verified by recalculating the change set; residual changes produce `failed_rollback`.
  - `checkPolicy` accepts `on-success` (default) or `always`.
  - Persistent state updates use a cross-process lock and atomic replacement; background prompt
    files are removed after the Grok process exits.
- Job/state JSON remains the schema-v3 compatibility projection. The append-only event journal is additional audit/recovery evidence and does not change existing readers.
- `checkTimeoutMs` limits a completion command to 100-3,600,000 ms (default 120,000).
- Rollback is opt-in because a failed task may still contain useful partial work.

## CLI posture

- The low-level argument builder always reapplies the worker policy and rejects `--yolo` / always-approve.
- Every delegated job uses `--sandbox strict`; normal jobs use `--permission-mode dontAsk`, plans use `plan`.
- Shell, Grok MCP, web fetch, and web search are denied with documented Grok permission rules.
- Grok does not run shell tests. `checkCommand` is executed separately by the companion with a secret-free environment, then included in completion verification.
- `dryRun` / `validateOnly` / babysit `list` also deny Edit/Write.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Override path to the `grok` CLI (also used by tests with a mock binary) |
| `GROK_CODEX_PLUGIN_STATE` | Explicit job-state root for this plugin |
| `CODEX_PLUGIN_DATA` | Host plugin data dir; trusted only when basename is `grok` / `grok-*` |

Default state root when unset: `~/.grok/codex-plugin/state/`. Codex does **not** share Claude’s `~/.grok/claude-plugin/state` or `GROK_CLAUDE_PLUGIN_STATE`.

## Usage notes

### Rescue

- Write-capable by default.
- Use `readOnly=true` for investigation-only work.
- Use `worktree=true` and `check=true` for safer attempts. `check=true` is a
  plugin-level worker self-check; it is not passed as a `--check` Grok CLI
  flag. The installed Grok CLI does not support `bestOfN`/`--best-of-n`; run
  separate tasks when independent attempts are needed.
- Use `expectedFiles`, `allowedChangedFiles`, `forbiddenChangedPaths`, and `checkCommand` for a verifiable write contract.
- The caller may add deny rules but cannot add allow rules or enable custom agents, memory, subagents, shell, MCP, or web capabilities.

### Plan / design / execute

- Plan mode harvests into `.grok-plans/`; result body prefers the plan file.
- Design harvests into `.grok-designs/`.
- `grok_execute_plan` with `latest=true` picks the newest design doc; `dryRun=true` is read-only.

### Review

- Read-only; never applies patches.
- `postPending=true` with a PR posts PENDING GitHub review comments when findings exist.

### Media

- Default outputs land under `.grok-media/image/` and `.grok-media/video/`.
- Session media is copied into those dirs when Grok leaves files in its session workspace.

### Jobs

- Background tools return a job id.
- Use `grok_status` / `grok_result` / `grok_cancel` with that id when multiple jobs are active.

## Development

```bash
npm test
node plugins/grok-codex-worker/scripts/grok-companion.mjs setup --json
node plugins/grok-codex-worker/mcp/server.mjs   # stdio NDJSON MCP server
```

## Versioning

Root `package.json`, `plugins/grok-codex-worker/.codex-plugin/plugin.json`, and `.agents/plugins/marketplace.json` (metadata + plugin entry) share the same version string. Bump them together.

## License

Apache-2.0
