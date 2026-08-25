---
name: grok-auto-personal
description: Enable task-local Grok routing for personal projects while allowing ordinary source and data to be sent through a credential-redacted staging copy.
---

# Grok Auto (Personal)

Use this skill when the user invokes it for a project task. In the active Codex
workspace, `once` is the one-request consent to send the credential-redacted
project staging copy to the configured Grok upstream. This mode is separate
from `grok-auto` and does not change the Grok execution sandbox.

## Mode

- `on`: set this task to `PERSONAL` until turned off, but scope it to the active
  Codex workspace. It never grants or retains access to another project.
- `once`: use personal routing for the accompanying request, implicitly approve
  the active workspace's credential-redacted staging for that request, then
  return to `OFF` and clear any external-project authorization.
- `off`: stop new personal delegation. Do not read a project or call Grok.
- `status`: report `PERSONAL` or `OFF` without reading a project or calling Grok.

State the mode briefly as `Grok Auto (Personal): PERSONAL`, `ONCE`, or `OFF`.
Do not enable this mode implicitly from ordinary `AUTO` routing.

For the active Codex workspace, use the short form and do not ask the user to
repeat a disclosure-consent sentence or provide any second confirmation:

```text
once
需求：...
```

For a project outside the active Codex workspace, require this task-local form:

```text
once
授权项目："E:\\path\\to\\project"
需求：...
```

Read the current Codex task workspace from `environment_context.cwd`; call it
`activeWorkspace`. Pass that unchanged on every Personal worker call. For an
external target, additionally pass `authorizedProject=<exact canonical target
path>` and `cwd=<same target path>`. Never replace `activeWorkspace` with the
external target, and never carry the target into a later task or context
continuation. If more than one external project is needed, run separate `once`
requests rather than combining project roots.

## Disclosure contract

For a read-only personal delegation, call `grok_personal_read`. It enforces:

```text
readOnly=true
dataPolicy=personal-sanitized
sourceDisclosureConsent=true
personalMode=once
fresh=true
noMemory=true
model=grok-4.6
effort=high
```

The call must also include:

```text
activeWorkspace=<environment_context.cwd>
cwd=<project being analyzed>
```

For the active workspace, the `once`/`on` scope supplies this consent
implicitly at the worker boundary. For an external project, the exact
`授权项目` path supplies the one-request disclosure authorization; do not carry
it into another task.

For the active workspace, pass `activeWorkspace` and `cwd` as the same path,
and never pass `authorizedProject`. For an external project, keep
`activeWorkspace` on the Codex task workspace and pass both the external `cwd`
and the exact `authorizedProject`.
`grok_personal_read` is intentionally non-destructive at the MCP boundary so
Codex does not route a read-only source analysis through write-tool approval.

Use `grok_rescue` only when the user's task requires source changes. In that
case pass the same Personal disclosure fields explicitly so the disclosure
staging and write-back contract is applied consistently.

The worker stages the selected project into a temporary directory, excludes
credential files and protected metadata, redacts high-confidence API keys,
private keys, passwords, tokens, JWTs, and credential-bearing connection
strings, and sends only that staging directory to Grok. Ordinary source,
algorithms, business rules, customer data, internal URLs, and database schemas
may remain in the staged copy.

The local Grok CLI may route through CC Switch to a remote Grok upstream. The
skill must state that destination when the task is first delegated.

The worker rejects Personal delegation when `activeWorkspace` is missing, when
the current workspace also passes `authorizedProject`, when an external `cwd`
lacks an exact `authorizedProject`, or when it attempts to authorize a
different path. Do not recover from a scope error by adding the current project
as `authorizedProject`; correct `activeWorkspace` from `environment_context`
and retry once. This is a task-local disclosure authorization, not a
filesystem permission grant; Codex must still be allowed to read the requested
path.

Personal tasks default to `model=grok-4.6` with `effort=high`. Use `model=fast`
or an explicit lower `effort` only when the user requests a faster, cheaper
run.

If the Grok worker returns a failed, cancelled, or unverified result, relay the
raw delegation error and its evidence. Do not continue with a local substitute
analysis or present Codex's own findings as a successful Grok result.

## Read and write work

This skill supports both investigation and implementation. Grok keeps the
standard execution boundary: strict sandbox, shell/MCP/web denial, no Codex
plugins, no credentials, and no host commands.

- Read-only tasks use `grok_personal_read`; Grok inspects the staging copy and
  reports findings without any write-capable MCP surface.
- Write tasks let Grok edit only the staging copy. The companion rescans the
  resulting files and applies only an approved safe patch to the original
  workspace, then uses the normal snapshot, file-scope, test, and rollback
  contract. Set `rollbackOnFailure=true` and a non-empty
  `allowedChangedFiles` allowlist.
- Files that contained redactions are never written back automatically.

Personal tasks currently run in the foreground, start fresh, and do not use a
Grok-managed worktree; the companion staging directory is already isolated.

If consent is missing, the worker must fail before Grok starts. Do not replace
this policy with `yolo`, `bypassPermissions`, a broader sandbox, or a raw
workspace handoff.
