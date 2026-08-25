# Findings

- Upstream used Unix `which`; Windows needs `where.exe` and explicit `.exe/.cmd` candidates.
- Upstream completion status trusted Grok exit code and could report `completed` without a plan/document file.
- A local marketplace is recognized by Codex when added from the repository root containing `.agents/plugins/marketplace.json`.
- The fork uses plugin name `grok-codex-worker` so the original cache remains untouched.
- Use the configured model/profile `grok-4.6` in this environment. The historical `grok-4.5` entry may appear in the CLI model list but is not authenticated on this CC Switch route and returns 401.
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

## Phase 8 design findings

- The local `grok.exe` is only the process launcher; the documented route is `grok.exe -> CC Switch -> remote Grok upstream`. A local binary path cannot attest that inference is offline.
- The current worker protects the child environment and persistent logs, but it does not redact source contents before the model reads them. Project-local `.env`, key files, and embedded literals therefore require a separate data-disclosure policy.
- Read-only is an execution constraint (`Edit/Write` denied), not a data-egress constraint. Ordinary source disclosure must be controlled by a separate task-local consent and staging policy.
- For the stated personal-use scope, allowing algorithms, business rules, customer data, internal URLs, and database schemas is compatible with a narrowly scoped `personal-sanitized` mode, provided credential material is excluded or deterministically replaced.
- Both skills should remain capable of reads and writes. The original skill can retain its current direct workspace write contract; personal-mode writes require a sanitized staging worktree and a host-side validated patch because redaction placeholders cannot safely be written back to the original files.
- A conservative first write rule should reject changes to any file that contained redactions or was excluded as sensitive. New files and clean files can be applied after a second secret scan, scope check, snapshot check, and configured test command.
- Secret scanning cannot prove absence of all sensitive data. The design must fail closed on uncertain files and make the remote destination and redaction evidence visible before each opted-in delegation.
- Execution isolation remains necessary even in personal mode: remote source disclosure does not authorize Bash, MCP, browser, credential, upload, or host-tool access.

## Phase 8B invocation findings

- The failed Codex task did invoke `grok_rescue` twice with the correct `personal-sanitized` consent. Neither request supplied an agent or enabled memory; the retry explicitly supplied `noMemory=true`.
- `normalizeWorkerPolicy()` represents the enforced disabled state as `memory: { enable: false }`, while MCP `appendControlArgs()` treats any truthy `input.memory` as an enabled boolean flag. The real handoff therefore emits `--memory`; with an explicit retry it emits both `--memory` and `--no-memory`.
- The companion parses the generated `--memory` as `memory=true` and its second policy pass correctly rejects it as forbidden custom-agent/cross-session-memory delegation. Grok never starts.
- Source and installed-cache hashes match for the MCP server, policy/control modules, companion, and Personal skill. Restarting the app cannot correct the defect until the source is fixed and reinstalled with a new cachebuster.
- Existing tests cover raw MCP boolean mapping and policy normalization independently, but omit their composition. A regression test must exercise the exact normalized object passed by `runCompanion()` into `buildCompanionInvocation()`.
- Because `appendControlArgs()` is shared by rescue, plan, reviews, workflow runs, design, execute-plan, babysit mutations, and document jobs, the serialization defect is broader than Personal mode.
- Serializing the complete policy-normalized object at the MCP boundary also leaks generated workspace `allow` rules into the companion CLI. Standard keeps the same `cwd`, but Personal later changes `cwd` to the staging root; the second policy pass would reject the original-workspace allow rules as widening even after memory is fixed.
- MCP should use its first policy pass for validation, then serialize the caller contract plus resolved `cwd`. The trusted companion must independently generate the effective sandbox, allow/deny rules, disabled memory, and other policy-floor fields for its actual execution workspace.
- `dataPolicy` and `sourceDisclosureConsent` are currently included in `COMMON_JOB_PROPERTIES`, so plan/review/design/workflow/document schemas advertise them even though only the rescue switch serializes them. This is a dangerous false contract: Personal disclosure must be exposed only on `grok_rescue`, as required by the Personal skill.
- Public MCP schemas still advertise `agent`, `memory`, and caller `allow` even though Phase 7 always rejects them. Removing these impossible inputs from the model-facing schema will reduce invalid calls while keeping defensive runtime rejection for direct/legacy callers.
- Personal mode says it always starts fresh, but `forkSession` is not currently rejected alongside resume/worktree options. The Personal policy needs an explicit fork-session rejection.
- A schema-to-builder differential audit confirmed `cwd` and `hostToolRequired` are intentionally consumed by the MCP host rather than serialized. Its initial `grok_sessions.sessionId` warning was branch-sensitive noise: the export branch correctly serializes the id; add explicit export coverage rather than changing production behavior.
- `parseArgs()` treats unknown long options as positionals instead of rejecting them. Builder/parser drift can therefore alter a Grok prompt or subcommand silently; regression coverage must verify every public property is either host-consumed or serialized into a flag recognized by the destination command.
- Personal staging excludes `node_modules` and credential/tool metadata, but currently traverses common generated/dependency trees such as `.venv`, `dist`, `build`, `.next`, `coverage`, and caches. It also reads every candidate file fully before deciding whether it is text and has no per-file size ceiling.
- Large personal projects can therefore become slow or memory-heavy immediately after the MCP argument bug is fixed. Default staging should omit conventional dependency/build/cache outputs and skip oversized files with manifest evidence while retaining ordinary source, schemas, SQL, configs, and documentation.
- Current disclosure tests cover credential removal and write-back safety but not generated-directory exclusion or oversized-file behavior.
- The snapshot subsystem already uses a 10 MiB per-file default and dependency/cache exclusions; disclosure staging can mirror that established project convention instead of inventing a separate limit.
- Disclosure cleanup currently suppresses filesystem removal errors. This leaves no raw credential values in the stage, but it can leave an ordinary-source staging directory behind; cleanup assurance should be reported accurately and revisited separately from the invocation blocker if deterministic Windows removal proves necessary.

