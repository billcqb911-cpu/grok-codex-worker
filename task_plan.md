# grok-codex-worker Fork Development Plan

## Goal
Build an independently installable fork of `stdevMac/grok-in-codex` that Windows Codex can use to delegate real work to Grok through the configured `grok-4.6` profile and CC Switch route.

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

## Phase 8: Personal Source-Disclosure Policy

Goal: support an explicit personal-use mode where ordinary source code,
algorithms, business rules, customer data, internal URLs, and database schemas
may be sent to the configured remote Grok model, while API keys, private keys,
passwords, session tokens, and credential stores are withheld or replaced.

- [x] Confirm the transport contract: document that the local Grok CLI may route through CC Switch to a remote Grok upstream; do not infer local inference from the local binary path.
- [x] Add a task-local `dataPolicy` control with a fail-closed default (`strict`) and an explicit `personal-sanitized` opt-in. Keep `readOnly`, `sandbox`, and execution-deny rules unchanged.
- [x] Add a staging-copy pipeline that copies the workspace into a temporary directory, excludes credential paths and `.git` metadata by default, handles symlinks safely, and never lets Grok edit the original workspace directly.
- [x] Implement deterministic credential detection/redaction for credential filenames, secret-shaped environment/config keys, common API-key/token/private-key/password formats, JWTs, and connection-string passwords.
- [x] Make the personal skill the explicit consent boundary; Standard never enables `personal-sanitized` implicitly.
- [x] Support personal-mode writes through an atomic staged patch flow: Grok edits only the sanitized staging copy; the companion validates all changed files before applying any, rejects changes to redacted files, and runs the existing snapshot/scope/check/rollback contract.
- [x] Keep persisted job results and logs free of raw credential values and clean the staging directory on foreground completion/failure.
- [x] Add tests for credential leakage, credential files, `.git` exclusion, atomic write-back, original-workspace preservation, policy evidence, and end-to-end personal writes.
- [x] Update the README and Chinese guide with both skill names, remote routing, disclosure behavior, and write flow.

### Phase 8 acceptance

- `strict` behavior remains unchanged and continues to fail closed for unapproved source disclosure.
- `personal-sanitized` can review and modify ordinary source/data/schema content through the remote Grok route only after explicit task consent.
- Sentinel API keys, private keys, passwords, and tokens are absent from the staged workspace, prompt, Grok handoff, persistent logs, and result payload.
- Grok still cannot invoke Bash, MCP, web tools, Codex plugins, credentials, or host/network commands, and it cannot write the original workspace during a read-only review.
- In write mode Grok cannot write the original workspace directly; only a validated host-applied patch can change it.
- Failed scans, staging errors, policy mismatches, or cleanup failures block delegation and leave the original workspace unchanged.

### Phase 8 verification

- Full plugin suite: `161/161` tests passed.
- Both skill packages passed `quick_validate.py`.
- Plugin manifest validation passed.
- Runtime modules passed `node --check`; `git diff --check` passed with line-ending warnings only.
- Mock Grok end-to-end personal read and write paths completed with verified policy evidence; credential files were absent from staging and clean source changes were applied through the original snapshot contract. Protected/out-of-scope new files are rejected before any write-back.
- Final cachebuster refreshed and local plugin reinstalled as `0.1.0+codex.20260823082218`; installed cache contains both renamed skill entries, passes runtime syntax checks, and matches source SHA-256 for the disclosure, companion, MCP, and Personal skill files.

## Phase 8B: MCP Project-Invocation Reliability

Goal: remove the control-argument regression that prevents bounded Grok jobs
from reaching the companion, then audit the complete MCP-to-worker handoff for
similar schema, normalization, CLI flag, and second-pass policy mismatches.

- [x] Audit every shared MCP control/contract field across schema, policy normalization, CLI serialization, companion parsing, and low-level Grok arguments.
- [x] Fix memory serialization so a policy-enforced disabled object emits only `--no-memory`, never `--memory` or contradictory flags.
- [x] Remove or constrain MCP inputs that the Phase 7 policy always rejects, so Codex is not encouraged to request unsupported capabilities.
- [x] Add combination tests for `normalizeWorkerPolicy -> buildCompanionInvocation` and both Standard/Personal rescue inputs.
- [x] Exercise read-only and write-capable mock worker paths without contacting the remote Grok upstream.
- [x] Run the full suite, syntax/diff/plugin validation, update the cachebuster, reinstall from the confirmed local marketplace, and verify source/cache parity.
- [x] Restart Codex App only after offline acceptance is complete; validate the updated MCP process from a new task (user-side activation remains required after this turn).

