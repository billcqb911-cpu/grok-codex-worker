---
name: grok-auto
description: Explicitly enable, disable, or use once a task-local mode where Codex decides whether and how to delegate project work to Grok.
---

# Grok Auto (Standard)

Provide one user-facing entry point while keeping Codex as the task leader. This
mode is conversational state for the current Codex task only. Do not persist it
to project files, `AGENTS.md`, plugin state, or another task.

## Commands

Interpret text supplied with the skill as follows:

- No mode or `on`: set this task to `AUTO` until the user turns it off. If a
  substantive request accompanies the command, handle it immediately.
- `once`: apply automatic routing to the accompanying request, or otherwise to
  the next substantive request, then return to `OFF`.
- `off`: set this task to `OFF`. Do not call a Grok tool in the same turn.
- `status`: report `AUTO`, `ONCE`, or `OFF` without calling Grok.

After a mode change, state it briefly as `Grok Auto (Standard): AUTO`, `Grok Auto (Standard): ONCE`,
or `Grok Auto (Standard): OFF`. A new Codex task always starts `OFF` unless the user invokes
this skill there. Explicit user instructions such as "do not use Grok for this
request" override `AUTO` for that request without disabling later automatic
routing.

Turning the mode off prevents new delegation. It does not cancel an already
running background Grok job; cancel one only when the user explicitly asks.

## Automatic routing

For each request while `AUTO` or `ONCE` is active, Codex owns the plan, chooses
the execution path, reviews evidence, and delivers the final answer.

- Handle small, clear, low-risk work directly in Codex.
- Use `grok_rescue` for substantial debugging, cross-module implementation,
  independent second opinions, or long investigations.
- Use `grok_plan` when the implementation direction is materially ambiguous.
- Use `grok_design` and then `grok_execute_plan` for a requested design document
  or a genuine multi-stage PR plan.
- Use `grok_review` or `grok_adversarial_review` for requested independent
  review. Git/branch/PR modes require a Git repository.
- Use the specialized Grok media, document, workflow, or session tool only when
  it directly matches the request.
- Prefer `background=true` for long work. Track the returned job id and obtain
  the final result before claiming completion.

Do not delegate merely to demonstrate Grok usage. Do not make the user choose a
Grok tool when Codex can route the request from its intent.

## Workspace and contracts

Pass the active project's absolute `cwd` on every Grok MCP call. If the task's
workspace is ambiguous, resolve it from the active Codex project before calling
Grok; ask only when it cannot be determined safely.

For read-only investigation, set `readOnly=true`, use `grok-4.6` with `high`
effort unless the user requests another model or a faster run, start fresh
unless continuity is useful, and keep web search and subagents disabled.

For write-capable work:

1. Determine the narrowest credible changed-file scope from the request and
   inspected repository. Do not invent an exact allowlist when discovery is
   still required; perform a read-only pass first.
2. Use `snapshot=true` and `rollbackOnFailure=true`.
3. Set `expectedFiles`, `allowedChangedFiles`, and `forbiddenChangedPaths` when
   they can be stated accurately.
4. Select the repository's real verification command from its configuration or
   documented workflow; do not guess from language alone.
5. Set `checkCommand` and a proportionate timeout when a reliable command is
   available.
6. Accept completion only when policy, actual-change, scope, and check evidence
   required by the contract pass and `contract.verified=true`.

If Grok fails, times out, returns zero changes, violates scope, or fails checks,
report that evidence. Retry only when the cause and retry are bounded; otherwise
continue in Codex or ask for the missing decision.

## Host boundary

Keep Codex plugins/MCP tools, browsers, connectors, credentials, logins,
GitHub operations, approvals, uploads, and other external side effects on the
Codex host. Never ask Grok to invoke them. When a request needs both kinds of
work, Codex performs the host step, sends only the minimum sanitized project
context to Grok, verifies the result, and performs any final host action.

User authorization to call Grok does not authorize unrelated external actions
or broader filesystem access.

Standard mode does not retain authorization for projects outside the active
Codex workspace. Its `once` command keeps the existing one-request routing
semantics; it does not accept or persist Personal `authorizedProject` scope.
For explicitly consented credential-redacted disclosure of an external project,
use Grok Auto (Personal) with `once` and the exact project path.