## Phase 8B implementation confirmation

- The policy-checked Standard read invocation now serializes as `task --read-only <prompt>` with no generated memory, allow, deny, or sandbox flags at the MCP boundary; the companion independently enforces them.
- The corresponding Personal read invocation serializes exactly one `--no-memory` when requested, plus `--fresh`, disclosure policy, and consent. It does not emit `--memory` or original-workspace allow rules.
- Keeping `buildCompanionInvocation()` able to consume the internal `{ enable: false }` representation provides a defensive compatibility layer, while `runCompanion()` no longer serializes policy-generated state at all.
- The reinstalled cache at `0.1.0+codex.20260823134701` is byte-identical to the source for all six invocation-critical files checked, and its direct setup reports Grok ready/authenticated.
- The current Codex task still advertises old rejected MCP fields (`agent`, `memory`, caller `allow`), proving its MCP process predates the reinstall. A new task after a full App restart is required to observe the narrowed schema.
- `codex plugin list` emitted an access-denied warning while cleaning a stale Codex `arg0` temp directory, but still resolved the marketplace and reported the plugin installed/enabled. This warning is unrelated to Grok worker argument serialization or authentication.

## Phase 8C test strategy

- Offline mock tests prove argument and policy composition but cannot produce a CC Switch/upstream usage trace.
- A harmless synthetic workspace is sufficient to prove the installed companion, credential staging, Grok CLI authentication, model transport, and result finalization while avoiding disclosure of the current dirty project.
- The local `grok.exe` is the launcher and the configured `grok-4.6` profile is the authenticated CC Switch route; the relay remains authoritative for the final upstream model identity.
- The current task is no longer bound to the stale pre-reinstall MCP server; its public rescue schema matches Phase 8B and the complete source/cache tree has zero mismatches.
- The first live request exposed a model-profile drift rather than a global authentication failure. `~/.grok/config.toml` defines only the CC Switch profile `model."grok-4.6"`; explicit `grok-4.5` therefore used an unauthenticated route even though setup/model discovery listed it.
- Omitting the model is currently safe for ordinary calls: `normalizeModel(null)` preserves the CLI default, and a live Standard job resolved through the configured `grok-4.6` profile.
- Real read transport is proven. The first real write attempt reached Grok 4.6 but produced no tool result and was cancelled; the plugin's expected-file, actual-change, and rollback contracts behaved correctly, but write usability still requires diagnosis.
- Runtime aliases `fast`, `deep`, `default`, and `grok` previously targeted unavailable or unauthenticated models, which made automatic rescue/plan/design calls fail before model transport. They now resolve to the configured `grok-4.6` endpoint; `fast` uses `low` effort, covered by an integration regression.
- Installed-cache MCP stdio transport has now been proven end to end with a synthetic workspace: tools were discovered, `grok_rescue` reached the upstream, and the result carried `modelUsage.grok-4.6` plus verified strict policy evidence.
- The final installed cache also proves the `fast` alias through both direct companion and MCP calls; both resolved to `grok-4.6` and returned verified usage instead of the prior unknown-model failure.

## Phase 8D findings

- The failed Personal invocation was not blocked by disclosure policy or staging: `sourceStaged=true`, `dataDisclosure=personal-sanitized`, `disclosureConsent=explicit`, and `policy.ok=true` were all recorded before launch.
- Grok Build `1.0.5` rejects `--check` and `--best-of-n` at argument parsing. Because the failure occurs before a session is created, no model, session id, usage, or upstream trace can exist for that job.
- `check` is a plugin-level self-check request, not a supported Grok CLI option. It must be represented in the task prompt and persisted contract metadata, while host-side `checkCommand` remains the executable verification mechanism.
- Personal routing must relay a failed `grok_rescue` result as-is and stop; the host model must not silently substitute a local source analysis after Grok fails.
- `E:\APP\MoneyPrinterTurbo` is an outer wrapper containing the actual Git repository at `E:\APP\MoneyPrinterTurbo\MoneyPrinterTurbo`. Personal staging currently copies the requested cwd, so the inner repository path should be used for focused analysis.

## Phase 8E findings

- A skill-level `once 授权项目：<path>` phrase is useful only if it is carried into an explicit worker contract; natural-language state alone cannot constrain an MCP call.
- The Personal rescue schema now carries `personalMode` and `authorizedProject`; the MCP server compares the requested `cwd` with the active MCP workspace and treats a different path as external.
- External Personal delegation is accepted only for `personalMode=once` with an exact canonical path match. `on` cannot carry `authorizedProject`, preventing long-lived cross-project scope.
- `off` and `status` remain skill-state operations and do not call MCP or read projects. A new task starts without any external authorization.
- Personal staging introduces a second policy pass against a temporary root. That pass must not reinterpret the stage as a newly authorized project; it uses stage-local execution scope while retaining original authorization metadata in the job evidence.

## Phase 8F findings

- The previous consent prompt was caused by the Personal disclosure contract, not by current-project path authorization. The active workspace can safely use task-local `once`/`on` scope as the explicit Personal route; external projects still need an exact path authorization.
- `normalizeWorkerPolicy()` now validates Personal project scope before normalizing disclosure consent, allowing scoped consent only for the active workspace or an exact external `authorizedProject`.
- MCP Personal rescue shorthand fills `dataPolicy=personal-sanitized`, source disclosure consent, `model=grok-4.6`, and `effort=high` when the caller omits them. The companion also defaults all task routes to `grok-4.6 + high`; `fast` remains low.
- Task result payloads now expose effective `effort`, so model usage can be audited without inferring it from token counts.

