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

## 2026-08-23 Phase 8 design

- Re-evaluated the policy for personal use with a remote CC Switch -> Grok route.
- Decided that ordinary source, algorithms, business rules, customer data, internal URLs, and database schemas may be eligible for explicit disclosure, while credentials remain blocked.
- Clarified that both the original and personal skills must support read/write tasks. The personal write path will use a sanitized staging worktree and a validated host-applied patch; Grok will never write the original workspace directly.
- The selected implementation is task-local `dataPolicy=personal-sanitized` plus a credential-aware staging copy, explicit skill consent, fail-closed scanning, patch validation, and regression coverage.

## 2026-08-23 Phase 8 implementation

- Renamed the existing UI entry to `Grok Auto (Standard)` and added explicit-only `Grok Auto (Personal)`.
- Added `dataPolicy=personal-sanitized` and `sourceDisclosureConsent=true` to the MCP/CLI contract.
- Added a temporary disclosure staging workspace that excludes credential/protected paths and binaries, redacts API/CD/license keys, private keys, passwords, tokens, JWTs, and connection-string passwords, and leaves ordinary source/data intact.
- Personal read/write tasks keep the existing strict sandbox and host capability denials. Personal writes require foreground execution, a fresh session, `rollbackOnFailure=true`, and an exact changed-file allowlist.
- Personal write-back now preflights every staged change before applying any. Files with original redactions cannot be modified; clean files and safe new files are rescanned, then atomically admitted as a group into the existing snapshot/scope/check/rollback flow.
- Added unit, MCP-policy, and mock Grok end-to-end tests. Final suite passed `161/161`; both skills and the plugin manifest validate; syntax and diff checks pass.
- Updated the final plugin cachebuster and reinstalled the local marketplace plugin as `0.1.0+codex.20260823082218`. Installed-cache inspection confirms `Grok Auto (Standard)`, `Grok Auto (Personal)`, and the final Phase 8 runtime are present; key source/cache SHA-256 values match.

## 2026-08-23 Phase 8B