### Phase 8B errors encountered

- `node --test <multiple files>` cannot create Node test-runner child processes in the managed Windows sandbox (`spawn EPERM`). Use direct single-process test files for development checks and the approved outer execution path for final full-suite verification.
- The first planning-file patch used a Phase 8 acceptance line that exists in `task_plan.md` but not `progress.md`; the atomic patch was rejected without changing files. Re-anchored the progress update to its actual final entry.
- Two `rg` commands used a quoted alternation that PowerShell reduced to an invalid regular expression. Replaced them with separate `-e` expressions; no source changes resulted from the failed reads.
- Three documentation patch attempts used long or partial README paragraph anchors and failed atomically. Reapplied the README changes with short stable anchors, then updated the Chinese guide separately while preserving the existing FAQ numbering.
- The first full-suite run passed 165/166. The new MCP Personal E2E attempted to resolve a staging directory after successful cleanup and received `ENOENT`; changed the test to assert normalized path separation plus post-run nonexistence.
- Installed-cache `setup` initially reported `doctor exited null` inside the managed sandbox because child process creation was blocked. The approved outer execution path returned `ready=true`, Grok `1.0.5`, authenticated, and doctor passed.

## Phase 8C: Comprehensive Installed and Live Acceptance

Goal: determine whether the current source and installed plugin are operational
end to end, including an observable remote Grok invocation through CC Switch,
without disclosing the current project merely to prove transport.

- [x] Run the complete source test suite and static/plugin/skill validation.
- [x] Verify installed version, source/cache parity, Grok CLI version, authentication, and doctor.
- [x] Exercise the installed companion against a synthetic credential-redaction fixture without remote access.
- [x] Run real read-only Standard and Personal invocations from harmless synthetic projects using the configured `grok-4.6` endpoint, including the `deep` alias, and capture unique markers, job ids, policy evidence, usage, and sessions.
- [x] Verify cleanup and persisted logs/results, then report whether the project is usable and any remaining Codex-host limitation.
- [x] Fix historical `fast`/`deep`/`default`/`grok` aliases that targeted unavailable or unauthenticated models, add a regression test, refresh the cachebuster, reinstall, and revalidate the installed MCP path.

## Phase 8D: Current Grok CLI Compatibility

Goal: ensure the installed Grok 1.0.5 CLI receives only supported launch
arguments, preserve plugin-level contracts such as self-check metadata, and
prevent Personal failures from being silently replaced by local analysis.

- [x] Remove unsupported `--check` and `--best-of-n` launch flags; preserve self-check as a prompt instruction and reject unsupported best-of-N explicitly.
- [x] Add focused regression coverage for Standard/Personal rescue combinations and current CLI argument compatibility.
- [x] Update Standard/Personal skill failure handling and runtime documentation.
- [x] Run the full suite, validate the plugin, refresh/reinstall the cache, and verify source/cache parity.
- [x] Report the required new-task/App restart boundary and the correct inner project path for nested repositories.

## Phase 8D Errors Encountered

- Live Personal job `task-mt5y8mwy-gvj96t` staged successfully but exited before model transport because Grok 1.0.5 rejected the plugin-generated `--check` flag. The persisted result had `model=null`, `grokSessionId=null`, `usage=null`, and stderr `unexpected argument '--check' found`.
- The same CLI rejects `--best-of-n`; it accepts the memory compatibility flag and the current sandbox/permission flags. The plugin must not silently pass unsupported orchestration flags.

## Phase 8E: Task-local external project authorization

- [x] Add explicit Personal scope fields for `once` and `authorizedProject`.
- [x] Reject external-project Personal delegation unless it is task-local `once` and the authorized path exactly matches `cwd`.
- [x] Keep `on`, `off`, and `status` from granting or retaining external project access.
- [x] Update Standard/Personal skills, README, and Chinese usage examples.
- [x] Add composition regression tests, validate, refresh the plugin cache, and reinstall.

### Phase 8E acceptance

- External Personal requests require `personalMode=once`, `authorizedProject`, and an exact path match to `cwd`.
- `on` is limited to the active workspace; `once` authorization is not persisted or inherited by later tasks.
- Staged Personal jobs reapply low-level policy against the isolated staging root while retaining the original authorization evidence.
- Source suite: `172/172` passed; plugin validation and Personal skill validation passed.
- Installed cache: `0.1.0+codex.20260823170211`; source/cache parity `37/37`, zero missing, extra, or mismatched files; setup ready, authenticated, and doctor passed.