## Phase 8G findings

- The failed Personal test did reach `grok_rescue`, but its static MCP annotations were `destructive=true` and `readOnly=false` even though the call arguments requested `readOnly=true`.
- Codex therefore launched the high-risk automatic approval reviewer. That reviewer exceeded its deadline before approving or rejecting, so no Grok job, session, or upstream model call was created.
- MCP annotations are tool-level rather than argument-dependent. A mixed read/write tool cannot accurately advertise both paths, so the stable fix is a separate read-only Personal tool rather than weakening approval policy.
- `grok_personal_read` exposes only prompt, workspace/external authorization, model/effort, max turns, self-check, and JSON output. The server forces the remaining disclosure and execution controls.
- `openWorldHint=true` is intentional: the tool is non-destructive locally but sends the sanitized staging copy to the configured remote Grok upstream.

## Phase 8H findings

- The real Codex task workspace was `E:\APP\ProjectConcept\AutoCut`, and the first `grok_personal_read` call correctly passed that value as `cwd` without `authorizedProject`.
- The installed MCP server nevertheless rejected it as external because `runCompanion()` supplied `activeWorkspace=process.cwd()`. For a plugin-provided stdio server, that process directory is the installed plugin cache, not the task workspace.
- The second call succeeded only after Codex added `authorizedProject` equal to the current project. Its final evidence was internally inconsistent (`externalProject=false` with a non-null current-project authorization) because `activeWorkspace` was not serialized to the companion process.
- Official Codex MCP documentation documents plugin-relative server launch and the stdio `cwd` setting, but not automatic task workspace roots for plugin MCP servers. The workspace must therefore be an explicit per-call contract rather than inferred from the server process directory.
- The selected contract carries `activeWorkspace` from Codex `environment_context.cwd` on every Personal MCP call. `cwd` remains the disclosure target: equality means current project; inequality means external project and activates exact-path authorization.
- `activeWorkspace` must be serialized as `--active-workspace` so companion preflight and persisted `workerPolicy` use the same classification as MCP preflight.
- The real installed-cache regression will compare source/cache contents, start the cached MCP server over NDJSON, use a mock Grok binary, verify a current-project call succeeds without authorization, and verify an external call fails unless exactly authorized.
- Persisting `activeWorkspace` only in the MCP invocation is insufficient: `controlToJobConfig()` and `summarizeWorkerPolicy()` must retain it, and the staging second-pass policy must restore the original value instead of exposing the temporary stage root.
- The installed-cache test skips an absent or automatically discovered stale cache during pre-install source validation. Once the exact manifest version is installed, it must execute; an explicitly supplied `GROK_CODEX_INSTALLED_CACHE` never permits a parity mismatch to skip.

## Phase 9: OpenAI Codex harness audit findings

### Source method and scope

- Official OpenAI documentation search for `Codex harness sandbox approvals` produced no dedicated harness architecture page. Public documentation is therefore used for the supported permission/security model, while harness internals must be established from the versioned `openai/codex` source and tests.
- The comparison is responsibility-based: upstream Rust module names are not assumed to map one-to-one to this project's Node.js MCP/companion modules.
- Findings will distinguish current upstream evidence from recommendations; no upstream code is being copied or vendored during this audit.
- The current Codex documentation entry point redirects from `developers.openai.com/codex/` to `learn.chatgpt.com/docs`. Its navigation exposes Permissions, Codex CLI, Security, Open Source, and Skills & Plugins as the relevant public baselines.

### Official Codex baseline

- Official Permissions documentation separates two controls: the sandbox defines accessible files/network resources; the approval policy defines when execution pauses or goes to a reviewer. Changing the reviewer does not expand the sandbox.
- The documented default `Ask for approval` profile is `workspace-write` plus `on-request` approvals reviewed by the user: workspace reads/edits and routine commands are allowed, while internet or workspace-boundary crossing requires approval.
- Automatic review and full access are materially different. Automatic review keeps the workspace sandbox and changes who reviews escalation; full access removes the local file/network boundary and is explicitly documented as increasing data-loss and leak risk.
- The official Open Source page identifies `openai/codex` as the primary open-source home, and identifies `codex-rs/app-server` and `codex-sdk` as open-source components in the same repository. The IDE extension and Codex cloud are not open source, so this audit must not infer their private harness implementation from the CLI repository.
- Official detail pages linked from Permissions are `https://learn.chatgpt.com/docs/sandboxing`, `https://learn.chatgpt.com/docs/sandboxing/auto-review`, and `https://learn.chatgpt.com/docs/permissions`.

### Upstream revision and enforcement baseline

- Audit revision: `openai/codex` commit `9c9675d3d038d9e827875c6bdceb2c6d68439dfc`, authored `2026-08-25T02:57:49Z`, committed `2026-08-25T03:08:33Z`, subject `Represent terminal input in approval reviews (#40528)`.
- Official Sandbox documentation says spawned commands such as Git, package managers, and test runners inherit the same sandbox boundaries; this is stronger than merely denying selected tool names in an agent prompt.
- Platform enforcement is native: Seatbelt on macOS; bubblewrap/seccomp with Landlock compatibility paths on Linux/WSL; dedicated lower-privilege users/filesystem ACL/firewall in elevated native Windows, with a weaker unelevated fallback. Unsupported policies are refused rather than silently run unsandboxed.
- Beta permission profiles support `read`, `write`, and `deny`, with more-specific paths overriding broader paths and `deny` winning on equal specificity. They can make a workspace writable while denying secret-like files such as `**/*.env`.
- Permission profiles distinguish network enablement from network filtering. Domain allow/deny rules require the network proxy; network-on with proxy-off is direct unrestricted command network access.
- The command network proxy does not govern web search, connectors, MCP servers, browser/computer use, Codex service traffic, or Codex cloud. Each capability needs its own control surface. This directly supports the current project's separate host-tool boundary, but also shows that child command isolation and MCP/tool authorization must not be conflated.
- The upstream tree contains explicit app-server protocol surfaces for command/file-change/permission approval, terminal interaction, process output, turn lifecycle, rollback/revert, Guardian review, permission profiles, Windows sandbox setup/readiness, and MCP calls. These are first-class typed lifecycle events rather than text parsed from subprocess narration.