- Inspected the original failed Codex task and recovered both exact `grok_rescue` argument objects.
- Confirmed the Personal skill loaded and the installed cache matches the Phase 8 source; this is not a stale-cache or app-restart issue.
- Reproduced the failure without launching Grok: policy normalization followed by MCP serialization produces `--memory --no-memory` for a `noMemory=true` rescue request.
- Began a full shared-control audit before applying the fix.
- Multi-file Node test-runner execution is blocked in the managed sandbox by `spawn EPERM`; direct single-file runs execute non-spawning unit cases and confirm the existing composition-test gap.
- Found a second-pass Personal staging failure: MCP-generated allow rules target the original workspace, then become invalid when the companion changes execution to the staging root.
- Found that non-rescue MCP schemas advertise Personal disclosure controls that their invocation builders silently discard.
- Decided to separate MCP validation from CLI serialization, narrow the public schema to supported controls, keep runtime fail-closed checks for legacy/direct callers, and reject Personal fork-session requests.
- Ran a schema/builder differential audit across every MCP tool; began checking the remaining `grok_sessions.sessionId` mismatch and unknown-flag parser behavior.
- Confirmed `grok_sessions.sessionId` is correctly handled for `action=export`; the first differential probe used the search branch and produced a false positive.
- Two initial `rg` audits failed because embedded alternation/quotes were malformed by PowerShell parsing; reran with separate `-e` patterns successfully.
- Audited the disclosure copier and identified large-project staging risks from unbounded file reads and missing conventional build/cache/dependency exclusions.
- Confirmed the existing snapshot layer provides a suitable 10 MiB file-size convention and cache/dependency ignore precedent for disclosure staging.
- Implemented policy-validation/CLI-serialization separation in the MCP server, explicit disabled-memory mapping, safe public control schemas, rescue-only Personal disclosure controls, and Personal fork-session rejection.
- Added conventional generated/dependency/cache exclusions and a 10 MiB disclosure staging limit before file reads.
- Added regression tests for forbidden schema fields, the exact policy-checked rescue composition, memory object serialization, sessions export, Personal fork rejection, and large-project staging exclusions.
- Syntax checks passed for the MCP server, security policy, and disclosure modules. All non-spawning assertions passed (`mcp-tools`: 15, `security`: 6, `disclosure`: 7); only known sandbox-blocked child-process tests failed with `spawn EPERM`/null spawn status.
- Re-ran the two exact Standard/Personal rescue serialization probes; Personal now contains only `--no-memory` and neither path carries generated allow/deny rules.
- Reviewed README, Chinese usage, changelog, and plugin manifest. Existing permission documentation is consistent; added Unreleased notes for the invocation and large-project staging fixes.
- First full elevated suite reached `165/166`; the only failure was a new test calling `realpathSync` after the Personal staging directory had correctly been cleaned. Updated the assertion to compare normalized paths and verify the staging path no longer exists.
- Second full elevated suite passed `166/166`. The new end-to-end MCP Personal read test reached only the local mock Grok, used sanitized staging, omitted `.env`, emitted exactly one `--no-memory`, returned verified policy evidence, and cleaned the staging directory.
- Plugin validation, Standard/Personal skill validation, and `git diff --check` passed. The local marketplace name was validated as `grok-codex-worker` and the previous installed version was confirmed.
- Used the plugin-creator cachebuster helper to update `0.1.0+codex.20260823082218` to `0.1.0+codex.20260823134701`, then successfully reinstalled from the confirmed local marketplace.
- Confirmed `codex plugin list` reports `grok-codex-worker@grok-codex-worker` installed and enabled at `0.1.0+codex.20260823134701`.
- Verified exact source/cache SHA-256 parity for `mcp/server.mjs`, `security.mjs`, `disclosure.mjs`, `grok-companion.mjs`, the Personal skill, and `plugin.json`; all six matched.
- Revalidated the installed cache: plugin validation passed, both skill validations passed, and installed runtime syntax checks passed.
- Installed-cache setup passed outside the managed child-process sandbox: Grok `1.0.5`, authenticated, doctor passed, and `ready=true`.
- Confirmed the current task still exposes the pre-reinstall MCP schema. Official OpenAI plugin documentation states installed skills and MCP tools are loaded by new tasks/sessions, so a full App exit/relaunch followed by a new task is the remaining activation boundary.

## 2026-08-23 Phase 8C