### Phase 8E errors encountered

- Python skill validation initially used the Windows GBK default and failed to decode UTF-8 markdown; rerunning with `python -X utf8` passed Personal validation. The unrelated runtime skill retains a pre-existing `user-invocable` frontmatter key rejected by this validator.
- The first implementation rejected staged jobs during the low-level policy recheck because the staging root is distinct from the authorized source root. The recheck now scopes execution to staging and preserves original scope evidence; Personal E2E and full suite pass.

## Phase 8F: Personal active-workspace shorthand and high default

- [x] Make `Personal once/on` in the active workspace imply one-task sanitized disclosure consent.
- [x] Preserve exact `once + authorizedProject` requirements for external projects.
- [x] Default Grok task routes to `grok-4.6 + high`, retaining `fast` as explicit low effort.
- [x] Expose effective effort in task results and add composition/model regression tests.
- [x] Refresh cachebuster, reinstall local marketplace plugin, and verify source/cache parity.

### Phase 8F acceptance

- Full plugin suite: `173/173` passed.
- Plugin manifest and Standard/Personal skill validation passed; runtime syntax and `git diff --check` passed.
- Installed cache: `0.1.0+codex.20260823184022`, installed and enabled from the local `grok-codex-worker` marketplace.
- Source/cache parity: `37/37` files, zero missing, extra, or mismatched SHA-256 entries.
- Installed setup: Grok `1.0.5`, authenticated, doctor passed, `ready=true`.
- Active-workspace Personal `once` now uses implicit task-local sanitized consent; external projects still require exact `once + authorizedProject`.
- Default route is `grok-4.6 + high`; explicit `fast` remains `grok-4.6 + low`.

### Phase 8F errors encountered

- The bundled workspace Python runtime lacked PyYAML; plugin/skill validation was rerun with the local Hermes Python runtime that includes `yaml` and passed.

## Phase 8G: Dedicated Personal Read MCP Boundary

- [x] Diagnose the Codex automatic-approval timeout from persisted task evidence.
- [x] Add a narrowly scoped `grok_personal_read` tool with accurate read-only, non-destructive, open-world annotations.
- [x] Force Personal sanitized staging, fresh/no-memory execution, and `grok-4.6 + high` defaults server-side.
- [x] Keep current-workspace shorthand authorization separate from exact-path external project authorization.
- [x] Route Personal reads through the new tool while retaining `grok_rescue` for Personal writes.
- [x] Pass the full regression and plugin/skill validation suite.
- [x] Refresh the cachebuster, reinstall, and verify installed source/cache parity and setup readiness.

### Phase 8G acceptance

- Full plugin suite: `176/176` passed, including MCP stdio annotation transport and mock Personal staging.
- Source and installed plugin/skill validation passed; runtime syntax and `git diff --check` passed.
- Installed cache: `0.1.0+codex.20260823190654`, installed and enabled from the local `grok-codex-worker` marketplace.
- Source/cache parity: `37/37` files, zero missing, extra, or mismatched SHA-256 entries.
- Installed setup: Grok `1.0.5`, authenticated, doctor passed, `ready=true`.
- Live installed-cache Personal read job completed on `grok-4.6 + high`, staged sanitized source, made no project changes, and returned `contract.verified=true`.

## Phase 8H: Explicit Codex Workspace Scope Contract

- [x] Reproduce the installed-cache current-project misclassification from the real Codex task record.
- [x] Confirm from official Codex MCP documentation that plugin stdio servers start from the plugin directory and do not receive a documented automatic task-workspace root.
- [x] Add an explicit `activeWorkspace` call field and preserve it through MCP preflight, companion CLI, staging, and audit evidence.
- [x] Require current-project calls to use `cwd == activeWorkspace` without `authorizedProject`.
- [x] Require external-project calls to use `cwd != activeWorkspace` plus an exact `authorizedProject == cwd`.
- [x] Add source regression coverage and a real installed-cache stdio regression using a mock Grok transport.
- [x] Run full validation, refresh/reinstall the plugin, and execute the installed-cache regression and installed-runtime readiness smoke.

### Phase 8H acceptance