### Upstream harness module map

- `codex-rs/core/src/tools/registry.rs`, `router.rs`, `orchestrator.rs`, `lifecycle.rs`, and `events.rs` form the model-tool harness boundary: declared specs and handlers, routing from response items, execution orchestration, lifecycle wrapping, and structured events are separate responsibilities.
- Command execution is split further into handlers (`handlers/unified_exec/*`), runtimes (`runtimes/unified_exec.rs`, apply-patch runtime), long-lived process management (`unified_exec/process_manager.rs`), policy (`exec_policy.rs` plus the `execpolicy` crate), approval (`tools/approvals.rs`), and sandbox selection/transformation (`tools/sandboxing.rs` plus the `sandboxing` crate).
- OS enforcement is intentionally outside core orchestration: generic `sandboxing`, `linux-sandbox`, `windows-sandbox-rs`, `bwrap`, `process-hardening`, and `shell-escalation` crates isolate platform-specific privilege and process mechanics.
- Durable/stateful layers are distinct again: `protocol` defines typed items/events; `rollout` owns JSONL persistence/search/index/maintenance; `rollout-trace` reduces raw events into thread/tool/inference traces; `app-server-protocol` maps the engine into a versioned JSON-RPC API.
- The repository's own contributor guidance treats app-server API, raw response item events, CLI flags, config loading, and rollout resume compatibility as explicit breaking-change surfaces. It also requires agent-logic changes to receive integration tests driven by mocked structured Responses events.
- Every upstream `ToolInvocation` carries the session, turn context, step context, turn-diff tracker, call id, typed tool name, call source, and payload. This makes attribution/cancellation/diff tracking ambient execution context instead of optional fields repeatedly reconstructed by individual handlers.
- Upstream tool outputs explicitly separate model-facing output/truncation from telemetry/log output budgets. `ExecCommandToolOutput` contains raw output plus requested and enforced truncation policy, rather than using one persisted text stream for every consumer.
- Unified exec approval-cache keys include execution environment identity; tests explicitly guard this. Approval reuse is therefore scoped more narrowly than command text alone, an important reference for this project's job/workspace identity.
- The upstream process layer has lifecycle/drop guards, output-task guards, explicit write/interrupt/confirmed-terminate operations, sandbox-denial recognition, process-id allocation/release, network-approval registration/cleanup, and bounded output collection. The current project implements portions of this in `grok.mjs`/`jobs.mjs`, but not through one typed process state machine.

### Tool-orchestrator invariants

- Upstream orchestration computes an `ExecApprovalRequirement` before execution (`Skip`, `NeedsApproval`, or `Forbidden`). `Forbidden` fails before the process starts; approval is not a generic after-the-fact wrapper.
- It then selects an initial sandbox from the effective filesystem/network permission profile and the tool's sandbox preference. The sandbox policy cwd can be supplied by the tool and is not blindly taken from process cwd.
- Only a recognized `SandboxErr::Denied` enters the escalation path. Ordinary tool failures are returned as failures; they are not reclassified as permission problems.
- A retry after sandbox denial is a distinct second attempt. Under strict automatic review, approval for the sandboxed attempt never authorizes an unsandboxed retry; a fresh review is required. Network denial carries a typed host/context into the approval rather than relying on stderr alone.
- The orchestrator separately records initial and escalated durations plus outcomes such as denied, timed out, signal, or escalated. This is a useful observability pattern for the project's preflight/delegation/check/rollback stages.
- Tool cancellation is passed into every invocation and into approval context. The current Grok worker can cancel background jobs, but cancellation is not yet a single token propagated through preflight, approval, Grok process, completion check, rollback, and persistence.
- `McpToolOutput` keeps raw structured MCP data for code-mode consumers while independently converting and truncating context injected back into the model. This is more robust than flattening all result forms early.

### Registry and dispatch findings

- Upstream keeps runtime registration separate from model-visible specs. Tools can be hidden or deferred while still registered; the router exposes only finalized specs for the current step. This prevents “callable internally” from automatically meaning “advertised to the model.”
- External tools cannot claim reserved default-namespace command names (`exec_command`, `shell_command`), and duplicate/collision state is recorded. The current plugin should similarly have one canonical tool manifest and fail validation on name/schema/handler collisions rather than relying on separately maintained switch branches.
- Parallel execution is an explicit per-tool runtime capability (`supports_parallel_tool_calls`), defaulting false if unknown. The Grok worker currently permits concurrent jobs globally but does not encode whether each operation is safe to invoke in parallel for the same workspace.
- Before dispatch, the registry rejects missing tools and incompatible payload kinds, runs pre-tool hooks that may block or return updated structured input, and only then emits tool-start. Post-tool data has a canonical tool name, call id, input, and response.
- Dispatch maintains active-turn tool-call accounting atomically, adds sandbox/policy/tool attribution to telemetry, categorizes parsed commands, and uses a terminal-outcome guard so completion/blocked/failed signaling cannot be emitted twice.
- Model response routing accepts typed function calls, custom tool calls, and client-executed tool-search calls and ignores unsupported server-executed search items. It does not scrape prose to discover work.

### Approval and sandbox semantics