- Started comprehensive source, installed-cache, and live transport acceptance after the user reported no recent Grok 4.6 trace at the upstream relay.
- The live proof will use a temporary synthetic project containing no user source or credentials and a unique response marker, so transport can be verified without broadening disclosure.
- Current-task MCP discovery confirms the restarted App loaded the narrowed schema: `agent`, caller `allow`, and enabled `memory` are absent; `noMemory` and `dataPolicy` are present.
- `codex plugin list` reports version `0.1.0+codex.20260823134701` installed and enabled. All 37 source plugin files match all 37 installed-cache files by relative path and SHA-256.
- Full elevated source suite passed `166/166` in 12.47 seconds. Source/cache plugin validation, both source skill validations, four critical runtime syntax checks, and `git diff --check` all passed.
- Direct installed-cache setup and current MCP `grok_setup` both returned `ready=true`: Grok `1.0.5`, version requirement satisfied, authenticated, and doctor passed. Both resolved plugin root `0.1.0+codex.20260823134701`.
- A planning-file update patch initially had malformed multi-file hunk syntax and was rejected atomically; the corrected patch applied without touching runtime files.
- Installed disclosure staging passed against a synthetic secret fixture: `.env` excluded, embedded fake API key redacted, ordinary `package.json` preserved, and the temporary stage cleaned.
- First live MCP job `task-mt5wax7l-o2erx5` failed before model transport with `Grok is not authenticated`; no session or usage was created, so no upstream trace is expected for that attempt.
- Live Personal read job `task-mt5wd105-0vwpwm` succeeded on explicit `grok-4.6`, returned the exact unique marker, created Grok session `01a02f00-ee2e-7a12-92c0-ce77bec5a45a`, recorded two upstream model calls and `$0.026698`, and passed worker policy/completion verification.
- Live Standard read job `task-mt5wemrt-1w0hl0` succeeded with no model override; the configured default resolved to `grok-4.6`, returned the exact marker, recorded two model calls and `$0.0295`, and verified successfully.
- Live Personal write job `task-mt5wfbox-5xg493` reached `grok-4.6` but stopped as `cancelled` after one model call. No expected file was created; the no-change contract failed closed and rollback verification found zero residual changes.
- Full source suite after the model-route fix passed `167/167`; the added regression exercises the final CLI flags for `deep`, `default`, and `grok` aliases.
- `grok models` showed `grok-4.6` as the default and `grok-4.5` as an available-but-unauthenticated route. Direct probes reproduced a 401 for `grok-4.5` and a successful response for `grok-4.6`.
- Updated runtime aliases so `fast`, `deep`, `default`, and `grok` resolve to `grok-4.6`; `fast` preserves its intent with `low` effort. Updated the runtime skill and model error guidance accordingly.
- Refreshed and reinstalled the plugin as `0.1.0+codex.20260823144122`. Installed validation, both skill validations, setup/doctor, and all 37 source/cache SHA-256 comparisons passed.
- Installed-cache Standard `deep` smoke `task-mt5x3i6d-jxjii7` returned `model=grok-4.6`, session `01a02f13-c74b-7b60-9357-9886993b08e0`, usage/cost `$0.030004`, and `verified=true`.
- Installed-cache Personal `deep` smoke `task-mt5x3i97-g95x5v` returned `model=grok-4.6`, session `01a02f13-c7db-7f52-b240-d104aab5fde7`, usage/cost `$0.03658`, `sourceStaged=true`, and `verified=true`; its temporary staging workspace was cleaned.
- Installed-cache MCP stdio smoke `task-mt5x5u3b-klbk6l` returned the exact marker `MCP_LIVE_20260823`, `modelUsage.grok-4.6`, cost `$0.020222`, strict policy evidence, and `contract.verified=true`.
- Final cache after the `fast` alias adjustment is `0.1.0+codex.20260823145145`; source/cache parity remains 37/37 with no missing, extra, or mismatched files, and setup/doctor remains `ready=true`.
- Final-cache `fast` smoke `task-mt5xff47-s4cnf5` returned `LIVE_FAST_20260823`, session `01a02f1c-4222-7310-98c9-0581add4bf23`, `modelUsage.grok-4.6`, cost `$0.019262`, and `verified=true`.
- Final-cache MCP `fast` smoke `task-mt5xg42u-1pcv4o` returned `MCP_FAST_20260823`, session `01a02f1c-c07d-7ad0-8a31-fa491d717bdf`, `modelUsage.grok-4.6`, cost `$0.018996`, and `contract.verified=true`.
- The remaining activation boundary is a full Codex App exit/relaunch followed by a new task, so an already-running MCP process cannot retain the previous cache version.

## 2026-08-23 Phase 8D

- Reproduced the reported Personal failure from persisted job `task-mt5y8mwy-gvj96t`: the staging/policy path completed, but Grok 1.0.5 exited with code 2 on unsupported `--check` before session creation.
- Confirmed the installed CLI also rejects `--best-of-n`; `--no-memory`, `--worktree-ref`, sandbox/permission, deny, and reasoning-effort aliases parse successfully.
- The next implementation step is to separate plugin contracts from low-level Grok CLI arguments, add explicit compatibility tests, and require Personal skills to stop on raw delegation failures.