- Full suite passed `178/178`; the installed-cache regression executed from the real cache with no skips.
- Current project succeeded without `authorizedProject`; an external project was rejected before any additional Grok process, then succeeded with an exact task-local authorization.
- Source/cache full-file SHA-256 parity passed inside the installed-cache regression.
- Installed cache `0.1.0+codex.20260824003826` is enabled; plugin, Standard/Personal skills, runtime syntax, and setup/doctor validation passed.
- Installed setup reports Grok `1.0.5`, authenticated, doctor passed, and `ready=true`.

### Phase 8H errors encountered

- The first combined skill-documentation patch referenced a non-existent context fragment and was rejected atomically. It made no file changes; the patch was split and reapplied against exact lines.
- Focused in-sandbox process tests reported `spawn EPERM`; the complete suite was rerun through the approved elevated `npm.cmd test` boundary and passed.
- The current `quick_validate.py` rejects the runtime skill's pre-existing `user-invocable: false` frontmatter even though the installed plugin uses the same field across internal skills and plugin validation passes. Personal/Standard validation passed; the legacy internal-skill field was preserved to avoid changing invocation behavior outside this fix.
- The first installed-cache regression assumed one mock-binary process per successful request, but runtime CLI preflight plus task execution produced two. Replaced the exact count with a baseline assertion that proves an unauthorized external request starts no additional Grok process.
- Final helper commands initially used a PowerShell-damaged combined `rg` expression and invoked `check-complete.ps1` through Python. Both were command-only errors; reran with separate `rg -e` patterns and PowerShell `-File` successfully.

## Phase 9: OpenAI Codex Harness Reference Audit

Goal: compare the current OpenAI `openai/codex` repository, especially its
harness and execution-control layers, against this project's Grok worker and
identify concrete adoption opportunities without changing runtime code.

- [x] Establish the current upstream revision and official Codex architecture baseline.
- [x] Map upstream harness modules, contracts, lifecycle, sandboxing, approvals, and test infrastructure.
- [x] Map this project's equivalent worker/MCP/control/security/snapshot/job modules.
- [x] Produce a gap analysis ranked as adopt now, adapt later, or deliberately avoid.
- [x] Record source-backed recommendations and validation implications.

### Phase 9 scope

- Read-only research and documentation notes only.
- Preserve all existing uncommitted source changes.
- Do not install, vendor, or copy upstream Codex code into this project.

### Phase 9 errors encountered

- Appending `.md` to the current ChatGPT-hosted Codex documentation URL was blocked by the browser client, and resolving relative `/docs/...` links against `developers.openai.com` produced API-site 404 pages. The Codex documentation home redirects to `learn.chatgpt.com`; subsequent official page reads use that actual host.
- The first sparse checkout configured the selected paths but its checkout phase could not fetch promised blobs under restricted network (`127.0.0.1:9`). Re-ran only `git checkout HEAD` through the approved network boundary; it completed successfully.
- The first local module scan assumed `mcp/` and `scripts/` were repository-root directories. The implementation is nested below `plugins/grok-codex-worker/`; all later reads use the actual plugin root.
- One batched PowerShell line-count command conflicted with the JavaScript template delimiter used by the tool runner. It was replaced with a plain PowerShell `Select-Object` expression.
- Two `rg` calls passed Windows wildcard paths such as `scripts/lib/*.mjs` directly and failed with error 123. Re-ran them against the directory with `-g "*.mjs"`.

## Phase 10: Harness hardening implementation

Goal: implement the two approved harness-hardening stages in order, preserving
all existing behavior and user changes. Stage 2 may start only after Stage 1
passes focused real-process/MCP acceptance and the complete source regression
suite.

### Stage 1: Runtime safety and acceptance

- [x] Establish a clean baseline from the current dirty working tree and record exact test results.
- [x] Serialize write-capable work per canonical target workspace while allowing read/status/cancel concurrency.
- [x] Propagate MCP cancellation to the active companion process and persist request, exit, and closed states without double terminal publication.
- [x] Bound foreground/background output and logs with explicit total/omitted byte evidence.
- [x] Make per-job and progress projections atomic while preserving existing state/result compatibility.
- [x] Add focused scheduler, cancellation, output-bound, atomic-write, crash, and terminal-race tests.
- [x] Pass focused real MCP/child-process acceptance and the complete source suite before Stage 2 starts.

### Stage 1 acceptance