- Approval actions are typed by risk surface: exec command, `execve`, patch, MCP call, network access, and permission-profile request carry different exact fields. An exec approval includes environment id, argv, cwd, sandbox/additional permissions, justification, tty state, and proposed policy amendment; it is not a yes/no approval for an opaque task description.
- Approval precedence is explicit: permission-request hooks first, then automatic Guardian review or user review according to policy. Resolution source is retained so timeout, cancellation, configuration denial, Guardian denial, and user denial have distinct fail-closed outcomes.
- MCP approval separately controls session remembrance and persistent approval. This matches the lesson from the project's Personal `once/on` work: duration/scope must be contract fields, not inferred from conversational language.
- Session approval caching requires all non-empty typed keys to have `ApprovedForSession`; empty-key actions bypass caching defensively. This prevents an underspecified cache key from becoming blanket authorization.
- A crucial upstream invariant is that denied-read restrictions forbid unsandboxed execution. Even explicit escalation or an exec-policy allow cannot drop the sandbox when doing so would silently expose denied files. The requested “escalated” permission is converted back to a sandboxed default attempt.
- Tool runtimes declare approval behavior and sandbox behavior through separate traits. They may override per-request sandbox permissions, approval requirements, approval action, sandbox preference, escalation-on-failure, environment, network-approval trigger, and sandbox cwd, while the orchestrator owns the common ordering.
- The exec-server path receives native commands plus a typed sandbox context; the client does not double-wrap a remote executor. This separation is relevant if this project later supports a dedicated worker daemon rather than a local CLI child.

### Policy evaluation findings

- Exec policy evaluates parsed command segments, resolves host executable identity, combines layered project/user/admin rules, then yields `Allow`, `Prompt`, or `Forbidden`. Sandbox bypass is allowed only when every parsed command segment is explicitly allowed, preventing an allowed prefix in one segment from laundering another command in a compound shell line.
- Reusable prefix amendments are generated only for models/configurations that honor prefix rules. Policy updates are serialized, appended durably, and swapped atomically in memory.
- Unmatched dangerous commands, or managed filesystem restrictions with no active Windows sandbox backend, can never silently run: interactive policies prompt and `never` forbids. In contrast, `never` can allow ordinary unmatched commands only by relying on an enforceable sandbox.
- Additional filesystem/network permissions are not accepted verbatim. Requested and granted profiles are intersected, accepted grants must stay within the request, and constraining deny entries from both sides are retained. Network becomes enabled only when both requested and granted enable it.
- Permission resolution materializes cwd-dependent project roots and globs before execution and carries bounded/unbounded deny-glob scan depth. This is a stronger composition model than this project's current caller allowlist plus separately generated Grok rules.
- The directly reusable idea is a pure `effectivePolicy(base, requested, granted, cwd)` function whose output is persisted and verified. The non-reusable part is claiming enforcement without a platform backend capable of honoring every resolved rule.

### Platform boundary findings

- Upstream retains URI/path-convention-aware paths through orchestration and transport, converting to host-native absolute paths only at the execution boundary. Both command cwd and sandbox-policy cwd are validated independently.
- `SandboxManager` distinguishes “policy requires a sandbox” from “this host has a concrete sandbox.” This lets policy/error handling notice unavailable enforcement instead of equating a missing wrapper with an unrestricted policy.
- Windows enforcement selects a read-only or writable-roots capability token from the resolved profile, uses `CreateProcessAsUserW`, pipes and a Windows Job Object, applies workspace ACLs/read-only subpaths, and can apply firewall policy. Full-disk writes and unsupported/unrestricted managed profiles are rejected.
- Workspace roots are materialized from the runtime-supplied root set, not inferred only from command cwd; writable temp roots come from the sanitized child environment. This reinforces the project's recent `activeWorkspace` fix but suggests generalizing it to a first-class root set.
- Upstream treats project metadata subdirectories as separately protectable even inside a writable workspace. The current worker snapshot protects recoverability, but Grok can still alter writable project metadata during execution unless its CLI sandbox prevents it; a post-run violation is not equivalent to precluded access.
- OS process containment and post-run content verification solve different problems. Snapshot/hash/rollback remains valuable evidence, but it should be documented as compensation and recovery, never as a substitute for restricted tokens/ACLs/job containment/firewall.

### Unified execution findings

- `exec_command` resolves an explicit environment id, joins workdir against that environment's cwd, validates native versus foreign path convention, negotiates remote shell/capabilities, and carries both command cwd and trusted sandbox cwd. The current worker has one local `cwd`; its `activeWorkspace` field partly solves authorization identity but is not a general execution-environment identity.
- Process ids are reserved before launch and explicitly released on every validation/interception failure. Shell commands that invoke apply-patch are intercepted and rerouted through the patch runtime, preventing a command wrapper from bypassing file-change policy and diff tracking.
- Additional permissions go through granted-turn permissions, feature gates, approval-policy checks, normalization, and intersection before the process opens. Sticky approved permissions continue through normal command approval rather than bypassing it.
- Remote executors must advertise capabilities such as executor-local network proxy launch; unsupported combinations fail. Local execution prepares the proxy, sanitized env, shell snapshot, path overlays, PowerShell UTF-8 mode, and disables PowerShell profiles for elevated Windows sandbox launches.
- Execution expiration combines timeout and cancellation. Sandbox denial is returned with bounded structured output and no resumable process id; live sessions have separate ids for `write_stdin` and termination.
- Practical adoption: give every Grok job a canonical invocation identity containing `jobId`, `tool`, `activeWorkspace`, `targetWorkspace`, execution backend, model route, policy fingerprint, and attempt number; reserve/release it through one lifecycle guard instead of many branch-specific cleanups.

### Process lifecycle and trace findings