- Removed `--check` and `--best-of-n` from low-level Grok argv. `check=true` now adds a completion-prompt self-check instruction; `bestOfN > 1` fails before creating a job with an explicit installed-CLI compatibility error.
- Added regression coverage for argv filtering, self-check prompt generation, unsupported-flag diagnostics, Personal `check=true` mock transport, and pre-job best-of-N rejection.
- Updated Personal failure handling guidance to relay raw Grok errors without local substitute analysis, plus README/runtime/changelog documentation.
- Full source suite passed `170/170`; source manifest and Standard/Personal skills validated; `git diff --check` passed.
- Refreshed and reinstalled as `0.1.0+codex.20260823154310` from the configured `grok-codex-worker` marketplace. Installed plugin validation, Standard/Personal skill validation, runtime syntax checks, and complete source/cache SHA-256 parity (`37/37`, zero mismatches) passed.
- The default `personal` marketplace contains only `cowart`; reinstalling from it correctly failed. The plugin is installed/enabled from the repository-local `grok-codex-worker` marketplace.
- After the final routing-skill correction, refreshed/reinstalled again as `0.1.0+codex.20260823154719`; final installed setup reports Grok `1.0.5`, authenticated, doctor passed, and `ready=true`. Final source/cache parity remains `37/37` with zero mismatches.
- A direct installed-cache compatibility assertion passed with an active project cwd: `check=true` and `bestOfN` produce no unsupported Grok CLI flags, while `bestOfN > 1` fails closed.

## 2026-08-24 Phase 8E start

- User selected a stricter task-local scope: only `once` may authorize an external project; `on` must not retain external project paths, and `off`/`status` must not read projects.
- Existing Personal runtime has no project authorization field, so the change requires a scope contract in the MCP rescue schema, companion validation, skill instructions, and regression coverage.

## 2026-08-24 Phase 8E complete

- Added `personalMode` (`on|once`) and `authorizedProject` to the Personal rescue contract.
- External `cwd` now fails closed unless the request is `once` and the authorization path exactly matches the target project.
- Personal staging low-level policy rechecks are scoped to the temporary stage while preserving original project authorization evidence.
- Updated Personal skill, runtime skill, README, Chinese usage guide, changelog, and focused regression tests.
- Full suite passed `172/172`; plugin validation passed; Personal skill validation passed under UTF-8 mode.
- Refreshed and reinstalled local marketplace cache `0.1.0+codex.20260823170211`; source/cache parity is `37/37` with zero mismatches.
- Installed-cache setup reports Grok `1.0.5`, authenticated, doctor passed, `ready=true`; installed scope smoke rejected external `on` and accepted exact-path `once`.

## 2026-08-24 Phase 8F

- Changed Personal `once`/`on` active-workspace routing to imply one-task credential-redacted disclosure consent; external projects still require exact `once + authorizedProject` scope.
- Changed default task/model routing to `grok-4.6 + high`; `fast` remains an explicit `grok-4.6 + low` preset and `deep/default/grok` resolve to high.
- Added effective `effort` to task result payloads and added MCP/model/disclosure combination tests.
- Focused/full-in-process regression run passed `173/173`; syntax and diff checks passed.
- Plugin manifest and Standard/Personal skill validation passed with the local Python runtime containing PyYAML.
- Fixed the policy-evidence regression so active-workspace shorthand consent (`disclosureConsent=personal-mode-scope`) passes the worker policy while still requiring staged source.
- Full elevated `npm.cmd test` passed `173/173`.
- Refreshed and reinstalled the local marketplace plugin as `0.1.0+codex.20260823183422`.
- Source/cache SHA-256 parity is `37/37` with zero mismatches; `codex plugin list` reports installed and enabled.
- Installed setup reports Grok `1.0.5`, authenticated, doctor passed, and `ready=true`.
- Clarified MCP schema and Personal skill wording so active-workspace `once/on` never asks for a second consent sentence; only external `cwd` requires `once + authorizedProject`.
- Refreshed and reinstalled again as `0.1.0+codex.20260823184022`; source/cache parity remains `37/37` with zero mismatches and setup remains `ready=true`.

## 2026-08-24 Phase 8G

- Traced the reported `automatic permission approval review did not finish` result to the static destructive annotation on `grok_rescue`; the failure happened before job creation and model transport.
- Added `grok_personal_read`, refactored task CLI serialization for reuse, and added it to the read-only worker classification.
- Updated Personal and runtime skills so current-workspace reads omit `authorizedProject`, external reads require an exact path, and Personal writes continue through `grok_rescue`.
- Added focused annotation, schema, forced-default, external-scope, memory-serialization, mock staging, and stdio tool-list coverage.
- Full elevated regression suite passed `176/176`; plugin, Standard skill, Personal skill, syntax, and diff validation passed.
- Refreshed and reinstalled as `0.1.0+codex.20260823190654`; `codex plugin list` reports installed and enabled.
- Source/cache SHA-256 parity is `37/37` with no missing, extra, or mismatched files; installed plugin and both skills validate.
- Installed-cache setup reports Grok `1.0.5`, authenticated, doctor passed, and `ready=true`.
- Live installed-cache Personal read `task-mt66kssl-4kkgs8` returned `PERSONAL_READ_BOUNDARY_OK_20260824` on `grok-4.6 + high`; session `01a03006-c015-7062-91bd-20bd1d196037`, three model calls, `$0.038102`, `sourceStaged=true`, zero changes, and `contract.verified=true`.