- Final complete suite: `187/187` passed, zero failures and zero skips.
- Real MCP cancellation closed the Grok process tree, restored a modified file from snapshot, published `cancelled_rolled_back`, and exposed `processClosed=true` exactly once.
- Two real companion processes targeting one canonical workspace proved the second writer fails before Grok spawn while reads/status/cancel remain independent.
- A detached background writer finalized automatically without a status/result poll, released its lease, and returned the same terminal record to three concurrent result readers.
- Foreground/background captures and background logs are bounded with retained/omitted byte evidence; per-job, progress, cancellation, result, and shared state projections are atomic.
- Installed cache `0.1.0+codex.20260825050443` passed source/cache parity and real cached MCP stdio coverage inside the zero-skip suite.

### Stage 2: Harness contracts and acceptance

- Status: complete (started only after the recorded Stage 1 zero-skip acceptance).
- [x] Replace separate MCP tool schema/dispatch ownership with one validated canonical tool manifest.
- [x] Introduce a canonical invocation envelope and stable policy fingerprint, persisted through job/result records.
- [x] Add a schema-versioned append-only per-job event journal with contiguous sequence numbers and bounded/redacted payloads.
- [x] Extract a reusable MCP stdio harness and migrate/extend real-process protocol tests.
- [x] Add requested/authority/effective policy evidence without weakening the current forced policy floor.
- [x] Add explicit execution-environment identity and workspace root-set evidence while retaining existing `activeWorkspace` compatibility.
- [x] Update public/runtime documentation and changelog for observable contract changes.
- [x] Pass the complete source suite, plugin/skill validation, installed-cache parity, installed MCP acceptance, and readiness checks.

### Stage 2 source acceptance (pre-install)

- First elevated complete suite: `190/191` passed, zero failures, one expected stale installed-cache skip.
- The new real cross-process journal test produced 41 contiguous events from four competing Node writers and verified sensitive-key redaction plus the 16 KiB line bound.
- The real MCP cancellation regression persisted the full accepted-to-rollback terminal sequence, one terminal event, invocation/request/job identity, policy fingerprint, environment identity, and restored the workspace.

### Stage 2 final acceptance

- Refreshed and reinstalled the local marketplace plugin as `0.1.0+codex.20260825052954`; `codex plugin list` reports it installed and enabled from the repository-local marketplace.
- Final elevated complete suite: `191/191` passed with zero failures and zero skips in 32.55 seconds.
- The installed-cache test compared every plugin file by SHA-256, launched the cached MCP server, and passed current-project, unauthorized-external, authorized-external, invocation, policy fingerprint, environment identity, and contiguous event-journal assertions.
- Plugin validation, Standard and Personal skill validation, source/cache runtime syntax checks, and `git diff --check` all passed. Diff output contains only expected LF-to-CRLF notices.
- Direct setup from the installed cache returned `ready=true`, Grok `1.0.5`, authenticated, version-compatible, and doctor passed.
- Removed six temporary `grok-stage1-background-*` fixtures and stopped their 12 verified pre-fix mock wrapper/cmd processes; no target directories remain.

### Phase 10 constraints

- Preserve all existing uncommitted work and evolve the current implementation in place.
- Keep job/state schema readers backward compatible with existing persisted records.
- Do not add remote relay/Noise machinery or claim stronger native sandbox enforcement.
- Never mark a cancellation terminal until the owned process is confirmed exited or the failure to terminate is recorded explicitly.
- Do not enter Stage 2 until Stage 1 acceptance is recorded as passed.

### Phase 10 Stage 2 errors encountered

- One Windows `rg` command passed `tests/*.test.mjs` as a literal path and failed with error 123. Subsequent searches target the `tests` directory with `-g "*.test.mjs"` or explicit files.
- The first in-sandbox `node --test tests/harness-stage2.test.mjs` run was blocked before loading the test file because the Node test runner could not create its isolated child process (`spawn EPERM`). Stage 2 behavioral checks use the same approved outer `npm.cmd test` path as Stage 1.
- `codex plugin list` succeeded but warned that Codex could not clean one unrelated stale `~/.codex/tmp/arg0` directory because access was denied. The plugin itself was listed installed/enabled at the expected version; this warning was not treated as a plugin failure and the unrelated Codex temp directory was not modified.
- The first old Stage 1 fixture cleanup used a nested PowerShell pipeline whose `$_` variable shadowed the process object, so no process was stopped and the first directory removal failed as in-use. Re-ran with an explicit `$proc` binding, verified every Node/cmd command line, stopped exactly 12 mock processes, and removed exactly six validated Temp roots.