- A live process is stored before the initial yield wait so turn interruption cannot drop the last process handle and terminate it accidentally. Initial output is streamed as events while also captured for the tool response.
- Output collection uses a bounded head-tail buffer and reports total and omitted bytes. This preserves both early diagnostics and the most recent progress, unlike an unbounded log or a simple prefix truncation.
- Network approval is registered with the live process, can asynchronously terminate it on denial, and is always finalized/unregistered on exit or release. Same-process terminal reads/writes are serialized while different sessions can be polled concurrently.
- Upstream raw rollout trace is append-only and schema-versioned with writer-assigned contiguous sequence numbers. It distinguishes tool-dispatch start/end, runtime start/end, model-visible call id, MCP correlation id, requester, thread/turn, and raw payload references.
- The trace reducer validates referential integrity: unknown thread/turn/tool ids, duplicate model-visible ids, a second terminal operation for one call, or disappeared records are errors. Runtime facts enrich but do not overwrite the canonical dispatch invocation.
- The current project's atomic `state.json` and `result.json` prevent torn files, but mutable snapshots lose causal history. A small append-only per-job event journal would improve crash recovery, auditability, and diagnosis without requiring Codex's full rollout graph.

### What “harness” means in the upstream repository

- There is no single `harness` crate implementing the local Codex agent loop. That broader harness responsibility is distributed across core session/turn, tool router/registry/orchestrator, approvals, sandboxing, unified exec, protocol, and rollout crates.
- Upstream uses “harness” explicitly in the remote exec-server protocol for the logical client endpoint opposite an environment/executor, and in test utilities such as `TestCodexBuilder` and `ExecServerHarness`.
- A remote harness identity may survive reconnects, but registry authorization, executor registration, pinned executor key, and harness-key authorization are an atomic single-use bundle for one physical Noise connection. Mixing fields across connection attempts is forbidden.
- The exec-server forwarder does not parse RPCs, replay requests, persist execution state, or own process/session identity; the destination executor owns session ids, processes, resumption, and retained output. This is a clean ownership rule that the current MCP/companion split should emulate more explicitly.
- Upstream test harnesses start real engine/server processes, feed deterministic mocked Responses SSE items, observe typed events, inspect outbound request bodies, and kill child processes on fixture drop. This provides more confidence than only calling internal helper functions.

### Remote harness/exec-server contract

- Exec-server has a strict handshake (`initialize` response, then `initialized`) before process/filesystem RPCs. Unexpected notifications are protocol errors. Requests are sequential by default and concurrency is an explicit server option.
- Process identity is caller-chosen and stable per connection; duplicate ids are rejected. Output carries per-process sequence numbers and explicit stream (`stdout`, `stderr`, `pty`), while `process/read` accepts an `afterSeq` cursor, byte cap, and long-poll timeout.
- Exit and output-closed are separate notifications. Exit includes `sandboxDenied`; clients can recover missing terminal facts with a final read against older servers. Connection close terminates remaining processes owned by that client.
- Relay reliability is endpoint-owned: UUID stream identity, segment sequence/count, cumulative ACK plus bitset, duplicate suppression, segmentation/reassembly, resume/reset, and heartbeat. The rendezvous relay only routes frames.
- For this local-only plugin, Noise relay machinery is excessive. The directly useful subset is sequence-numbered job events, cursor-based status reads, explicit start/exit/closed phases, duplicate-id rejection, and negotiated protocol/capability version during MCP setup.

### Current project responsibility map

| Harness responsibility | Current project implementation | Assessment |
|---|---|---|
| Model-visible tool contract | `mcp/server.mjs` owns 18 JSON-schema tool definitions and MCP annotations. | Good explicit surface, but schema metadata and the large CLI-dispatch switch are separate sources of truth. `TOOL_MAP` silently overwrites duplicate names. |
| Invocation routing | `buildPolicyCheckedCompanionInvocation()` validates policy and serializes MCP input into companion CLI flags. | Strong fail-before-spawn checks. It does not create one canonical invocation context carrying MCP request id, job id, workspace identities, policy identity, attempt, and cancellation. |
| Task orchestration | `grok-companion.mjs` creates job shells, snapshots, stages Personal disclosure, launches Grok, verifies contracts, rolls back, and finalizes jobs. | Feature-rich, but lifecycle ownership is distributed across branch-specific functions rather than one explicit state machine/guard. |
| Permission floor | `security.mjs` forces strict/dontAsk-or-plan, denies shell/MCP/web tools, audits Grok configuration, filters the environment, and records policy evidence. | Valuable defense in depth and honestly reports weaker Windows/macOS network enforcement. It is policy/tool enforcement, not proof of a Codex-equivalent native OS sandbox. |
| Project/disclosure scope | `activeWorkspace`, `cwd`, `personalMode`, exact `authorizedProject`, credential-redacted staging, and cleanup are explicit. | This is one of the strongest parts of the project and closely matches upstream's principle that authorization scope must be typed and retained. Generalize the identity to root sets and separate target versus execution workspace. |
| Process execution | Foreground uses bounded `spawnSync`; background uses a detached Node wrapper, PID files, progress JSON, a log, and atomic result publication. | Functional but split into foreground/background implementations. Background stdout/stderr and logs can grow without a head-tail bound, and cancellation is not propagated through one token. |
| Cancellation | `grok_cancel` sends a process-tree signal by PID and immediately persists `cancelled`; MCP `notifications/cancelled` is ignored. | Main lifecycle gap. A signal-sent result is not confirmed process exit, and cancellation cannot interrupt MCP preflight, staging, snapshot, foreground execution, verification, rollback, or cleanup coherently. |
| Durable job state | Workspace-keyed `state.json`, per-job JSON, result JSON, PID, progress JSON, and log; shared state uses a lock and atomic replace. | Good concurrency protection for the shared index and atomic background result. Per-job JSON/progress are mutable snapshots; there is no causal event history or cursor. |
| Change safety | Required snapshots for writes, hash-based change sets, allowed/forbidden paths, checks, actual-change contracts, and verified rollback. | Strong compensating/recovery layer. It detects and can repair changes after execution; it does not prevent unauthorized access or mutation at the OS boundary. |
| End-to-end tests | Source MCP NDJSON test and installed-cache MCP test start the real server and drive a mock Grok executable. | Already better than helper-only tests. It should be extracted into a reusable harness and expanded to cancellation, process crash, event ordering, concurrent writes, and recovery. |