## 2026-08-24 Phase 8H

- Inspected real task `01a03118-8cbb-7163-91d2-e0c39d8596ba`: current project `E:\APP\ProjectConcept\AutoCut` was rejected once, then retried with an unnecessary same-path `authorizedProject` and completed.
- Confirmed the root cause in MCP `runCompanion()`: `process.cwd()` represents the installed plugin cache, not the Codex task workspace.
- Selected an explicit per-call `activeWorkspace` contract so current and external targets remain distinguishable without weakening exact external-project authorization.
- Designed two-layer propagation: public MCP schema -> MCP preflight -> `--active-workspace` -> companion preflight -> persisted policy evidence.
- Defined the installed-cache regression as a real cached-server stdio run with mock model transport, not only a source-module unit test.
- Added `activeWorkspace` to Personal MCP schemas and serialization, companion parsing, persisted job config, normalized/summarized worker policy, and staging-policy evidence restoration.
- Current-project Personal calls now reject any `authorizedProject`; external calls require `once` plus an exact canonical authorization while retaining the original Codex workspace identity.
- Added `tests/installed-cache.test.mjs`: it resolves the installed cache from the source manifest version, checks full plugin SHA-256 parity, starts the cached MCP server over NDJSON, and exercises current success, external denial, and exact external authorization with a mock Grok binary.
- Updated README, Chinese usage guide, runtime/Personal skill instructions, and changelog to require `activeWorkspace=environment_context.cwd` rather than inferring it from the plugin process.
- Full elevated source suite passed `177/178` with zero failures; the one skip is the intentionally stale pre-reinstall cache regression. All Personal MCP/read/write and NDJSON subprocess tests passed.
- Runtime JS syntax, plugin validation, Standard skill validation, Personal skill validation under Python UTF-8 mode, and `git diff --check` passed. Runtime-skill-only quick validation remains incompatible with its existing `user-invocable: false` metadata; plugin validation accepts the package.
- Refreshed the plugin cachebuster with the plugin-creator helper and reinstalled from the confirmed local `grok-codex-worker` marketplace as `0.1.0+codex.20260824003826`.
- The first installed-cache run reached the cached MCP server successfully but exposed an over-specific mock invocation-count assertion; changed it to prove the unauthorized request adds zero processes while authorized calls do reach the mock.
- Real installed-cache regression passed with full source/cache parity and all three current/external scope cases.
- Final elevated suite passed `178/178` with zero failures and zero skips.
- Installed plugin and Standard/Personal skill validation, four installed runtime syntax checks, `codex plugin list`, and `git diff --check` passed.
- Installed-cache setup returned `ready=true`, Grok `1.0.5`, authenticated, doctor passed, and resolved the new cache root.
- Final source references and manifest version were confirmed; `git diff --check` remains clean. The planning helper reports the long-lived repository plan as in progress because earlier project phases remain represented, while the Phase 8H checklist and acceptance items are complete.

## 2026-08-25 Phase 9 start

- Started a read-only comparison of `openai/codex` against the Grok Codex Worker, with emphasis on harness architecture and execution guarantees.
- Confirmed the working tree already contains user changes; this audit will only append research notes and will not alter runtime code.
- Initial local baseline: the project already has explicit MCP/companion boundaries, policy normalization, process isolation, snapshots/rollback, completion contracts, jobs, and disclosure staging that should be compared to upstream by responsibility rather than by filename.
- Official Codex documentation baseline captured: sandbox and approvals are orthogonal; workspace-write/on-request is the normal bounded profile; auto-review changes the reviewer without widening the sandbox; full access removes that boundary.
- Shallow-cloned the public upstream into a temporary audit directory and fixed the source baseline at commit `9c9675d3d038d9e827875c6bdceb2c6d68439dfc`.
- Completed the first upstream responsibility map across core tool routing, approvals/policy/sandboxing, unified process execution, platform sandboxes, typed protocol, rollouts/traces, and app-server.

