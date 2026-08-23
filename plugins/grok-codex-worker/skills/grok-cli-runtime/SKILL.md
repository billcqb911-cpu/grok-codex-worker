---
name: grok-cli-runtime
description: Internal helper contract for calling the grok-companion runtime from Codex
user-invocable: false
---

# Grok Runtime

Use through the Grok MCP tools. If MCP is unavailable, call the companion directly with `node plugins/grok-codex-worker/scripts/grok-companion.mjs <command> ...`.

Recommended Grok CLI version: **≥ 0.2.118**.

## Workspace

Installed Codex plugin MCP servers start from the plugin cache. Pass `cwd` with the active project
directory on every Grok MCP call so Grok inspects, edits, and stores artifacts in the intended
workspace rather than the cached plugin directory. Direct companion calls can use `--cwd <path>`.

## Concurrency

- **Multiple companion jobs may run at once.** There is no global single-agent lock.
- Prefer `background: true` or `--background` when a Codex turn is launching more than one Grok job.
- Each MCP call should make exactly one companion invocation.
- Parallelism = multiple background companion jobs, not a serialized queue.
- When several jobs are running, always pass job ids to `status` / `result` / `cancel`.

## Control flags (most write/plan commands)

MCP input keys map to companion flags:

| MCP property | Companion flag |
| --- | --- |
| `sandbox` | `--sandbox` |
| `planMode` | `--plan` |
| `permissionMode` | `--permission-mode` |
| `noSubagents` | `--no-subagents` |
| `deny` | `--deny` (repeatable; only narrows the worker) |
| `disableWebSearch` | `--disable-web-search` |
| `forkSession` | `--fork-session` |
| `maxTurns` | `--max-turns` |

## CLI posture

- The runtime always reapplies the Phase 7 policy at the lowest launch layer.
- Effective sandbox is `strict`; permission mode is `dontAsk` or `plan`.
- `Bash(*)`, `MCPTool(*)`, `WebFetch`, and `WebSearch` are always denied.
- Caller allow rules, custom agents, memory, subagents, and yolo/always-approve are rejected.
- Write tools are allowed only for the resolved workspace; write jobs require a SHA-256 snapshot.
- `--dry-run` / `--validate-only` / babysit `list` additionally deny Edit/Write.

## Depth notes

- `grok_execute_plan` with `latest=true` resolves newest `.grok-designs/*.md`.
- Design/workflow/plan/document jobs harvest copies into `.grok-designs/` / `.grok-workflows/` / `.grok-plans/` / `.grok-docs/`.
- Review `postPending=true`: skips empty findings; empty/oversize diffs fail closed and save findings under `.grok-reviews/`.
- Plan results prefer harvested `plan.md` body over narration.
- Stop-gate uses the strict sandbox and the read-only deny policy.

## State env

- Default job state: `~/.grok/codex-plugin/state/`
- Override: `GROK_CODEX_PLUGIN_STATE`
- Host plugin data: `CODEX_PLUGIN_DATA` only when the dir basename is trusted (`grok` / `grok-*`)
- Does **not** share Claude plugin state (`GROK_CLAUDE_PLUGIN_STATE` / `claude-plugin`)

## Task (`grok_rescue`)

- Exactly one `task` invocation per handoff
- Map `fast` → `--model grok-composer-2.5-fast`
- Map `deep` → `--model grok-4.5 --effort high`
- `resume` → `--resume-last`; `resumeSession` → resume that id; `fresh` → no resume
- Pass `worktree`, `check`, `bestOfN` through when present
- Default write-capable; `readOnly` only when requested

## Plan (`grok_plan`)

- Forces plan permission mode; harvests `.grok-plans/`

## Review (`grok_review` / `grok_adversarial_review`)

- Read-only; never apply patches
- `postPending` + `pr` posts a GitHub PENDING review

## Workflow / design / execute / babysit / document / sessions

- `grok_workflow` — `action=list|run`; list and `validateOnly` are read-only
- `grok_design` — design-doc writer/reviewer loop
- `grok_execute_plan` — PR Plan DAG; `dryRun` is read-only
- `grok_babysit` — `action=add|list|check|remove`; list is read-only
- `grok_document` — `type=pptx|pdf|docx`
- `grok_sessions` — `action=list|search|export`

## Media (`grok_image` / `grok_video`)

- Artifacts under `.grok-media/image/` and `.grok-media/video/`

## Jobs

- `grok_status` / `grok_result` / `grok_cancel`
- Status shows accumulated stream progress (text + thought tails); whitespace-only stays `running`
- Result includes usage and artifacts when present