### Comparative conclusions

- The project already follows several important Codex harness principles: host-only capabilities are separated from the delegated worker; risky inputs fail before Grok starts; authorization scope is explicit; write tasks have snapshot/change/rollback contracts; state-index updates and background result publication avoid torn replacement; and the installed artifact is exercised over real MCP stdio.
- The main architectural difference is not Rust versus Node. Codex makes invocation identity, approval action, sandbox attempt, cancellation, process state, and trace event first-class typed objects. This project reconstructs those facts across MCP input, CLI flags, job JSON, worker-policy evidence, PID/progress files, and result parsing.
- The most consequential runtime risk is concurrent write work in one workspace. The MCP server handles input lines asynchronously, the companion advertises concurrent background jobs, and the state lock protects only metadata updates. Two write jobs can snapshot, modify, verify, or roll back the same workspace against overlapping baselines.
- Static MCP annotations are useful but insufficient for dynamic risk. The project correctly split `grok_personal_read` from destructive rescue after static destructive annotation caused approval friction. Continue using separate read/write tools where host approval is annotation-driven; do not build a second conversational approval system inside the worker.
- The project should preserve its snapshot, contract, disclosure, and deny layers after adopting stronger harness mechanics. They solve evidence, data minimization, and recovery problems that native sandboxing alone does not solve.

### Adopt now

1. Define one canonical tool manifest. Each entry should own `name`, model-visible schema, MCP annotations, companion command/serializer, `readOnly`, `mutatesWorkspace`, `supportsParallel`, background capability, approval class, and result parser. Generate `tools/list`, lookup, and dispatch from it; fail startup/tests on duplicate names, missing serializers, unsupported fields, or reserved-name collisions.
2. Add a canonical invocation envelope before spawning the companion: `invocationId`, `mcpRequestId`, `jobId` when assigned, canonical `activeWorkspace`, `targetWorkspace`, `executionWorkspace`, `workspaceRoots`, backend, tool, model/effort, attempt, and a SHA-256 `policyFingerprint`. Persist it in job and result records.
3. Introduce per-workspace scheduling. Permit concurrent read-only calls, serialize write-capable calls by canonical target workspace, and let status/cancel bypass that queue. Reject or explicitly queue a second write instead of allowing overlapping snapshots/rollbacks.
4. Propagate one `AbortSignal`/cancellation object from MCP request through child spawn, staging/snapshot, verification, rollback, and persistence. Map MCP cancellation to the active invocation. Persist `cancel_requested`, wait for confirmed exit, escalate termination after a bounded grace period, then emit the terminal state once.
5. Add an append-only per-job `events.ndjson` with schema version and contiguous sequence numbers. Minimum events: `accepted`, `policy_resolved`, `staging_started/completed`, `snapshot_created`, `process_started`, `progress`, `cancel_requested`, `process_exited`, `output_closed`, `verification_completed`, `rollback_started/completed`, and `job_completed/failed`. Keep `state.json` and job JSON as rebuildable projections.
6. Replace unbounded background accumulation and whole-file status reads with a bounded head-tail buffer. Record total bytes and omitted bytes, keep model-facing output separate from diagnostic/audit output, and make `status` read by event/log cursor rather than rereading the entire file.
7. Make every per-job projection atomic, not only the shared state and background result. Add a terminal-outcome guard so success/failure/cancel/rollback completion cannot be published twice during reaper races.
8. Extract the existing stdio test code into an `McpHarness` fixture. It should own server lifecycle, request ids, timeouts, deterministic mock-Grok scenarios, cleanup, event capture, and assertions on outbound argv/environment. Add cancellation-before-spawn, cancellation-while-running, child-crash, corrupt projection recovery, duplicate terminal event, and same-workspace write-concurrency tests.

### Adapt later

1. Refactor `normalizeWorkerPolicy()` into a pure requested/authority/effective composition API. Persist all three profiles and their fingerprint. Keep every deny from both sides and enable a capability only when both the worker authority and request permit it. This becomes important if future tools can request scoped exceptions; the current forced policy floor can remain the authority.
2. Generalize `activeWorkspace` into an execution-environment record with a stable `environmentId`, path convention, workspace root set, target cwd, staging cwd, and backend capabilities. This avoids repeating the installed-cache/current-workspace bug when remote workers, multiple roots, or non-native paths arrive.
3. Add lifecycle middleware around the existing pipeline: schema validation, preflight/policy, disclosure, snapshot, launch, finalize, contract verification, rollback, cleanup, and post-result hooks. Keep the stages small and explicit rather than reproducing Codex's crate graph.
4. Negotiate MCP/server capabilities beyond the version string when behavior actually varies, for example cancellation support, event cursors, maximum output, background jobs, and policy schema version.
5. If a remote Grok worker daemon is introduced, adopt exec-server's stable process ids, `afterSeq` reads, long polling, explicit `exited` versus `closed`, duplicate-id rejection, and connection-scoped cleanup. Keep authorization and process ownership at the destination worker.

### Deliberately avoid