## 2026-08-25 Phase 9 complete

- Completed a responsibility-by-responsibility comparison of upstream Codex harness mechanics against the plugin's MCP, companion, security/control, process, jobs, contracts, snapshot, disclosure, and stdio-test layers.
- Confirmed the project already has strong fail-before-spawn policy checks, explicit Personal workspace authorization, disclosure staging, environment/host-tool isolation, write snapshots and rollback, atomic shared state/result publication, and real MCP stdio coverage.
- Identified the highest-value gaps: no canonical tool manifest, no single invocation identity/policy fingerprint, no per-workspace write scheduler, ignored MCP cancellation, no propagated cancellation token, mutable state without an append-only event journal, and unbounded background output/log accumulation.
- Ranked recommendations into adopt now, adapt later, and deliberately avoid. The implementation order starts with manifest/identity/scheduling, then cancellation/state, event/output handling, and a reusable end-to-end MCP harness.
- Kept the audit read-only with respect to runtime code. Only `task_plan.md`, `findings.md`, and `progress.md` received Phase 9 research updates; all pre-existing user changes were preserved.

## 2026-08-25 Phase 10 start

- User authorized the two-stage harness hardening implementation and required real acceptance after Stage 1 before Stage 2 begins.
- Recovered the long-lived project plan and confirmed the working tree already contains the completed Personal-routing/security work; those edits will be preserved and extended in place.
- Added explicit Stage 1 and Stage 2 acceptance gates, backward-compatibility constraints, and a no-remote-relay/no-sandbox-overclaim boundary.
- Baseline elevated `npm.cmd test` passed `178/178` with zero failures/skips in 9.28 seconds. It exercised real child processes, MCP NDJSON transport, installed-cache parity/scope, concurrent state updates, snapshots, rollback, and Personal staging before Phase 10 runtime edits.
- Added the Stage 1 process-control foundation in `process.mjs`: bounded head/tail capture with byte accounting, async child execution, AbortSignal/timeout handling, Windows `.cmd` support, process-tree termination, and close confirmation while retaining the existing synchronous API.
- `node --check plugins/grok-codex-worker/scripts/lib/process.mjs` passed. Added focused real-child tests for bounded capture, confirmed abort closure, and timeout closure in `tests/process.test.mjs`.
- The first in-sandbox focused run was blocked before assertions by the known Windows `spawn EPERM` test-runner boundary. The first elevated filtered `npm.cmd test` attempt also did not enter Node because `cmd.exe` interpreted the regex `|` as a pipeline; subsequent real runs use the complete approved suite or shell-safe filters.
- The first Stage 1 integration run reached `179` passes, `1` failure, and `1` stale-cache skip. The only failure was an old source-shape assertion for unbounded `textAcc`/`thoughtAcc`; runtime/process, contract, Personal staging, MCP stdio, rollback, and security tests passed. Updated the assertion to require bounded `HeadTailBuffer` capture and `outputStats` evidence.
- The first dedicated Stage 1 acceptance run reached `183` passes, `1` failure, and `1` stale-cache skip. The real MCP cancellation already produced `cancelled_rolled_back`; the only missing assertion was response-level propagation of the persisted `cancellation.processClosed` evidence. Added `cancellation` and `outputStats` to the foreground response projection.
- The cross-process write scheduler acceptance passed: a second companion writer was rejected while the first held the canonical workspace lease. The first background auto-finalization acceptance exposed that the embedded Windows worker still spawned `.cmd` directly; updated it to embed and reuse the same quoted `.cmd/.bat` resolution used by the foreground process layer.
- After the Stage 1 cache refresh, the installed-cache regression ran with no skip. All runtime assertions passed; the only failure was Windows temporary-directory cleanup racing the still-exiting background wrapper after its terminal job had already been published. The acceptance now explicitly waits for and verifies wrapper PID exit before cleanup.
- Elevated read-only process inspection identified the actual leak: the outer Node background wrapper was still waiting on a child `cmd.exe` after the mock Node process had exited. Updated the shared `.cmd/.bat` resolver to use `cmd.exe /c call ...`, which guarantees control returns from the batch script and allows the parent close event to complete.
- Completed the Stage 1 acceptance gate after adding `windowsHide: true` to the embedded Windows background child. Focused scheduler/background tests passed `2/2`; the final elevated suite passed `187/187` with zero failures and zero skips in 11.06 seconds.
- Refreshed and reinstalled the local plugin as `0.1.0+codex.20260825050443`. The installed-cache parity and real cached MCP stdio regression ran successfully inside the final suite.
- Stage 2 is now authorized to begin because Stage 1 acceptance has been recorded as passed.

## 2026-08-25 Phase 10 Stage 2 start

- Recovered the accepted Stage 1 state and confirmed the `187/187` zero-skip gate and installed cache `0.1.0+codex.20260825050443` before touching Stage 2.
- Re-read the `planning-with-files` and `plugin-creator` update instructions; the final gate will validate the repository marketplace name, refresh the cachebuster with the helper, reinstall through Codex CLI, and rerun installed-cache acceptance.
- Confirmed the dirty worktree contains the prior Personal/security and Stage 1 changes. Stage 2 will extend them in place and preserve schema-v3 job/state compatibility.
- Began the canonical manifest, invocation envelope, policy-composition evidence, event journal, and reusable MCP harness audit.
- Added `scripts/lib/invocation.mjs` with stable canonical JSON, SHA-256 fingerprints, invocation IDs, canonical workspace root sets, execution-environment identity, and internal evidence parsing.
- Replaced MCP switch-owned dispatch and split write classification with a validated canonical manifest that drives definitions, serializers, capabilities, approval class, policy preflight, and spawn behavior.
- Added requested/authority/effective policy evidence while preserving the forced policy floor and existing `workerPolicy` compatibility field.
- Added a locked append-only per-job NDJSON journal with contiguous sequence numbers, sensitive-key redaction, bounded payloads, cursor reads, and lifecycle emission across foreground/background/cancellation/rollback paths.
- Extracted `tests/helpers/mcp-harness.mjs` and migrated installed-cache plus source stdio tests to the shared real-process client.
- `node --check` passed for the invocation, security, jobs, MCP server, and companion modules after the first integration pass.
- The first focused Node test command was blocked before assertions by the known managed-Windows `spawn EPERM` boundary; recorded it and switched to the real outer full-suite path.
- First elevated Stage 2 complete suite passed `190/191` with zero failures. The only skip was the deliberate stale installed-cache gate before cachebuster refresh/reinstall.
- Real acceptance covered four cross-process event writers, canonical manifest validation, policy fingerprint stability, source MCP NDJSON, cancellation/rollback, and all prior security/Personal/snapshot regressions.
- Updated README, Chinese usage guide, and changelog with manifest ownership, invocation/policy/environment evidence, per-workspace write serialization, confirmed cancellation, bounded atomic projections, and append-only lifecycle logs without overstating Windows sandbox guarantees.
- Plugin/Standard skill/Personal skill validation, runtime syntax checks, and `git diff --check` passed before reinstall.
- Used the plugin-creator flow to confirm marketplace `grok-codex-worker`, refresh the cachebuster, and reinstall `0.1.0+codex.20260825052954` into the real Codex cache.
- Final elevated suite passed `191/191` with zero failures/skips in 32.55 seconds, including whole-cache SHA-256 parity and cached MCP Stage 2 evidence assertions.
- Installed-cache `setup --json` returned `ready=true`, Grok 1.0.5, authenticated, and doctor passed. `codex plugin list` reports the plugin installed and enabled.
- Cleaned six old pre-fix Stage 1 temp fixtures after verifying exact command lines: stopped 12 mock Node/cmd processes and removed all six `grok-stage1-background-*` directories.