- Do not copy the Rust crate layout or Codex's entire session/turn/rollout graph. The reusable value is the contract and ownership model, not the number of modules.
- Do not add Noise relay framing, ACK bitsets, reassembly, rendezvous registration, or reconnect machinery while the plugin remains a local MCP-to-CLI bridge.
- Do not route Grok shell text through Codex exec policy by parsing prose. Codex evaluates commands at a typed execution boundary; this project should continue denying Grok shell/host tools unless it owns an equally explicit command boundary.
- Do not claim Codex-grade sandboxing based on Grok deny rules, a PATH guard, environment filtering, snapshot hashes, or rollback. Preserve the current enforcement evidence labels and require a verifiable native backend before strengthening that claim.
- Do not make the raw trace the primary mutable state. Append events first, then project compact job/status/result views; keep payload retention and redaction bounded for this plugin's smaller operational scope.

### Recommended implementation order

1. Canonical tool manifest plus schema/serializer/collision tests.
2. Invocation envelope, policy fingerprint, and workspace read/write scheduler.
3. Cancellation/state machine plus atomic terminal projection.
4. Event journal, cursor reads, and bounded head-tail output.
5. Reusable MCP process harness and lifecycle/race/recovery acceptance suite.
6. Requested/authority/effective policy composition and multi-root environment identity when scoped permission expansion or remote execution becomes real.

## Phase 10 Stage 1 implementation findings

- A metadata mutex is not a workspace scheduler. The durable write boundary now uses one lease per canonical state directory, acquired before snapshot creation and owned by a random token plus owner/child PIDs. A live owner rejects a second writer; an abandoned lease can be reclaimed after both recorded processes are gone.
- MCP cancellation can remain protocol-native without killing the companion prematurely. A request-local atomic marker reaches an `AbortSignal`; `runCommandAsync` terminates the Grok process tree and resolves only on `close`, after which cancellation forces snapshot rollback and publishes `cancelled` or `cancelled_rolled_back` with request/exit/close evidence.
- Background cancellation needs the same contract but a different owner. Each job has a cancellation marker observed by the detached wrapper. The wrapper writes a complete bounded raw result, then invokes automatic companion finalization so rollback and lease release no longer depend on a later status poll.
- Finalization races are cross-process: background auto-finalization, status, result, cancel, and liveness recovery may all see the same result. A per-job finalization lock plus atomic per-job/progress/result writes prevents duplicate rollback and terminal overwrite while preserving schema-v3 readers.
- Windows `.cmd/.bat` behavior differed between the foreground helper and the embedded background script. Sharing quoted command resolution and setting `windowsHide: true` removed a real lingering `cmd.exe`/`conhost.exe` process that kept the workspace directory open after apparent completion.
- Bounded capture must cover four surfaces, not only the MCP response: foreground stdout/stderr, background stdout/stderr/text/thought, persistent background logs, and status tail reads. Each retained result now carries total/retained/omitted byte counts where applicable.
- Stage 1 passed a zero-skip `187/187` suite after reinstall. The acceptance included a real MCP cancellation of a write-after-modification mock, two companion writers racing for one workspace, detached automatic finalization, concurrent terminal readers, corrupt background results, state-process concurrency, and installed-cache MCP stdio.

## Phase 10 Stage 2 implementation findings

- Stage 2 begins from the accepted `0.1.0+codex.20260825050443` cache with all Stage 1 lifecycle and output guarantees retained.
- The current MCP contract has four separate ownership points: `TOOL_DEFINITIONS` for schemas, `buildCompanionInvocation()` for serialization, `isReadOnlyTool()` for classification, and `runCompanion()` for write-capability calculation. A canonical manifest must drive all four without weakening per-input read-only cases such as rescue `readOnly`, workflow `validateOnly`, execute-plan `dryRun`, and babysit `list`.
- Job/state schema-v3 projections remain compatibility surfaces. Invocation, policy-composition, environment, and journal evidence will be additive fields; the event journal will not replace existing JSON readers in this stage.
- The append-only journal needs its own per-job append lock because MCP cancellation, detached finalization, status/result reconciliation, and foreground completion are separate processes that may emit concurrently.
- The canonical manifest can preserve the existing model-visible schemas while making the validated runtime record authoritative. Each record now binds its definition to a serializer and dynamic capabilities; `tools/list`, lookup, policy preflight, and spawn classification all consume that record.
- Invocation evidence must cross the MCP-to-companion process boundary without becoming part of the Grok child environment. The MCP server passes two internal JSON environment values only to the companion; the companion persists them, while the existing allowlisted `buildWorkerEnv()` strips them before the remote Grok CLI starts.
- Policy fingerprints are computed from the summarized effective policy, not the raw request. Requested and authority layers remain inspectable, while prompt text and environment values are absent. A Personal staging transition recomputes the effective fingerprint and execution-environment identity against the staging root.
- Event ordering follows actual side effects. Rollback events are emitted inside `applyWorkspaceOutcome()` around the restore operation; foreground and background paths emit process exit/output close before verification and exactly one terminal event under the existing finalization lock.
- The reusable `McpHarness` now owns NDJSON parsing, request IDs, timeouts, cancellation notifications, bounded stdout/stderr diagnostics, server lifecycle, and cleanup for both source and installed-cache tests.
- Stage 2 adds evidence without replacing schema-v3 projections: old job/state readers continue to work, while new consumers can correlate MCP request, invocation, job, effective policy, execution environment, and append-only lifecycle sequence.
- The installed-cache gate is materially stronger than source-only unit coverage: it checks whole-plugin SHA-256 parity, boots the cached server, runs real NDJSON calls through a mock CLI, and verifies that Personal staging records a different execution workspace which has been cleaned by response time.
- Final acceptance passed `191/191` with zero skips at installed version `0.1.0+codex.20260825052954`; real cached setup separately confirmed Grok 1.0.5 availability, authentication, and doctor readiness.
