#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { expandArgv, parseArgs } from "./lib/args.mjs";
import {
  collectDesignArtifacts,
  collectDocumentArtifacts,
  collectPlanArtifacts,
  collectWorkflowArtifacts,
  normalizeArtifactList,
  preferPlanArtifactText,
  resolveExecutePlanDesignPath
} from "./lib/artifacts.mjs";
import { parseBabysitInvocation, buildBabysitPrompt, babysitSupportsBackground } from "./lib/babysit.mjs";
import {
  CONTROL_ARRAY_OPTIONS,
  CONTROL_BOOLEAN_OPTIONS,
  CONTROL_VALUE_OPTIONS,
  MIN_GROK_VERSION,
  applyControlToGrokOptions,
  compareSemver,
  controlFromParsedOptions,
  controlToJobConfig
} from "./lib/control.mjs";
import { buildDesignPrompt, buildExecutePlanPrompt, buildPlanModePrompt } from "./lib/design.mjs";
import { createWorkspaceSnapshot, buildWorkspaceChangeSet, rollbackWorkspaceSnapshot } from "./lib/snapshot.mjs";
import { applyDisclosureStage, cleanupDisclosureStage, createDisclosureStage, normalizeDataPolicy, redactText } from "./lib/disclosure.mjs";
import { appendCompletionContract, describeContract, evaluateActualChangeContract, evaluateChangedFileScope, normalizeCheckPolicy, normalizeCheckTimeout, normalizeExpectedFiles, shellCommandForPlatform, validateSnapshotContract, verifyExpectedFiles, verifyProducedArtifacts } from "./lib/contracts.mjs";
import { buildDocumentPrompt, normalizeDocumentType } from "./lib/documents.mjs";
import { collectStopGateContext, resolveReviewTarget } from "./lib/git.mjs";
import {
  getGrokAuthStatus,
  getGrokAvailability,
  humanizeGrokFailure,
  parseGrokJsonOutput,
  assertGrokCliCompatibility,
  runGrokAsync,
  runGrokDoctor,
  spawnGrokBackground
} from "./lib/grok.mjs";
import {
  AmbiguousJobError,
  acquireWorkspaceWriteLease,
  appendJobEvent,
  generateJobId,
  getConfig,
  getLastTaskSessionId,
  isActiveJobStatus,
  listJobs,
  listRunningJobs,
  listTaskSessions,
  nowIso,
  readJobFile,
  readJobCancellation,
  readJobEvents,
  readJobProgress,
  recordTaskSession,
  releaseWorkspaceWriteLease,
  requestJobCancellation,
  resolveJob,
  resolveJobCancelFile,
  resolveJobEventsFile,
  resolveJobLogFile,
  resolveJobPidFile,
  resolveJobProgressFile,
  resolveJobsDir,
  setConfig,
  shouldAttemptBackgroundFinalize,
  tailLog,
  tryReadResultPayload,
  updateWorkspaceWriteLease,
  upsertJob,
  withJobFinalizationLock,
  writeJobFile,
  writeJobProgress,
  writeJsonAtomic
} from "./lib/jobs.mjs";
import {
  createInvocationEnvelope,
  parseEvidenceEnvironment,
  updateInvocationEnvelope
} from "./lib/invocation.mjs";
import {
  buildImagePrompt,
  buildVideoPrompt,
  collectMediaArtifacts,
  extractArtifactPaths,
  resolveMediaOutputDir
} from "./lib/media.mjs";
import { readPidFile, runCommand, terminateProcessTree, waitForProcessExit, writePidFile } from "./lib/process.mjs";
import {
  renderBackgroundStarted,
  renderCancelReport,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  renderTransferReport
} from "./lib/render.mjs";
import {
  buildStructuredReviewPrompt,
  getReviewSchemaPath,
  postPendingForFinishedJob,
  reviewHasBlockingFindings,
  tryParseStructuredReview
} from "./lib/review.mjs";
import { exportSession, listSessions, searchSessions } from "./lib/sessions.mjs";
import { buildTransferPlan } from "./lib/transfer.mjs";
import { extractUsageFromParsed, extractUsageFromStdout } from "./lib/usage.mjs";
import {
  buildWorkflowPrompt,
  discoverWorkflows,
  parseWorkflowArgs
} from "./lib/workflow.mjs";

const COMPANION_PATH = fileURLToPath(import.meta.url);
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  buildWorkerEnv,
  createWorkerPolicyEvidence,
  evaluateWorkerPolicy,
  normalizeWorkerPolicy,
  summarizeWorkerPolicy
} from "./lib/security.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const INHERITED_EVIDENCE = parseEvidenceEnvironment();
const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODEL_ALIASES = new Map([
  ["fast", "grok-4.6"],
  ["default", "grok-4.6"],
  ["deep", "grok-4.6"],
  ["grok", "grok-4.6"]
]);
const PRESET_EFFORT = new Map([
  ["fast", "low"],
  ["deep", "high"],
  ["default", "high"],
  ["grok", "high"],
  ["grok-4.6", "high"]
]);
const CONTRACT_BOOLEAN_OPTIONS = ["snapshot", "no-snapshot", "rollback-on-failure"];
const CONTRACT_ARRAY_OPTIONS = ["expected-file", "allowed-changed-file", "forbidden-changed-path"];
const CONTRACT_VALUE_OPTIONS = ["check-command", "check-policy", "check-timeout-ms"];
const PERSONAL_SCOPE_VALUE_OPTIONS = ["personal-mode", "authorized-project", "active-workspace"];


function printUsage() {
  console.log(
    [
      "Usage:",
      "  setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  task [--background] [--read-only] [--resume-last|--resume-session <id>|--fresh]",
      "       [--model <id|fast|deep>] [--effort <level>] [--worktree [name]] [--check]",
      "       [--best-of-n <n>] [--sandbox <profile>] [--plan] [--permission-mode <mode>]",
      "       [--agent <name>] [--no-subagents] [--memory|--no-memory]",
      "       [--allow RULE]... [--deny RULE]... [--disable-web-search] [--fork-session]",
      "       [--personal-mode on|once] [--active-workspace <path>] [--authorized-project <path>]",
      "       [--max-turns <n>] [prompt]",
      "  plan [--background] [--model <id>] [--effort <level>] [control flags...] [prompt]",
      "  task-resume-candidate [--json]",
      "  review [--background] [--adversarial] [--post-pending] [--base <ref>]",
      "         [--scope auto|working-tree|branch] [--pr <number>] [--model <id>] [focus]",
      "  workflow list [--json]",
      "  workflow run <name> [--arg key=value]... [--validate-only] [--background] ...",
      "  design [--background] [--model deep] [brief]",
      "  execute-plan [<design-doc>|--latest] [--concurrency N] [--dry-run] [--auto-pr]",
      "               [--no-graphite] [--resume PLAN_ID] [--instructions text] [--background]",
      "  babysit add|list|check|remove [pr...] [--background]",
      "  document --type pptx|pdf|docx [--background] [brief]",
      "  sessions list|search|export ...",
      "  image [--background] [--edit <path>] [--aspect <ratio>] [--model <id>] [prompt]",
      "  video [--background] [--image <path>] [--ref <path>]... [--duration 6|10]",
      "        [--aspect <ratio>] [--model <id>] [prompt]",
      "  transfer [--source <claude-transcript.jsonl>] [--json]",
      "  stop-gate-review [--json]",
      "  status [job-id] [--all] [--json]",
      "  result [job-id] [--json]",
      "  cancel [job-id] [--json]"
    ].join("\n")
  );
}

function controlParseConfig(extraBoolean = [], extraValue = []) {
  return {
    booleanOptions: [
      "background",
      "json",
      "verbatim",
      ...CONTROL_BOOLEAN_OPTIONS, ...CONTRACT_BOOLEAN_OPTIONS,
      ...extraBoolean
    ],
    valueOptions: [
      "model",
      "effort",
      "cwd",
      ...CONTROL_VALUE_OPTIONS, ...CONTRACT_VALUE_OPTIONS,
      ...extraValue
    ],
    arrayOptions: [...CONTROL_ARRAY_OPTIONS, ...CONTRACT_ARRAY_OPTIONS]
  };
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function normalizeModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeEffort(effort, modelAlias) {
  if (effort == null && modelAlias && PRESET_EFFORT.has(String(modelAlias).toLowerCase())) {
    return PRESET_EFFORT.get(String(modelAlias).toLowerCase());
  }
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_EFFORTS.has(normalized)) {
    throw new Error(`Invalid --effort value: ${effort}. Expected one of ${[...VALID_EFFORTS].join(", ")}`);
  }
  return normalized === "max" ? "xhigh" : normalized;
}

function completionOptions(cwd, options, writeCapable) {
  const noSnapshot = options["no-snapshot"] === true;
  const snapshot = options.snapshot === true ? true : noSnapshot ? false : Boolean(writeCapable);
  const allowedChangedFiles = normalizeExpectedFiles(cwd, options["allowed-changed-file"] || []);
  const forbiddenChangedPaths = normalizeExpectedFiles(cwd, options["forbidden-changed-path"] || []);
  validateSnapshotContract({
    writeCapable, snapshot, noSnapshot, allowedChangedFiles, forbiddenChangedPaths,
    rollbackOnFailure: Boolean(options["rollback-on-failure"])
  });
  return {
    expectedFiles: normalizeExpectedFiles(cwd, options["expected-file"] || []),
    allowedChangedFiles,
    forbiddenChangedPaths,
    checkCommand: options["check-command"] ? String(options["check-command"]) : null,
    checkPolicy: normalizeCheckPolicy(options["check-policy"]),
    checkTimeoutMs: normalizeCheckTimeout(options["check-timeout-ms"]),
    snapshot,
    rollbackOnFailure: Boolean(options["rollback-on-failure"])
  };
}

function promptCompletionContract(cwd, dataPolicy, {
  expectedFiles = [],
  allowedChangedFiles = [],
  forbiddenChangedPaths = [],
  checkCommand = null,
  selfCheck = false
} = {}) {
  if (dataPolicy !== "personal-sanitized") {
    return { expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, selfCheck };
  }

  // Personal writes run in a mirrored staging root. Keep absolute paths for
  // host-side verification, but expose only stage-relative paths to Grok so
  // its Edit/Write calls cannot target the original workspace.
  const relative = (value) => path.relative(cwd, value) || ".";
  return {
    expectedFiles: expectedFiles.map(relative),
    allowedChangedFiles: allowedChangedFiles.map(relative),
    forbiddenChangedPaths: forbiddenChangedPaths.map(relative),
    checkCommand,
    selfCheck
  };
}
function titleFromPrompt(prompt, fallback = "Grok task") {
  const compact = String(prompt ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) {
    return fallback;
  }
  return compact.length > 72 ? `${compact.slice(0, 71)}…` : compact;
}

function writePromptFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-companion-"));
  const filePath = path.join(dir, "prompt.md");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

// Prompt files contain the full handoff, so remove only the companion-owned
// temporary directory after the child has consumed it. Never remove a caller's
// arbitrary prompt path.
function cleanupPromptFile(promptFile) {
  if (!promptFile) return;
  try {
    const resolved = path.resolve(String(promptFile));
    const parent = path.dirname(resolved);
    if (path.basename(resolved) !== "prompt.md" || !path.basename(parent).startsWith("grok-companion-")) {
      return;
    }
    fs.rmSync(resolved, { force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  } catch {}
}

function releaseJobWriteLease(cwd, job) {
  return releaseWorkspaceWriteLease(cwd, job?.writeLease);
}

function watchJobCancellation(cwd, job) {
  const controller = new AbortController();
  let requested = null;
  const check = () => {
    if (requested || !job.cancelFile) return;
    const marker = readJobCancellation(cwd, job.id) || (() => {
      if (!fs.existsSync(job.cancelFile)) return null;
      try { return JSON.parse(fs.readFileSync(job.cancelFile, "utf8")); }
      catch { return { reason: "Cancelled by user", requestedAt: nowIso() }; }
    })();
    if (!marker) return;
    requested = marker;
    const cancelRequestedAt = marker.requestedAt || nowIso();
    job.status = "cancel_requested";
    job.cancelRequestedAt = cancelRequestedAt;
    upsertJob(cwd, {
      id: job.id,
      status: "cancel_requested",
      cancelRequestedAt,
      summary: "Cancellation requested"
    });
    writeJobFile(cwd, job);
    writeJobProgress(cwd, job.id, {
      phase: "cancel_requested",
      message: "Cancellation requested",
      cancelRequestedAt
    });
    appendJobEvent(cwd, job.id, "cancel_requested", {
      requestedAt: cancelRequestedAt,
      reason: marker.reason || "Cancelled by user",
      source: process.env.GROK_CANCEL_FILE ? "mcp" : "job"
    }, { at: cancelRequestedAt });
    controller.abort(marker.reason || "Cancelled by user");
  };
  check();
  const timer = setInterval(check, 50);
  timer.unref?.();
  return {
    signal: controller.signal,
    get requested() { return requested; },
    close() { clearInterval(timer); }
  };
}

function enrichJob(cwd, job) {
  if (!job) {
    return job;
  }
  const progress = readJobProgress(cwd, job.id);
  const logTail = tailLog(job.logFile, 12);
  const events = readJobEvents(cwd, job.id, { afterSeq: 0, limit: Number.MAX_SAFE_INTEGER });
  return {
    ...job,
    progress,
    logTail,
    eventsFile: job.eventsFile || resolveJobEventsFile(cwd, job.id),
    eventCursor: events.length ? events[events.length - 1].seq : 0,
    lastEvent: events.length ? events[events.length - 1] : null
  };
}

function resolveMediaArtifactsForJob(job, text, sessionId) {
  const cwd = job.workspaceRoot || process.cwd();
  const kind = job.kind === "video" ? "video" : "image";
  const outputDir = job.mediaDir || resolveMediaOutputDir(cwd, kind);
  const startedMs = Date.parse(job.createdAt || "") || Date.now() - 120_000;
  return collectMediaArtifacts({
    cwd,
    kind,
    outputDir,
    sessionId,
    sinceMs: startedMs,
    text
  });
}

function harvestKindArtifacts(cwd, job, text, sessionId) {
  const startedMs = Date.parse(job.createdAt || "") || Date.now() - 120_000;
  if (job.kind === "image" || job.kind === "video") {
    return resolveMediaArtifactsForJob(job, text, sessionId);
  }
  if (job.kind === "plan") {
    return collectPlanArtifacts(cwd, sessionId, { jobId: job.id });
  }
  if (job.kind === "design") {
    return collectDesignArtifacts(cwd, { sessionId, text, jobId: job.id });
  }
  if (job.kind === "workflow") {
    return collectWorkflowArtifacts(cwd, { text, jobId: job.id });
  }
  if (job.kind === "document") {
    return collectDocumentArtifacts(cwd, {
      text,
      sessionId,
      jobId: job.id,
      sinceMs: startedMs,
      outputDir: job.mediaDir || null
    });
  }
  const paths = extractArtifactPaths(text, job.workspaceRoot || cwd);
  return paths.map((p) => (typeof p === "string" ? { kind: "file", path: p } : p));
}

function evaluateCompletionContract(cwd, job, artifacts, { grokOk = true } = {}) {
  const fileCheck = verifyExpectedFiles(cwd, job.expectedFiles || []);
  const artifactCheck = verifyProducedArtifacts(cwd, job, artifacts);
  let commandCheck = null;
  const checkPolicy = job.checkPolicy || "on-success";
  if (job.checkCommand && (grokOk || checkPolicy === "always")) {
    const spec = shellCommandForPlatform(job.checkCommand);
    let result;
    try {
      result = runCommand(spec.command, spec.args, {
        cwd,
        maxBuffer: 8 * 1024 * 1024,
        timeout: job.checkTimeoutMs || 120000,
        env: buildWorkerEnv(process.env)
      });
    } finally {
      spec.cleanup?.();
    }
    const timedOut = result.error?.code === "ETIMEDOUT";
    commandCheck = {
      command: job.checkCommand,
      exitCode: result.status,
      ok: result.status === 0 && !result.error,
      timedOut,
      error: result.error ? String(result.error.message || result.error) : null,
      stdout: String(result.stdout || "").trim().slice(-4000),
      stderr: String(result.stderr || "").trim().slice(-4000)
    };
  }
  const policyCheck = evaluateWorkerPolicy(job.workerPolicy, { writeRequested: Boolean(job.write) });
  const contract = describeContract(job, artifactCheck, fileCheck, commandCheck, { grokOk, policyCheck });
  if (!policyCheck.ok) return { status: "failed_policy", failure: policyCheck.message, contract };
  if (!fileCheck.ok) return { status: "failed_artifact", failure: fileCheck.message, contract };
  if (!artifactCheck.ok) return { status: "failed_artifact", failure: artifactCheck.message, contract };
  if (commandCheck && !commandCheck.ok) {
    const failure = commandCheck.timedOut
      ? `Completion check timed out after ${job.checkTimeoutMs || 120000}ms: ${job.checkCommand}`
      : `Completion check failed (exit ${commandCheck.exitCode ?? "unknown"}): ${job.checkCommand}`;
    return { status: "failed_check", failure, contract };
  }
  if (!grokOk) return { status: "failed", failure: null, contract };
  return { status: "completed", failure: null, contract };
}

function applyWorkspaceOutcome(
  cwd,
  job,
  initialStatus,
  initialFailure = null,
  { forceRollback = false, skipActualChange = false } = {}
) {
  const snapshotRequested = Boolean(job.snapshotRequested || (job.snapshot && typeof job.snapshot === "object"));
  if (!snapshotRequested) {
    const actualChange = skipActualChange
      ? { ok: false, skipped: true, message: "Actual-change verification skipped because the job was cancelled." }
      : evaluateActualChangeContract(cwd, job, null);
    if (skipActualChange) {
      return { status: initialStatus, snapshot: null, changes: null, actualChange, scope: null, rollback: null, failure: initialFailure };
    }
    if (!actualChange.ok) {
      return { status: actualChange.status || "failed_snapshot", snapshot: null, changes: null, actualChange, scope: null, rollback: null, failure: actualChange.message };
    }
    return { status: initialStatus, snapshot: null, changes: null, actualChange, scope: null, rollback: null, failure: null };
  }
  if (!job.snapshot || typeof job.snapshot !== "object") {
    return { status: "failed_snapshot", snapshot: null, changes: null, actualChange: { ok: false, status: "failed_snapshot", message: "Workspace snapshot was requested but was not created." }, scope: null, rollback: null, failure: "Workspace snapshot was requested but was not created." };
  }
  let changes;
  try {
    changes = buildWorkspaceChangeSet(cwd, job.snapshot);
  } catch (error) {
    return { status: "failed_snapshot", snapshot: job.snapshot, changes: null, actualChange: { ok: false, status: "failed_snapshot", message: error instanceof Error ? error.message : String(error) }, scope: null, rollback: null, failure: "Unable to build workspace change set: " + (error instanceof Error ? error.message : String(error)) };
  }
  const actualChange = skipActualChange
    ? { ok: false, skipped: true, message: "Actual-change verification skipped because the job was cancelled." }
    : evaluateActualChangeContract(cwd, job, changes);
  const scope = evaluateChangedFileScope(cwd, changes, { allowedChangedFiles: job.allowedChangedFiles || [], forbiddenChangedPaths: job.forbiddenChangedPaths || [] });
  if (!scope.ok) {
    if (initialStatus === "completed") {
      initialStatus = "failed_scope";
      initialFailure = scope.message;
    } else if (initialStatus === "failed_check") {
      initialStatus = "failed_scope_and_check";
      initialFailure = scope.message + " Completion check also failed.";
    } else if (initialStatus === "failed_artifact") {
      initialStatus = "failed_scope_and_artifact";
      initialFailure = scope.message + " Required artifact verification also failed.";
    }
  }
  if (!actualChange.ok && !skipActualChange) {
    if (initialStatus === "completed") {
      initialStatus = actualChange.status || "failed_changes";
      initialFailure = actualChange.message;
    } else {
      initialStatus = initialStatus + "_and_changes";
      initialFailure = [initialFailure, actualChange.message].filter(Boolean).join(" ");
    }
  }
  if (initialStatus === "completed" || (!job.rollbackOnFailure && !forceRollback)) {
    return { status: initialStatus, snapshot: job.snapshot, changes, actualChange, scope, rollback: null, failure: initialStatus !== "completed" ? initialFailure : null };
  }
  appendJobEvent(cwd, job.id, "rollback_started", {
    status: initialStatus,
    forced: forceRollback,
    changeCounts: changes.counts || null
  });
  try {
    const rollback = rollbackWorkspaceSnapshot(cwd, job.snapshot, changes);
    const remainingChanges = buildWorkspaceChangeSet(cwd, job.snapshot);
    rollback.remainingChanges = remainingChanges.counts;
    if (
      Object.values(remainingChanges.counts).some((count) => count > 0) ||
      remainingChanges.unverifiedChanges?.length
    ) {
      rollback.ok = false;
      rollback.error = "Rollback verification found remaining workspace changes.";
      appendJobEvent(cwd, job.id, "rollback_completed", { ok: false, error: rollback.error });
      return { status: "failed_rollback", snapshot: job.snapshot, changes, actualChange, scope, rollback, failure: (initialFailure || initialStatus) + "; " + rollback.error };
    }
    const rolledBackStatus = initialStatus + "_rolled_back";
    appendJobEvent(cwd, job.id, "rollback_completed", { ok: true, remainingChanges: rollback.remainingChanges });
    return { status: rolledBackStatus, snapshot: job.snapshot, changes, actualChange, scope, rollback, failure: (initialFailure || initialStatus) + " after Grok work; workspace changes were rolled back." };
  } catch (error) {
    const rollbackError = error instanceof Error ? error.message : String(error);
    appendJobEvent(cwd, job.id, "rollback_completed", { ok: false, error: rollbackError });
    return { status: "failed_rollback", snapshot: job.snapshot, changes, actualChange, scope, rollback: { ok: false, error: rollbackError }, failure: (initialFailure || initialStatus) + "; workspace rollback failed: " + rollbackError };
  }
}

function applyDisclosureOutcome(cwd, job, write) {
  if (!job?.disclosureStage) return { ok: true, applied: [], blocked: [], changed: [] };
  if (job.disclosureOutcome) return job.disclosureOutcome;
  const outcome = applyDisclosureStage(cwd, job.disclosureStage, { write, allowedChangedFiles: job.allowedChangedFiles || [] });
  job.disclosureOutcome = outcome;
  return outcome;
}

function sanitizeJobText(job, value) {
  const text = String(value ?? "");
  if (job?.dataPolicy !== "personal-sanitized") return text;
  return redactText(text).text;
}

function sanitizeDisclosureValue(job, value) {
  if (typeof value === "string") return sanitizeJobText(job, value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDisclosureValue(job, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDisclosureValue(job, item)]));
  }
  return value;
}

function finalizeJob(cwd, job, grokResult, extras = {}) {
  if (!job.workerPolicy && grokResult.workerPolicy) {
    job = { ...job, workerPolicy: summarizeWorkerPolicy(grokResult.workerPolicy) };
  }
  const parsed = grokResult.parsed;
  const ok = grokResult.ok;
  const cancelled = grokResult.cancelled === true;
  const disclosureOutcome = applyDisclosureOutcome(cwd, job, Boolean(job.write));
  const text = sanitizeJobText(job, parsed?.text || (!ok ? parsed?.error || grokResult.stderr : "") || grokResult.stdout);
  const sessionId = parsed?.sessionId ?? null;
  let status = cancelled ? "cancelled" : (ok ? "completed" : "failed");
  const finishedAt = nowIso();
  const review = extras.parseReview ? tryParseStructuredReview(text) : null;
  let artifacts =
    extras.artifacts ||
    harvestKindArtifacts(cwd, job, text, sessionId);
  artifacts = normalizeArtifactList(artifacts);
  const contractResult = evaluateCompletionContract(cwd, job, artifacts, { grokOk: ok && disclosureOutcome.ok });
  status = cancelled
    ? "cancelled"
    : (!disclosureOutcome.ok ? "failed_disclosure" : (ok ? contractResult.status : "failed"));
  const workspaceOutcome = applyWorkspaceOutcome(
    cwd,
    job,
    status,
    cancelled ? (grokResult.cancellationReason || "Cancelled by user") : contractResult.failure,
    { forceRollback: cancelled, skipActualChange: cancelled }
  );
  status = workspaceOutcome.status;

  const usage =
    extractUsageFromParsed(parsed?.parsed || parsed) ||
    extractUsageFromStdout(grokResult.stdout) ||
    null;

  const summary = review
    ? `${review.verdict}: ${titleFromPrompt(review.summary, status)}`
    : titleFromPrompt(text, status);

  const baseError = cancelled
    ? grokResult.cancellationReason || "Cancelled by user"
    : ok
    ? contractResult.failure
    : humanizeGrokFailure({
        parsedError: parsed?.error,
        stderr: grokResult.stderr,
        stdout: grokResult.stdout,
        exitCode: grokResult.status
      });
  const error = disclosureOutcome.message || workspaceOutcome.failure || (baseError ? sanitizeJobText(job, baseError) : null);

  // Attach flags so post helper can see request even if only extras carried them.
  const jobForPost = {
    ...job,
    wantPostPending: extras.wantPostPending || job.wantPostPending || job.config?.postPending,
    config: {
      ...(job.config || {}),
      postPending: Boolean(
        extras.wantPostPending || job.config?.postPending || job.wantPostPending
      )
    }
  };

  let postPending = extras.postPendingResult || job.postPending || null;
  if (status === "completed" && review) {
    const posted = postPendingForFinishedJob({
      job: jobForPost,
      review,
      cwd,
      runCommandFn: runCommand,
      target: extras.reviewTarget || job.reviewTarget || null
    });
    if (posted) {
      postPending = posted;
    }
  }

  const fullJob = {
    ...job,
    schemaVersion: 3,
    status,
    finishedAt,
    updatedAt: finishedAt,
    summary,
    resultText: text,
    review,
    artifacts,
    usage,
    postPending,
    wantPostPending: Boolean(jobForPost.wantPostPending),
    grokSessionId: sessionId,
    exitCode: grokResult.status,
    error,
    cancellation: cancelled ? {
      requestedAt: job.cancelRequestedAt || null,
      exitedAt: finishedAt,
      closedAt: finishedAt,
      reason: grokResult.cancellationReason || "Cancelled by user",
      processClosed: true
    } : null,
    outputStats: grokResult.outputStats || null,
    stderr: sanitizeJobText(job, grokResult.stderr || "") || null,
    contract: {
      ...sanitizeDisclosureValue(job, contractResult.contract),
      actualChange: workspaceOutcome.actualChange || null,
      scope: workspaceOutcome.scope,
      verified: Boolean(!cancelled && contractResult.contract?.verified && (workspaceOutcome.actualChange?.ok ?? true) && (workspaceOutcome.scope?.ok ?? true))
    },
    snapshot: workspaceOutcome.snapshot,
    changes: workspaceOutcome.changes,
    rollback: workspaceOutcome.rollback,
    disclosure: disclosureOutcome
  };

  appendJobEvent(cwd, job.id, "verification_completed", {
    ok: fullJob.contract?.verified === true,
    status,
    policyOk: fullJob.contract?.policy?.ok ?? null,
    scopeOk: fullJob.contract?.scope?.ok ?? null,
    actualChangeOk: fullJob.contract?.actualChange?.ok ?? null
  });

  upsertJob(cwd, {
    id: job.id,
    status,
    finishedAt,
    summary,
    grokSessionId: sessionId,
    exitCode: fullJob.exitCode,
    error: fullJob.error
  });
  writeJobFile(cwd, fullJob);
  releaseJobWriteLease(cwd, fullJob);
  appendJobEvent(cwd, job.id, status === "completed" ? "job_completed" : "job_failed", {
    status,
    exitCode: fullJob.exitCode,
    verified: fullJob.contract?.verified === true,
    processClosed: true
  }, { at: finishedAt });

  if (
    sessionId &&
    (job.kind === "task" || job.kind === "rescue" || job.kind === "plan")
  ) {
    recordTaskSession(cwd, {
      sessionId,
      jobId: job.id,
      title: job.title || fullJob.summary,
      kind: job.kind
    });
  }

  return fullJob;
}

function maybeFinalizeBackgroundJob(cwd, job) {
  if (!job?.id) return enrichJob(cwd, job);
  return withJobFinalizationLock(cwd, job.id, () => {
    const latest = readJobFile(cwd, job.id) || job;
    return maybeFinalizeBackgroundJobUnlocked(cwd, latest);
  });
}

function maybeFinalizeBackgroundJobUnlocked(cwd, job) {
  // Reconcile when still running *or* reaper false-failed while result.json exists.
  if (!job || !shouldAttemptBackgroundFinalize(job)) {
    return enrichJob(cwd, job);
  }

  const resultPath = job.resultFile;
  const read = tryReadResultPayload(resultPath);
  if (!read.ok) {
    // Defense-in-depth / TOCTOU: shouldAttemptBackgroundFinalize already requires
    // a complete parseable result, so primary corrupt-result failures come from the
    // reaper (process dead). This path only fires if the file changed between checks.
    if (job.status === "running" || job.status === "failed") {
      const finishedAt = nowIso();
      const failed = {
        ...job,
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        summary: "Background Grok result file is corrupt or incomplete",
        error: `Background result.json is ${read.reason}`,
        pendingResult: false
      };
      upsertJob(cwd, {
        id: job.id,
        status: "failed",
        finishedAt,
        summary: failed.summary,
        error: failed.error
      });
      writeJobFile(cwd, failed);
      appendJobEvent(cwd, job.id, "job_failed", { status: failed.status, error: failed.error, processClosed: true }, { at: finishedAt });
      cleanupDisclosureStage(job.disclosureStage);
      releaseJobWriteLease(cwd, failed);
      return enrichJob(cwd, failed);
    }
    return enrichJob(cwd, job);
  }
  const payload = read.payload;

  appendJobEvent(cwd, job.id, "process_exited", {
    exitCode: payload.exitCode,
    signal: payload.signal || null,
    exitedAt: payload.lifecycle?.exitedAt || payload.finishedAt || null
  }, { at: payload.lifecycle?.exitedAt || payload.finishedAt || nowIso() });
  appendJobEvent(cwd, job.id, "output_closed", {
    closedAt: payload.lifecycle?.closedAt || payload.finishedAt || null,
    outputStats: payload.outputStats || null
  }, { at: payload.lifecycle?.closedAt || payload.finishedAt || nowIso() });

  const parsed = parseGrokJsonOutput(payload.stdout || "");
  const ok = payload.exitCode === 0 && parsed.ok;
  const cancelled = payload.cancelled === true;
  const disclosureOutcome = applyDisclosureOutcome(cwd, job, Boolean(job.write));
  const text = sanitizeJobText(job, parsed.text || parsed.error || payload.stdout || "");
  const sessionId = parsed.sessionId ?? payload.sessionId ?? null;
  let status = cancelled ? "cancelled" : (ok ? "completed" : "failed");
  const finishedAt = payload.finishedAt || nowIso();
  const review =
    job.kind === "review" || job.kind === "adversarial-review" || job.kind === "stop-gate"
      ? tryParseStructuredReview(text)
      : null;
  const artifacts = normalizeArtifactList(harvestKindArtifacts(cwd, job, text, sessionId));
  const contractResult = evaluateCompletionContract(cwd, job, artifacts, { grokOk: ok && disclosureOutcome.ok });
  status = cancelled
    ? "cancelled"
    : (!disclosureOutcome.ok ? "failed_disclosure" : (ok ? contractResult.status : "failed"));
  const workspaceOutcome = applyWorkspaceOutcome(
    cwd,
    job,
    status,
    cancelled ? (payload.cancellationReason || "Cancelled by user") : contractResult.failure,
    { forceRollback: cancelled, skipActualChange: cancelled }
  );
  status = workspaceOutcome.status;
  // Prefer plan.md body for plan jobs so /grok:result is useful after background.
  const resultText =
    job.kind === "plan" ? preferPlanArtifactText(text, artifacts) : text;
  const usage =
    extractUsageFromParsed(parsed?.parsed || parsed) ||
    extractUsageFromStdout(payload.stdout) ||
    null;

  const baseError = cancelled
    ? payload.cancellationReason || "Cancelled by user"
    : ok
    ? contractResult.failure
    : humanizeGrokFailure({
        parsedError: parsed.error,
        stderr: payload.stderr,
        stdout: payload.stdout,
        exitCode: payload.exitCode
      });
  const error = disclosureOutcome.message || workspaceOutcome.failure || (baseError ? sanitizeJobText(job, baseError) : null);

  const jobForPost = {
    ...job,
    wantPostPending: job.wantPostPending || job.config?.postPending,
    config: {
      ...(job.config || {}),
      postPending: Boolean(job.config?.postPending || job.wantPostPending)
    }
  };

  let postPending = job.postPending || null;
  if (status === "completed" && review) {
    const posted = postPendingForFinishedJob({
      job: jobForPost,
      review,
      cwd,
      runCommandFn: runCommand,
      target: job.reviewTarget || null
    });
    if (posted) {
      postPending = posted;
    }
  }

  const fullJob = {
    ...job,
    schemaVersion: 3,
    status,
    finishedAt,
    updatedAt: finishedAt,
    summary: review
      ? `${review.verdict}: ${titleFromPrompt(review.summary, status)}`
      : titleFromPrompt(resultText, status),
    resultText,
    review,
    artifacts,
    usage,
    postPending,
    wantPostPending: Boolean(jobForPost.wantPostPending),
    grokSessionId: sessionId,
    exitCode: payload.exitCode,
    error,
    cancellation: cancelled ? {
      requestedAt: payload.lifecycle?.cancelRequestedAt || job.cancelRequestedAt || null,
      exitedAt: payload.lifecycle?.exitedAt || finishedAt,
      closedAt: payload.lifecycle?.closedAt || finishedAt,
      reason: payload.cancellationReason || "Cancelled by user",
      processClosed: true
    } : null,
    outputStats: payload.outputStats || null,
    stderr: sanitizeJobText(job, payload.stderr || "") || null,
    contract: {
      ...sanitizeDisclosureValue(job, contractResult.contract),
      actualChange: workspaceOutcome.actualChange || null,
      scope: workspaceOutcome.scope,
      verified: Boolean(!cancelled && contractResult.contract?.verified && (workspaceOutcome.actualChange?.ok ?? true) && (workspaceOutcome.scope?.ok ?? true))
    },
    snapshot: workspaceOutcome.snapshot,
    changes: workspaceOutcome.changes,
    rollback: workspaceOutcome.rollback,
    disclosure: disclosureOutcome,
    pendingResult: false
  };

  appendJobEvent(cwd, job.id, "verification_completed", {
    ok: fullJob.contract?.verified === true,
    status,
    policyOk: fullJob.contract?.policy?.ok ?? null,
    scopeOk: fullJob.contract?.scope?.ok ?? null,
    actualChangeOk: fullJob.contract?.actualChange?.ok ?? null
  });

  upsertJob(cwd, {
    id: job.id,
    status,
    finishedAt,
    summary: fullJob.summary,
    grokSessionId: sessionId,
    exitCode: fullJob.exitCode,
    error: fullJob.error
  });
  writeJobFile(cwd, fullJob);
  cleanupDisclosureStage(job.disclosureStage);
  releaseJobWriteLease(cwd, fullJob);
  appendJobEvent(cwd, job.id, status === "completed" ? "job_completed" : "job_failed", {
    status,
    exitCode: fullJob.exitCode,
    verified: fullJob.contract?.verified === true,
    processClosed: true
  }, { at: finishedAt });

  if (
    sessionId &&
    (job.kind === "task" || job.kind === "rescue" || job.kind === "plan")
  ) {
    recordTaskSession(cwd, {
      sessionId,
      jobId: job.id,
      title: job.title || fullJob.summary,
      kind: job.kind
    });
  }

  return enrichJob(cwd, fullJob);
}

function createJobShell(cwd, { kind, title, prompt, write, model, effort, extras = {} }) {
  const jobId = generateJobId(kind === "adversarial-review" ? "review" : kind);
  const logFile = resolveJobLogFile(cwd, jobId);
  const resultFile = path.join(path.dirname(logFile), `${jobId}.result.json`);
  const progressFile = resolveJobProgressFile(cwd, jobId);
  const eventsFile = resolveJobEventsFile(cwd, jobId);
  const cancelFile = process.env.GROK_CANCEL_FILE || resolveJobCancelFile(cwd, jobId);
  const snapshotRequested = Boolean(extras.snapshot);
  const writeCapable = Boolean(write || snapshotRequested);
  const inheritedInvocation = INHERITED_EVIDENCE.invocation;
  const invocation = inheritedInvocation
    ? updateInvocationEnvelope(inheritedInvocation, {
      jobId,
      tool: inheritedInvocation.tool || kind,
      model,
      effort,
      activeWorkspace: extras.activeWorkspace || inheritedInvocation.activeWorkspace || cwd,
      targetWorkspace: inheritedInvocation.targetWorkspace || cwd,
      executionWorkspace: extras.executionWorkspace || cwd,
      workspaceRoots: inheritedInvocation.workspaceRoots || [cwd]
    })
    : createInvocationEnvelope({
      jobId,
      tool: kind,
      model,
      effort,
      activeWorkspace: extras.activeWorkspace || cwd,
      targetWorkspace: cwd,
      executionWorkspace: extras.executionWorkspace || cwd,
      workspaceRoots: [extras.activeWorkspace, cwd].filter(Boolean),
      policyFingerprint: extras.policyEvidence?.fingerprint || null
    });
  const inheritedPolicyEvidence = extras.policyEvidence || INHERITED_EVIDENCE.policyEvidence || null;
  const writeLease = writeCapable
    ? acquireWorkspaceWriteLease(cwd, { jobId, phase: "snapshot" })
    : null;
  let promptFile;
  let snapshot;
  try {
    appendJobEvent(cwd, jobId, "accepted", {
      kind,
      write: Boolean(write),
      invocationId: invocation.invocationId,
      environmentId: invocation.environmentId
    });
    promptFile = writePromptFile(prompt);
    snapshot = snapshotRequested
      ? createWorkspaceSnapshot(cwd, { jobId, stateDir: resolveJobsDir(cwd) })
      : null;
    if (snapshot) {
      appendJobEvent(cwd, jobId, "snapshot_created", {
        workspaceRoot: cwd,
        fileCount: snapshot.fileCount ?? snapshot.files?.length ?? null
      });
    }
    if (writeLease) updateWorkspaceWriteLease(cwd, writeLease, { phase: "ready" });
  } catch (error) {
    appendJobEvent(cwd, jobId, "job_failed", {
      status: "failed_preparation",
      error: error instanceof Error ? error.message : String(error),
      processClosed: true
    });
    cleanupPromptFile(promptFile);
    releaseWorkspaceWriteLease(cwd, writeLease);
    throw error;
  }
  const job = {
    id: jobId,
    schemaVersion: 3,
    kind,
    title,
    prompt,
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    write: Boolean(write),
    model,
    effort,
    workspaceRoot: cwd,
    logFile,
    resultFile,
    progressFile,
    eventsFile,
    cancelFile,
    promptFile,
    usage: null,
    artifacts: [],
    ...extras,
    invocation,
    policyEvidence: inheritedPolicyEvidence,
    executionEnvironment: invocation.executionEnvironment,
    environmentId: invocation.environmentId,
    workspaceRoots: invocation.workspaceRoots,
    snapshotRequested,
    snapshot,
    writeLease
  };

  try {
    upsertJob(cwd, {
      id: jobId,
      kind,
      title,
      status: "running",
      write: Boolean(write),
      model,
      summary: title,
      logFile,
      resultFile
    });
    writeJobFile(cwd, job);
    fs.writeFileSync(logFile, "", "utf8");
    writeJobProgress(cwd, jobId, { phase: "queued", message: "queued" }, { replace: true });
  } catch (error) {
    cleanupPromptFile(promptFile);
    releaseWorkspaceWriteLease(cwd, writeLease);
    throw error;
  }
  return job;
}

async function runOrBackground(cwd, job, grokOptions, { background, json, renderPayload }) {
  const stagedPersonal = job.dataPolicy === "personal-sanitized" && job.disclosureStage;
  const policyInput = stagedPersonal
    ? {
      ...grokOptions,
      // The staged root is an execution workspace, not a new disclosure
      // target. Preserve the original project scope from job.workerPolicy.
      personalMode: "on",
      authorizedProject: null,
      activeWorkspace: grokOptions.cwd
    }
    : grokOptions;
  const workerPolicy = normalizeWorkerPolicy(
    { ...policyInput, prompt: job.prompt, readOnly: grokOptions.write !== true },
    { toolName: job.kind || "task", writeCapable: grokOptions.write === true }
  );
  grokOptions = {
    ...grokOptions,
    sandbox: workerPolicy.sandbox,
    permissionMode: workerPolicy.permissionMode,
    noSubagents: true,
    disableWebSearch: true,
    allow: workerPolicy.allow,
    deny: workerPolicy.deny,
    yolo: false,
    env: buildWorkerEnv(process.env)
  };
  job.workerPolicy = summarizeWorkerPolicy({
    ...workerPolicy.workerPolicy,
    ...(stagedPersonal ? {
      personalMode: job.workerPolicy?.personalMode ?? "once",
      externalProject: job.workerPolicy?.externalProject === true,
      authorizedProject: job.workerPolicy?.authorizedProject ?? null,
      activeWorkspace: job.workerPolicy?.activeWorkspace ?? null,
      sourceStaged: true,
      dataDisclosure: job.dataPolicy,
      disclosureConsent: "explicit"
    } : {})
  });
  job.policyEvidence = createWorkerPolicyEvidence({
    requested: job.policyEvidence?.requested || workerPolicy.policyEvidence.requested,
    effective: job.workerPolicy
  });
  job.invocation = updateInvocationEnvelope(job.invocation, {
    jobId: job.id,
    tool: job.invocation?.tool || job.kind,
    model: job.model,
    effort: job.effort,
    activeWorkspace: job.activeWorkspace || job.invocation?.activeWorkspace || cwd,
    targetWorkspace: job.invocation?.targetWorkspace || cwd,
    executionWorkspace: grokOptions.cwd,
    workspaceRoots: job.invocation?.workspaceRoots || [cwd],
    policyFingerprint: job.policyEvidence.fingerprint
  });
  job.executionEnvironment = job.invocation.executionEnvironment;
  job.environmentId = job.invocation.environmentId;
  job.workspaceRoots = job.invocation.workspaceRoots;
  if (stagedPersonal) {
    // Low-level Grok calls reapply policy. Keep them scoped to the isolated
    // staging root while the job evidence retains the original authorization.
    grokOptions.personalMode = "on";
    grokOptions.authorizedProject = null;
    grokOptions.activeWorkspace = grokOptions.cwd;
  }
  job.config = {
    ...(job.config || {}),
    workerPolicy: job.workerPolicy,
    policyEvidence: job.policyEvidence,
    invocation: job.invocation
  };
  writeJobFile(cwd, job);
  appendJobEvent(cwd, job.id, "policy_resolved", {
    fingerprint: job.policyEvidence.fingerprint,
    requested: job.policyEvidence.requested,
    authority: job.policyEvidence.authority,
    effective: job.policyEvidence.effective,
    invocationId: job.invocation.invocationId,
    environmentId: job.environmentId
  });
  if (background) {
    let spawned;
    try {
      spawned = spawnGrokBackground({
        ...grokOptions,
        resultFile: job.resultFile,
        logFile: job.logFile,
        progressFile: job.progressFile,
        cancelFile: job.cancelFile,
        companionPath: COMPANION_PATH,
        jobId: job.id
      });
    } catch (error) {
      appendJobEvent(cwd, job.id, "job_failed", {
        status: "failed_spawn",
        error: error instanceof Error ? error.message : String(error),
        processClosed: true
      });
      cleanupPromptFile(job.promptFile);
      cleanupDisclosureStage(job.disclosureStage);
      releaseJobWriteLease(cwd, job);
      throw error;
    }
    const pidFile = resolveJobPidFile(cwd, job.id);
    writePidFile(pidFile, spawned.pid);
    if (job.writeLease) {
      updateWorkspaceWriteLease(cwd, job.writeLease, {
        childPid: spawned.pid,
        phase: "running-background"
      });
    }
    const runningJob = {
      ...job,
      pid: spawned.pid,
      pidFile,
      binary: spawned.binary,
      args: spawned.args
    };
    appendJobEvent(cwd, job.id, "process_started", {
      pid: spawned.pid,
      background: true,
      backend: job.invocation.backend
    });
    upsertJob(cwd, { id: job.id, pid: spawned.pid, status: "running" });
    writeJobFile(cwd, runningJob);
    const otherRunning = listRunningJobs(cwd)
      .filter((item) => item.id !== job.id)
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title || item.summary || null
      }));
    const payload = {
      jobId: job.id,
      kind: job.kind,
      pid: spawned.pid,
      title: job.title,
      status: "running",
      concurrent: true,
      otherRunning
    };
    outputResult(json ? payload : renderBackgroundStarted(payload), Boolean(json));
    return null;
  }

  let grokResult;
  let finished;
  const cancellation = watchJobCancellation(cwd, job);
  try {
    if (job.writeLease) {
      updateWorkspaceWriteLease(cwd, job.writeLease, { phase: "running-foreground" });
    }
    appendJobEvent(cwd, job.id, "process_started", {
      pid: null,
      background: false,
      backend: job.invocation.backend
    });
    grokResult = await runGrokAsync({ ...grokOptions, signal: cancellation.signal });
    appendJobEvent(cwd, job.id, "process_exited", {
      exitCode: grokResult.status,
      signal: grokResult.signal || null,
      cancelled: grokResult.cancelled === true
    });
    appendJobEvent(cwd, job.id, "output_closed", {
      processClosed: true,
      outputStats: grokResult.outputStats || null
    });
    writeJobProgress(cwd, job.id, {
      phase: "closed",
      message: grokResult.cancelled ? "cancelled and closed" : "worker process closed",
      exitedAt: nowIso(),
      closedAt: nowIso()
    });
    finished = finalizeJob(cwd, job, grokResult, renderPayload?.finalizeExtras || {});
  } finally {
    cancellation.close();
    cleanupPromptFile(job.promptFile);
    cleanupDisclosureStage(job.disclosureStage);
    releaseJobWriteLease(cwd, job);
  }
  const builtPayload = renderPayload?.build
    ? renderPayload.build(finished, grokResult)
    : {
        jobId: job.id,
        kind: job.kind,
        status: finished.status,
        model: job.model,
        write: job.write,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        review: finished.review,
        artifacts: finished.artifacts,
        contract: finished.contract,
        bestOfN: job.bestOfN,
        worktree: job.worktree,
        check: job.check
      };
  const payload = {
    ...builtPayload,
    snapshot: builtPayload.snapshot ?? finished.snapshot ?? null,
    changes: builtPayload.changes ?? finished.changes ?? null,
    rollback: builtPayload.rollback ?? finished.rollback ?? null,
    cancellation: builtPayload.cancellation ?? finished.cancellation ?? null,
    outputStats: builtPayload.outputStats ?? finished.outputStats ?? null,
    invocation: builtPayload.invocation ?? finished.invocation ?? null,
    policyEvidence: builtPayload.policyEvidence ?? finished.policyEvidence ?? null,
    executionEnvironment: builtPayload.executionEnvironment ?? finished.executionEnvironment ?? null
  };
  outputResult(json ? payload : renderTaskResult(payload), Boolean(json));
  process.exitCode = finished.status === "completed" ? 0 : 1;
  return finished;
}

async function commandSetup(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });
  const cwd = resolveWorkspaceRoot(process.cwd());

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Pass only one of --enable-review-gate or --disable-review-gate");
  }
  if (options["enable-review-gate"]) {
    setConfig(cwd, { stopReviewGate: true });
  } else if (options["disable-review-gate"]) {
    setConfig(cwd, { stopReviewGate: false });
  }

  const availability = getGrokAvailability();
  const auth = availability.available
    ? getGrokAuthStatus()
    : { authenticated: false, detail: availability.reason };
  const config = getConfig(cwd);

  let versionOk = null;
  if (availability.version) {
    versionOk = compareSemver(availability.version, MIN_GROK_VERSION) >= 0;
  }

  let doctor = null;
  if (availability.available) {
    try {
      doctor = runGrokDoctor();
    } catch (err) {
      doctor = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  const nextSteps = [];
  if (!availability.available) {
    nextSteps.push("Install the Grok Build CLI and ensure `grok` is on your PATH.");
    nextSteps.push("Typical install location: `~/.grok/bin/grok`.");
  } else if (!auth.authenticated) {
    nextSteps.push("Run `grok login` (or login from your host agent shell).");
  }
  if (versionOk === false) {
    nextSteps.push(
      `Upgrade Grok CLI to ≥ ${MIN_GROK_VERSION} for full plugin features (current: ${availability.version}).`
    );
  }

  const payload = {
    ready: Boolean(availability.available && auth.authenticated),
    available: availability.available,
    binary: availability.binary,
    version: availability.version,
    versionOk,
    minVersion: MIN_GROK_VERSION,
    authenticated: auth.authenticated,
    authDetail: auth.detail,
    doctorOk: doctor ? doctor.ok : null,
    doctorDetail: doctor ? doctor.detail : null,
    stopReviewGate: Boolean(config.stopReviewGate),
    nextSteps,
    pluginRoot: ROOT_DIR
  };

  outputResult(options.json ? payload : renderSetupReport(payload), Boolean(options.json));
  process.exitCode = payload.ready ? 0 : 1;
}

async function commandTaskResumeCandidate(argv) {
  parseArgs(argv, { booleanOptions: ["json"] });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const sessions = listTaskSessions(cwd);
  const sessionId = getLastTaskSessionId(cwd);
  const runningJobs = listRunningJobs(cwd).map((job) => ({
    id: job.id,
    kind: job.kind,
    title: job.title || job.summary || null,
    status: job.status,
    grokSessionId: job.grokSessionId || null
  }));
  outputResult(
    {
      available: Boolean(sessionId) || sessions.length > 0,
      sessionId,
      sessions,
      runningJobs,
      canRunConcurrent: true,
      workspaceRoot: cwd
    },
    true
  );
}

async function commandTask(argv) {
  const expanded = expandArgv(argv);
  const { options, positionals } = parseArgs(expanded, {
    booleanOptions: [
      "background",
      "write",
      "read-only",
      "resume-last",
      "fresh",
      "worktree",
      "check",
      "json",
      "verbatim",
      ...CONTROL_BOOLEAN_OPTIONS, ...CONTRACT_BOOLEAN_OPTIONS
    ],
    valueOptions: [
      "model",
      "effort",
      "max-turns",
      "cwd",
      "best-of-n",
      "worktree-ref",
      "worktree-name",
      "resume-session",
      ...CONTROL_VALUE_OPTIONS, ...CONTRACT_VALUE_OPTIONS,
      ...PERSONAL_SCOPE_VALUE_OPTIONS
    ],
    arrayOptions: [...CONTROL_ARRAY_OPTIONS, ...CONTRACT_ARRAY_OPTIONS],
    aliasMap: {
      "read-only": "read-only",
      "resume-last": "resume-last",
      "resume-session": "resume-session",
      "max-turns": "max-turns",
      "best-of-n": "best-of-n",
      "worktree-ref": "worktree-ref",
      "worktree-name": "worktree-name",
      "personal-mode": "personal-mode",
      "authorized-project": "authorized-project",
      "active-workspace": "active-workspace"
    }
  });

  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    throw new Error("Missing task prompt. Example: task fix the failing tests");
  }

  const writeCapable = options["read-only"] !== true;
  const requestedDisclosureConsent = options["source-disclosure-consent"] === true;
  const personalMode = options["personal-mode"] || null;
  const authorizedProject = options["authorized-project"] || null;
  const activeWorkspace = options["active-workspace"]
    ? resolveWorkspaceRoot(options["active-workspace"])
    : process.cwd();
  const dataPolicyName = String(options["data-policy"] || (personalMode ? "personal-sanitized" : "strict")).trim().toLowerCase();
  const requestedPersonalMode = String(personalMode || "").trim().toLowerCase();
  const scopedConsent = dataPolicyName === "personal-sanitized" &&
    (requestedPersonalMode === "once" || requestedPersonalMode === "on") &&
    (authorizedProject != null || path.resolve(cwd) === path.resolve(activeWorkspace));
  const sourceDisclosureConsent = requestedDisclosureConsent || scopedConsent;
  const dataPolicy = normalizeDataPolicy(dataPolicyName, { consent: sourceDisclosureConsent });
  const workerPolicy = normalizeWorkerPolicy(
    { ...options, prompt, dataPolicy, sourceDisclosureConsent, activeWorkspace, readOnly: options["read-only"] === true, hostToolRequired: options["host-tool-required"] === true },
    { toolName: "grok_rescue", writeCapable }
  );

  const control = controlFromParsedOptions({
    ...options,
    sandbox: workerPolicy.sandbox,
    "permission-mode": workerPolicy.permissionMode,
    "no-subagents": true,
    "disable-web-search": true,
    "host-tool-required": false,
    deny: workerPolicy.deny
  });
  const writeMode = !options["read-only"] && control.permissionMode !== "plan";
  const completion = completionOptions(cwd, options, writeMode);
  const { expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure } = completion;
  const modelAlias = options.model ?? "grok-4.6";
  const model = normalizeModel(modelAlias);
  const effort = normalizeEffort(options.effort, modelAlias);
  const background = Boolean(options.background);
  const bestOfN = options["best-of-n"] ? Number(options["best-of-n"]) : null;
  const worktree =
    options["worktree-name"] ||
    (options.worktree ? true : false);
  const check = Boolean(options.check);

  assertGrokCliCompatibility({ bestOfN });

  if (dataPolicy === "personal-sanitized" && background) {
    throw new Error("personal-sanitized tasks currently require foreground execution so staged source can be applied and cleaned deterministically.");
  }
  if (dataPolicy === "personal-sanitized" && (options["resume-last"] || options["resume-session"] || options.worktree || options["worktree-name"])) {
    throw new Error("personal-sanitized tasks must start fresh and cannot use Grok-managed worktrees; the companion already provides an isolated staging workspace.");
  }
  if (dataPolicy === "personal-sanitized" && writeMode) {
    if (!rollbackOnFailure) {
      throw new Error("personal-sanitized write tasks require rollbackOnFailure=true.");
    }
    if (!allowedChangedFiles.length) {
      throw new Error("personal-sanitized write tasks require a non-empty allowedChangedFiles allowlist.");
    }
  }

  let resume = null;
  if (options.fresh) {
    resume = null;
  } else if (options["resume-session"]) {
    resume = String(options["resume-session"]).trim();
    if (!resume) {
      throw new Error("Empty --resume-session value.");
    }
  } else if (options["resume-last"]) {
    resume = getLastTaskSessionId(cwd);
    if (!resume) {
      throw new Error("No previous Grok task session found for this repository. Run without --resume-last.");
    }
  }

  const jobConfig = controlToJobConfig(control, {
    bestOfN,
    worktree: worktree || null,
    worktreeRef: options["worktree-ref"] || null,
    check,
    dataPolicy,
    personalMode: options["personal-mode"] || null,
    authorizedProject: options["authorized-project"] || null,
    activeWorkspace
  });
  const safePrompt = dataPolicy === "personal-sanitized" ? redactText(prompt).text : prompt;
  const promptContract = promptCompletionContract(cwd, dataPolicy, {
    expectedFiles,
    allowedChangedFiles,
    forbiddenChangedPaths,
    checkCommand,
    selfCheck: check
  });

  const job = createJobShell(cwd, {
    kind: "task",
    title: titleFromPrompt(safePrompt),
    prompt: appendCompletionContract(safePrompt, promptContract),
    write: writeMode,
    model,
    effort,
    extras: {
      resume,
      bestOfN,
      worktree: Boolean(worktree),
      check,
      expectedFiles,
      allowedChangedFiles, forbiddenChangedPaths,
      checkCommand,
      checkPolicy,
      checkTimeoutMs,
      snapshot,
      rollbackOnFailure,
      dataPolicy,
      sourceDisclosureConsent,
      personalMode: options["personal-mode"] || null,
      authorizedProject: options["authorized-project"] || null,
      activeWorkspace,
       config: { ...jobConfig, workerPolicy: summarizeWorkerPolicy(workerPolicy.workerPolicy) },
      workerPolicy: summarizeWorkerPolicy(workerPolicy.workerPolicy)
    }
  });

  if (dataPolicy === "personal-sanitized") {
    try {
      job.disclosureStage = createDisclosureStage(cwd, { jobId: job.id, dataPolicy, consent: sourceDisclosureConsent });
      job.workerPolicy = summarizeWorkerPolicy({ ...workerPolicy.workerPolicy, sourceStaged: true, dataDisclosure: dataPolicy, disclosureConsent: workerPolicy.workerPolicy.disclosureConsent });
      job.config = { ...(job.config || {}), workerPolicy: job.workerPolicy };
      writeJobFile(cwd, job);
    } catch (error) {
      cleanupPromptFile(job.promptFile);
      cleanupDisclosureStage(job.disclosureStage);
      throw error;
    }
  }

  let grokOptions = {
    promptFile: job.promptFile,
    cwd: job.disclosureStage?.stageRoot || cwd,
    write: writeMode || control.permissionMode === "plan",
    yolo: false,
    model,
    effort,
    resume,
    maxTurns: options["max-turns"] ? Number(options["max-turns"]) : undefined,
    bestOfN,
    check,
    worktree,
    worktreeRef: options["worktree-ref"],
    verbatim: Boolean(options.verbatim),
    dataPolicy,
    sourceDisclosureConsent,
    personalMode: options["personal-mode"] || null,
    authorizedProject: options["authorized-project"] || null,
    activeWorkspace,
    sourceStaged: Boolean(job.disclosureStage),
    env: buildWorkerEnv(process.env)
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  await runOrBackground(cwd, job, grokOptions, {
    background,
    json: options.json,
    renderPayload: {
      build: (finished) => ({
        jobId: job.id,
        kind: "task",
        status: finished.status,
        model,
        effort,
        write: writeMode,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        usage: finished.usage,
        artifacts: finished.artifacts,
        contract: finished.contract,
        config: finished.config || jobConfig,
        bestOfN,
        worktree: Boolean(worktree),
         check,
         workerPolicy: finished.workerPolicy || summarizeWorkerPolicy(workerPolicy.workerPolicy)
      })
    }
  });
}

async function commandPlan(argv) {
  const expanded = expandArgv(argv);
  const cfg = controlParseConfig();
  const { options, positionals } = parseArgs(expanded, cfg);
  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const userPrompt = positionals.join(" ").trim();
  if (!userPrompt) {
    throw new Error("Missing plan prompt. Example: plan redesign the retry layer");
  }

  const control = controlFromParsedOptions({ ...options, plan: true });
  const completion = completionOptions(cwd, options, true);
  const { expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure } = completion;
  const model = normalizeModel(options.model || "grok-4.6");
  const effort = normalizeEffort(options.effort, options.model || "grok-4.6");
  const prompt = appendCompletionContract(buildPlanModePrompt(userPrompt), { expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand });
  const jobConfig = controlToJobConfig(control, {});

  const job = createJobShell(cwd, {
    kind: "plan",
    title: titleFromPrompt(userPrompt, "Grok plan"),
    prompt,
    write: false,
    model,
    effort,
    extras: { config: jobConfig, expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure }
  });

  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: true,
    model,
    effort,
    yolo: false
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  await runOrBackground(cwd, job, grokOptions, {
    background: Boolean(options.background),
    json: options.json,
    renderPayload: {
      build: (finished) => ({
        jobId: job.id,
        kind: "plan",
        status: finished.status,
        model,
        write: false,
        grokSessionId: finished.grokSessionId,
        text: preferPlanArtifactText(finished.resultText, finished.artifacts),
        error: finished.error,
        usage: finished.usage,
        artifacts: finished.artifacts,
        contract: finished.contract,
        config: finished.config || jobConfig
      })
    }
  });
}



async function commandReview(argv, { adversarial = false } = {}) {
  const expanded = expandArgv(argv);
  const { options, positionals } = parseArgs(expanded, {
    booleanOptions: [
      "background",
      "json",
      "wait",
      "adversarial",
      "structured",
      "post-pending",
      ...CONTROL_BOOLEAN_OPTIONS, ...CONTRACT_BOOLEAN_OPTIONS
    ],
    valueOptions: ["base", "scope", "model", "effort", "cwd", "pr", ...CONTROL_VALUE_OPTIONS, ...CONTRACT_VALUE_OPTIONS],
    arrayOptions: [...CONTROL_ARRAY_OPTIONS, ...CONTRACT_ARRAY_OPTIONS]
  });

  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const focusText = positionals.join(" ").trim();
  const isAdversarial = adversarial || Boolean(options.adversarial);
  const postPending = Boolean(options["post-pending"]);
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope || "auto",
    pr: options.pr
  });

  if (target.empty) {
    const message = "Nothing to review: working tree/branch/PR diff looks empty.\n";
    outputResult(options.json ? { empty: true, message } : message, Boolean(options.json));
    return;
  }

  if (postPending && !target.pr) {
    throw new Error("--post-pending requires --pr <number>");
  }

  const control = controlFromParsedOptions(options);
  const completion = completionOptions(cwd, options, false);
  const { expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure } = completion;
  const prompt = buildStructuredReviewPrompt(target, focusText, { adversarial: isAdversarial });
  const model = normalizeModel(options.model || "grok-4.6");
  const effort = normalizeEffort(options.effort, options.model || "grok-4.6");
  const kind = isAdversarial ? "adversarial-review" : "review";
  const jobConfig = controlToJobConfig(control, { postPending });
  const job = createJobShell(cwd, {
    kind,
    title: titleFromPrompt(
      focusText || `${isAdversarial ? "Adversarial review" : "Review"} ${target.label}`,
      "Grok review"
    ),
    prompt,
    write: false,
    model,
    effort,
    extras: {
      config: jobConfig,
      expectedFiles,
      allowedChangedFiles, forbiddenChangedPaths,
      checkCommand,
      checkPolicy,
      checkTimeoutMs,
      snapshot,
      rollbackOnFailure,
      wantPostPending: postPending,
      reviewTarget: {
        kind: target.kind,
        label: target.label,
        baseRef: target.baseRef || null,
        pr: target.pr || null,
        headSha: target.headSha || null,
        owner: target.owner || null,
        repo: target.repo || null,
        diff: target.diff || null
      }
    }
  });

  const schema = fs.readFileSync(getReviewSchemaPath(), "utf8");
  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: false,
    model,
    effort,
    jsonSchema: schema
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  // Post-pending runs inside finalizeJob (foreground) and maybeFinalizeBackgroundJob
  // (background + status/result poll) via postPendingForFinishedJob.
  const finalizeExtras = {
    parseReview: true,
    wantPostPending: postPending,
    reviewTarget: job.reviewTarget
  };

  const runResult = await runOrBackground(cwd, job, grokOptions, {
    background: Boolean(options.background),
    json: options.json,
    renderPayload: {
      finalizeExtras,
      build: (finished) => ({
        jobId: job.id,
        kind,
        status: finished.status,
        model,
        write: false,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        review: finished.review,
        usage: finished.usage,
        artifacts: finished.artifacts,
        contract: finished.contract,
        postPending: finished.postPending || null,
        config: jobConfig
      })
    }
  });
  return runResult;
}

async function commandWorkflow(argv) {
  const expanded = expandArgv(argv);
  const sub = expanded[0];
  const rest = expanded.slice(1);

  if (!sub || sub === "list") {
    const { options } = parseArgs(rest, { booleanOptions: ["json"] });
    const cwd = resolveWorkspaceRoot(process.cwd());
    const workflows = discoverWorkflows(cwd);
    const payload = { workflows, count: workflows.length };
    if (options.json) {
      outputResult(payload, true);
    } else {
      const lines = ["# Grok workflows", ""];
      if (!workflows.length) {
        lines.push("_No workflows found in `.grok/workflows/` or `~/.grok/workflows/`._");
      } else {
        for (const wf of workflows) {
          lines.push(
            `- **${wf.name}** (${wf.scope}) — \`${wf.path}\`${wf.description ? `: ${wf.description}` : ""}`
          );
        }
      }
      lines.push("", "Run: `workflow run <name> [--arg key=value]...`");
      outputResult(`${lines.join("\n")}\n`, false);
    }
    return;
  }

  if (sub === "run") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: [
        "background",
        "json",
        "validate-only",
        ...CONTROL_BOOLEAN_OPTIONS, ...CONTRACT_BOOLEAN_OPTIONS
      ],
      valueOptions: ["model", "effort", "cwd", "arg", ...CONTROL_VALUE_OPTIONS, ...CONTRACT_VALUE_OPTIONS],
      arrayOptions: ["arg", ...CONTROL_ARRAY_OPTIONS, ...CONTRACT_ARRAY_OPTIONS]
    });
    const name = positionals[0];
    if (!name) {
      throw new Error("workflow run requires a name. Example: workflow run review-changes");
    }
    const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
    const argList = [].concat(options.arg || []);
    const args = parseWorkflowArgs(argList);
    const control = controlFromParsedOptions(options);
    const validateOnly = Boolean(options["validate-only"]);
    const prompt = buildWorkflowPrompt({
      name,
      args,
      validateOnly
    });
    const model = normalizeModel(options.model || "grok-4.6");
    const effort = normalizeEffort(options.effort, options.model || "grok-4.6");
    const jobConfig = controlToJobConfig(control, { workflowName: name });
    // validate-only must not grant yolo write+shell — smoke-check only.
    const writeCapable = !validateOnly;
    const completion = completionOptions(cwd, options, writeCapable);
    const { expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure } = completion;

    const job = createJobShell(cwd, {
      kind: "workflow",
      title: titleFromPrompt(`workflow ${name}`, "Grok workflow"),
      prompt,
      write: writeCapable,
      model,
      effort,
      extras: { config: jobConfig, workflowName: name, validateOnly, expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure }
    });

    let grokOptions = {
      promptFile: job.promptFile,
      cwd,
      write: writeCapable,
      model,
      effort
    };
    grokOptions = applyControlToGrokOptions(grokOptions, control);

    await runOrBackground(cwd, job, grokOptions, {
      background: Boolean(options.background),
      json: options.json,
      renderPayload: {
        build: (finished) => ({
          jobId: job.id,
          kind: "workflow",
          status: finished.status,
          model,
          write: writeCapable,
          grokSessionId: finished.grokSessionId,
          text: finished.resultText,
          error: finished.error,
          usage: finished.usage,
          artifacts: finished.artifacts,
        contract: finished.contract,
          config: jobConfig
        })
      }
    });
    return;
  }

  throw new Error(`Unknown workflow subcommand: ${sub}. Use list or run.`);
}

async function commandDesign(argv) {
  const expanded = expandArgv(argv);
  const { options, positionals } = parseArgs(expanded, controlParseConfig());
  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const brief = positionals.join(" ").trim();
  if (!brief) {
    throw new Error("Missing design brief. Example: design add multi-tenant billing");
  }
  const control = controlFromParsedOptions(options);
  const completion = completionOptions(cwd, options, true);
  const { expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure } = completion;
  const model = normalizeModel(options.model || "deep");
  const effort = normalizeEffort(options.effort || "high", options.model || "deep");
  const prompt = buildDesignPrompt(brief);
  const jobConfig = controlToJobConfig(control, {});

  const job = createJobShell(cwd, {
    kind: "design",
    title: titleFromPrompt(brief, "Grok design"),
    prompt,
    write: true,
    model,
    effort,
    extras: { config: jobConfig, expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure }
  });

  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: true,
    model,
    effort
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  await runOrBackground(cwd, job, grokOptions, {
    background: Boolean(options.background),
    json: options.json,
    renderPayload: {
      build: (finished) => ({
        jobId: job.id,
        kind: "design",
        status: finished.status,
        model,
        write: true,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        usage: finished.usage,
        artifacts: finished.artifacts,
        contract: finished.contract,
        config: jobConfig
      })
    }
  });
}

async function commandExecutePlan(argv) {
  const expanded = expandArgv(argv);
  const { options, positionals } = parseArgs(expanded, {
    booleanOptions: [
      "background",
      "json",
      "dry-run",
      "auto-pr",
      "no-graphite",
      "latest",
      ...CONTROL_BOOLEAN_OPTIONS, ...CONTRACT_BOOLEAN_OPTIONS
    ],
    valueOptions: [
      "model",
      "effort",
      "cwd",
      "concurrency",
      "instructions",
      "resume",
      ...CONTROL_VALUE_OPTIONS, ...CONTRACT_VALUE_OPTIONS
    ],
    arrayOptions: [...CONTROL_ARRAY_OPTIONS, ...CONTRACT_ARRAY_OPTIONS]
  });
  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const designDocPath = positionals[0] || null;
  const resumePlanId = options.resume || null;
  const wantLatest = Boolean(options.latest) || designDocPath === "latest";

  if (!designDocPath && !resumePlanId && !wantLatest) {
    throw new Error(
      "execute-plan requires <design-doc-path>, --latest (newest under .grok-designs/), or --resume <PLAN_ID>"
    );
  }

  let absDoc = null;
  if (!resumePlanId || designDocPath || wantLatest) {
    if (resumePlanId && !designDocPath && !wantLatest) {
      absDoc = null;
    } else {
      absDoc = resolveExecutePlanDesignPath(cwd, designDocPath, {
        latest: wantLatest || !designDocPath
      });
    }
  }

  const control = controlFromParsedOptions(options);
  const model = normalizeModel(options.model || "grok-4.6");
  const effort = normalizeEffort(options.effort, options.model || "grok-4.6");
  const dryRun = Boolean(options["dry-run"]);
  const prompt = buildExecutePlanPrompt(absDoc, {
    concurrency: options.concurrency ? Number(options.concurrency) : 4,
    dryRun,
    autoPr: Boolean(options["auto-pr"]),
    noGraphite: Boolean(options["no-graphite"]),
    instructions: options.instructions || "",
    resumePlanId
  });
  const jobConfig = controlToJobConfig(control, {});
  // Dry-run must not get --yolo; report linearized order only.
  const writeCapable = !dryRun;
  const completion = completionOptions(cwd, options, writeCapable);
  const { expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure } = completion;

  const job = createJobShell(cwd, {
    kind: "execute-plan",
    title: titleFromPrompt(
      resumePlanId
        ? `execute-plan resume ${resumePlanId}`
        : `execute-plan ${absDoc || designDocPath || "latest"}`,
      "Grok execute-plan"
    ),
    prompt,
    write: writeCapable,
    model,
    effort,
    extras: { config: jobConfig, designDocPath: absDoc, resumePlanId, dryRun, expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure }
  });

  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: writeCapable,
    model,
    effort
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  await runOrBackground(cwd, job, grokOptions, {
    background: Boolean(options.background),
    json: options.json,
    renderPayload: {
      build: (finished) => ({
        jobId: job.id,
        kind: "execute-plan",
        status: finished.status,
        model,
        write: writeCapable,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        usage: finished.usage,
        artifacts: finished.artifacts,
        contract: finished.contract,
        config: jobConfig
      })
    }
  });
}

async function commandBabysit(argv) {
  const expanded = expandArgv(argv);
  const { options, positionals } = parseArgs(expanded, {
    booleanOptions: ["background", "json", ...CONTROL_BOOLEAN_OPTIONS, ...CONTRACT_BOOLEAN_OPTIONS],
    valueOptions: ["model", "effort", "cwd", ...CONTROL_VALUE_OPTIONS, ...CONTRACT_VALUE_OPTIONS],
    arrayOptions: [...CONTROL_ARRAY_OPTIONS, ...CONTRACT_ARRAY_OPTIONS]
  });
  const { action, prs } = parseBabysitInvocation(positionals);
  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const control = controlFromParsedOptions(options);
  const model = normalizeModel(options.model || "grok-4.6");
  const effort = normalizeEffort(options.effort, options.model || "grok-4.6");
  const prompt = buildBabysitPrompt(action, prs);
  const jobConfig = controlToJobConfig(control, { babysitAction: action });
  const background =
    options.background != null
      ? Boolean(options.background)
      : babysitSupportsBackground(action);
  // list is read-only; add/remove/check may mutate watchlist or code.
  const writeCapable = action !== "list";
  const completion = completionOptions(cwd, options, writeCapable);
  const { expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure } = completion;

  const job = createJobShell(cwd, {
    kind: "babysit",
    title: titleFromPrompt(`babysit ${action} ${prs.join(" ")}`.trim(), "Grok babysit"),
    prompt,
    write: writeCapable,
    model,
    effort,
    extras: { config: jobConfig, babysitAction: action, prs, expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure }
  });

  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: writeCapable,
    model,
    effort
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  await runOrBackground(cwd, job, grokOptions, {
    background,
    json: options.json,
    renderPayload: {
      build: (finished) => ({
        jobId: job.id,
        kind: "babysit",
        status: finished.status,
        model,
        write: writeCapable,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        usage: finished.usage,
        artifacts: finished.artifacts,
        contract: finished.contract,
        config: jobConfig
      })
    }
  });
}

async function commandDocument(argv) {
  const expanded = expandArgv(argv);
  const { options, positionals } = parseArgs(expanded, {
    booleanOptions: ["background", "json", ...CONTROL_BOOLEAN_OPTIONS, ...CONTRACT_BOOLEAN_OPTIONS],
    valueOptions: ["type", "model", "effort", "cwd", "out", ...CONTROL_VALUE_OPTIONS, ...CONTRACT_VALUE_OPTIONS],
    arrayOptions: [...CONTROL_ARRAY_OPTIONS, ...CONTRACT_ARRAY_OPTIONS]
  });
  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const docType = normalizeDocumentType(options.type || "docx");
  const brief = positionals.join(" ").trim();
  if (!brief) {
    throw new Error("Missing document brief. Example: document --type pptx Launch deck for Grok plugin");
  }
  const outDir = options.out || path.join(cwd, ".grok-docs");
  const control = controlFromParsedOptions(options);
  const completion = completionOptions(cwd, options, true);
  const { expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure } = completion;
  const model = normalizeModel(options.model || "grok-4.6");
  const effort = normalizeEffort(options.effort, options.model || "grok-4.6");
  const prompt = appendCompletionContract(buildDocumentPrompt({ type: docType, brief, outputDir: outDir }), { expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand });
  const jobConfig = controlToJobConfig(control, { documentType: docType });

  const job = createJobShell(cwd, {
    kind: "document",
    title: titleFromPrompt(`${docType}: ${brief}`, "Grok document"),
    prompt,
    write: true,
    model,
    effort,
    extras: { config: jobConfig, documentType: docType, mediaDir: outDir, expectedFiles, allowedChangedFiles, forbiddenChangedPaths, checkCommand, checkPolicy, checkTimeoutMs, snapshot, rollbackOnFailure }
  });

  let grokOptions = {
    promptFile: job.promptFile,
    cwd,
    write: true,
    model,
    effort
  };
  grokOptions = applyControlToGrokOptions(grokOptions, control);

  await runOrBackground(cwd, job, grokOptions, {
    background: Boolean(options.background),
    json: options.json,
    renderPayload: {
      build: (finished) => ({
        jobId: job.id,
        kind: "document",
        status: finished.status,
        model,
        write: true,
        grokSessionId: finished.grokSessionId,
        text: finished.resultText,
        error: finished.error,
        usage: finished.usage,
        artifacts: finished.artifacts,
        contract: finished.contract,
        config: jobConfig
      })
    }
  });
}

async function commandSessions(argv) {
  const expanded = expandArgv(argv);
  const sub = expanded[0] || "list";
  const rest = expanded.slice(1);
  const cwd = resolveWorkspaceRoot(process.cwd());

  if (sub === "list") {
    const { options } = parseArgs(rest, {
      booleanOptions: ["json"],
      valueOptions: ["limit"]
    });
    const sessions = listSessions({
      cwd,
      limit: options.limit ? Number(options.limit) : 20
    });
    const payload = { sessions, count: sessions.length };
    if (options.json) {
      outputResult(payload, true);
    } else {
      const lines = ["# Grok sessions", ""];
      if (!sessions.length) {
        lines.push("_No sessions found for this workspace._");
      } else {
        for (const s of sessions) {
          lines.push(`- \`${s.id}\`${s.title ? ` — ${s.title}` : ""}`);
        }
      }
      lines.push("", "Export: `sessions export <id> [--out path]`");
      outputResult(`${lines.join("\n")}\n`, false);
    }
    return;
  }

  if (sub === "search") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: ["json"],
      valueOptions: ["limit"]
    });
    const query = positionals.join(" ").trim();
    if (!query) {
      throw new Error("sessions search requires a query");
    }
    const sessions = searchSessions({
      cwd,
      query,
      limit: options.limit ? Number(options.limit) : 20
    });
    const payload = { sessions, count: sessions.length, query };
    if (options.json) {
      outputResult(payload, true);
    } else {
      const lines = [`# Grok sessions matching “${query}”`, ""];
      for (const s of sessions) {
        lines.push(`- \`${s.id}\`${s.title ? ` — ${s.title}` : ""}`);
      }
      if (!sessions.length) lines.push("_No matches._");
      outputResult(`${lines.join("\n")}\n`, false);
    }
    return;
  }

  if (sub === "export") {
    const { options, positionals } = parseArgs(rest, {
      booleanOptions: ["json"],
      valueOptions: ["out"]
    });
    const sessionId = positionals[0];
    if (!sessionId) {
      throw new Error("sessions export requires a session id");
    }
    const result = exportSession(sessionId, {
      outputPath: options.out || null,
      cwd
    });
    if (options.json) {
      outputResult(result, true);
    } else if (result.outputPath) {
      outputResult(`Exported session \`${sessionId}\` to \`${result.outputPath}\`.\n`, false);
    } else {
      outputResult(result.markdown || "(empty export)\n", false);
    }
    return;
  }

  throw new Error(`Unknown sessions subcommand: ${sub}. Use list|search|export.`);
}

async function commandMedia(argv, kind) {
  const expanded = expandArgv(argv);
  const multiRef = [];
  const filtered = [];
  for (let i = 0; i < expanded.length; i += 1) {
    if (expanded[i] === "--ref" || expanded[i] === "--refs") {
      const value = expanded[i + 1];
      if (!value) {
        throw new Error(`Missing value for ${expanded[i]}`);
      }
      multiRef.push(value);
      i += 1;
      continue;
    }
    filtered.push(expanded[i]);
  }

  const { options, positionals } = parseArgs(filtered, {
    booleanOptions: ["background", "json"],
    valueOptions: ["model", "effort", "edit", "image", "aspect", "duration", "cwd", "out"]
  });

  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const promptText = positionals.join(" ").trim();
  if (!promptText && !options.edit && !options.image && !multiRef.length) {
    throw new Error(`Missing ${kind} prompt`);
  }

  const outputDir = options.out
    ? path.resolve(cwd, options.out)
    : resolveMediaOutputDir(cwd, kind);
  fs.mkdirSync(outputDir, { recursive: true });

  const model = normalizeModel(options.model || "grok-4.6");
  const effort = normalizeEffort(options.effort, options.model || "grok-4.6");
  const prompt =
    kind === "image"
      ? buildImagePrompt({
          prompt: promptText || "Improve or regenerate the asset",
          edit: options.edit ? path.resolve(cwd, options.edit) : null,
          outputDir,
          aspectRatio: options.aspect
        })
      : buildVideoPrompt({
          prompt: promptText || "Create a short product video",
          image: options.image ? path.resolve(cwd, options.image) : null,
          refs: multiRef.map((ref) => path.resolve(cwd, ref)),
          outputDir,
          duration: options.duration,
          aspectRatio: options.aspect
        });

  const job = createJobShell(cwd, {
    kind,
    title: titleFromPrompt(promptText || `${kind} generation`, `Grok ${kind}`),
    prompt,
    write: false,
    model,
    effort,
    extras: { mediaDir: outputDir, media: true }
  });

  // Grok 0.2.93: never pass --tools allowlist here (session create fails).
  // Use default toolset + denylist; do not pass --yolo (classifier may deny it;
  // single-prompt auto-approve still applies when configured).
  // Grok media tools write under ~/.grok/sessions/...; the companion copies into outputDir.
  const grokOptions = {
    promptFile: job.promptFile,
    cwd,
    media: true,
    write: false,
    yolo: false,
    model,
    effort,
    rules: `Media-only mode. Prefer image_gen / image_edit / image_to_video / reference_to_video. Session media paths are fine; the companion copies them into ${outputDir}. Do not edit application source code. Do not run shell commands or try to move files. When finished, print absolute paths to every created file.`
  };

  const finished = await runOrBackground(cwd, job, grokOptions, {
    background: Boolean(options.background),
    json: options.json,
    renderPayload: {
      build: (done) => {
        const artifacts =
          done.artifacts?.length
            ? done.artifacts
            : resolveMediaArtifactsForJob(
                { ...job, ...done, mediaDir: outputDir, kind },
                done.resultText || "",
                done.grokSessionId
              );
        return {
          jobId: job.id,
          kind,
          status: done.status,
          model,
          write: false,
          mediaDir: outputDir,
          grokSessionId: done.grokSessionId,
          text: done.resultText,
          error: done.error,
          artifacts: [...new Set(artifacts)]
        };
      }
    }
  });

  // Foreground: re-collect in case session files landed after parse.
  if (finished) {
    finished.artifacts = resolveMediaArtifactsForJob(
      { ...finished, mediaDir: outputDir, kind },
      finished.resultText || "",
      finished.grokSessionId
    );
    writeJobFile(cwd, finished);
  }
}

async function commandTransfer(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json"],
    valueOptions: ["source"]
  });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const availability = getGrokAvailability();
  const plan = buildTransferPlan(cwd, {
    source: options.source,
    grokBinary: availability.binary
  });
  outputResult(options.json ? plan : renderTransferReport(plan), Boolean(options.json));
  process.exitCode = plan.ok ? 0 : 1;
}

async function commandStopGateReview(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const config = getConfig(cwd);
  if (!config.stopReviewGate) {
    const payload = { enabled: false, blocked: false, message: "Stop review gate is disabled." };
    outputResult(options.json ? payload : "Stop review gate is disabled.\n", Boolean(options.json));
    return;
  }

  const target = collectStopGateContext(cwd);
  if (target.empty) {
    const payload = { enabled: true, blocked: false, empty: true, message: "No changes to review." };
    outputResult(options.json ? payload : "No changes to review for stop gate.\n", Boolean(options.json));
    return;
  }

  const prompt = buildStructuredReviewPrompt(
    target,
    "Stop-gate review of the previous Claude turn. Focus on bugs, security, and data-loss risks.",
    { adversarial: false }
  );
  const job = createJobShell(cwd, {
    kind: "stop-gate",
    title: "Stop-gate review",
    prompt,
    write: false,
    model: null,
    effort: null
  });

  const schema = fs.readFileSync(getReviewSchemaPath(), "utf8");
  // Safer stop-gate posture: denylist editors/shell, no yolo, optional sandbox read-only.
  const stopGatePolicy = normalizeWorkerPolicy(
    { cwd, readOnly: true, sandbox: "read-only", noSubagents: true, disableWebSearch: true },
    { toolName: "stop-gate", writeCapable: false }
  );
  job.workerPolicy = summarizeWorkerPolicy(stopGatePolicy.workerPolicy);
  job.policyEvidence = createWorkerPolicyEvidence({
    requested: job.policyEvidence?.requested || stopGatePolicy.policyEvidence.requested,
    effective: job.workerPolicy
  });
  job.invocation = updateInvocationEnvelope(job.invocation, {
    policyFingerprint: job.policyEvidence.fingerprint,
    executionWorkspace: cwd
  });
  job.executionEnvironment = job.invocation.executionEnvironment;
  job.environmentId = job.invocation.environmentId;
  writeJobFile(cwd, job);
  appendJobEvent(cwd, job.id, "policy_resolved", {
    fingerprint: job.policyEvidence.fingerprint,
    requested: job.policyEvidence.requested,
    authority: job.policyEvidence.authority,
    effective: job.policyEvidence.effective
  });
  let grokResult;
  let finished;
  const cancellation = watchJobCancellation(cwd, job);
  try {
    appendJobEvent(cwd, job.id, "process_started", { pid: null, background: false, backend: job.invocation.backend });
    grokResult = await runGrokAsync({
      promptFile: job.promptFile,
      cwd,
      write: false,
      yolo: false,
      sandbox: "read-only",
      noSubagents: true,
      jsonSchema: schema,
      signal: cancellation.signal
    });
    appendJobEvent(cwd, job.id, "process_exited", {
      exitCode: grokResult.status,
      signal: grokResult.signal || null,
      cancelled: grokResult.cancelled === true
    });
    appendJobEvent(cwd, job.id, "output_closed", { processClosed: true, outputStats: grokResult.outputStats || null });
    finished = finalizeJob(cwd, job, grokResult, { parseReview: true });
  } finally {
    cancellation.close();
    cleanupPromptFile(job.promptFile);
  }
  const blocked = Boolean(finished.review && reviewHasBlockingFindings(finished.review));
  const payload = {
    enabled: true,
    blocked,
    jobId: job.id,
    review: finished.review,
    text: finished.resultText,
    status: finished.status
  };

  if (options.json) {
    outputResult(payload, true);
  } else if (finished.review) {
    process.stdout.write(
      renderTaskResult({
        jobId: job.id,
        kind: "stop-gate",
        status: finished.status,
        review: finished.review,
        text: finished.resultText,
        grokSessionId: finished.grokSessionId
      })
    );
    if (blocked) {
      process.stdout.write(
        "\n**Stop gate:** blocking issues found (critical/high). Address them before ending the turn.\n"
      );
    }
  } else {
    process.stdout.write(finished.resultText || finished.error || "Stop-gate review finished.\n");
  }

  process.exitCode = blocked ? 2 : finished.status === "completed" ? 0 : 1;
}

async function commandStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json", "all"]
  });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const jobId = positionals[0] || null;

  let jobs = listJobs(cwd).map((job) => {
    const stored = readJobFile(cwd, job.id) || job;
    return maybeFinalizeBackgroundJob(cwd, stored);
  });

  if (!options.all) {
    jobs = jobs.slice(0, 15);
  }

  if (jobId) {
    const job = maybeFinalizeBackgroundJob(cwd, resolveJob(cwd, jobId));
    outputResult(options.json ? job : renderStatusReport([job], { jobId }), Boolean(options.json));
    return;
  }

  const config = getConfig(cwd);
  const runningJobs = jobs.filter((job) => isActiveJobStatus(job.status));
  const payload = {
    jobs,
    runningCount: runningJobs.length,
    concurrent: runningJobs.length > 1,
    workspaceRoot: cwd,
    stopReviewGate: config.stopReviewGate
  };
  outputResult(options.json ? payload : renderStatusReport(jobs, { concurrent: payload.concurrent }), Boolean(options.json));
}

async function commandResult(argv) {
  const { options, positionals } = parseArgs(argv, { booleanOptions: ["json"] });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const jobId = positionals[0] || null;
  let job = resolveJob(cwd, jobId);
  job = maybeFinalizeBackgroundJob(cwd, readJobFile(cwd, job.id) || job);
  outputResult(options.json ? job : renderStoredJobResult(job), Boolean(options.json));
  process.exitCode = job.status === "completed" ? 0 : isActiveJobStatus(job.status) ? 0 : 1;
}

async function commandCancel(argv) {
  const { options, positionals } = parseArgs(argv, { booleanOptions: ["json"] });
  const cwd = resolveWorkspaceRoot(process.cwd());
  const jobId = positionals[0] || null;
  let job = resolveJob(cwd, jobId);
  job = readJobFile(cwd, job.id) || job;

  if (!isActiveJobStatus(job.status)) {
    const payload = { jobId: job.id, cancelled: false, reason: `Job is already ${job.status}` };
    outputResult(options.json ? payload : `Job \`${job.id}\` is already ${job.status}.\n`, Boolean(options.json));
    return;
  }

  const marker = requestJobCancellation(cwd, job.id, "Cancelled by user");
  if (job.cancelFile && path.resolve(job.cancelFile) !== path.resolve(resolveJobCancelFile(cwd, job.id))) {
    writeJsonAtomic(job.cancelFile, marker);
  }
  upsertJob(cwd, {
    id: job.id,
    status: "cancel_requested",
    cancelRequestedAt: marker.requestedAt,
    summary: "Cancellation requested"
  });
  job = { ...job, status: "cancel_requested", cancelRequestedAt: marker.requestedAt };
  writeJobFile(cwd, job);
  writeJobProgress(cwd, job.id, {
    phase: "cancel_requested",
    message: "Cancellation requested",
    cancelRequestedAt: marker.requestedAt
  });
  appendJobEvent(cwd, job.id, "cancel_requested", {
    requestedAt: marker.requestedAt,
    reason: marker.reason,
    source: "grok_cancel"
  }, { at: marker.requestedAt });

  const pid = job.pid ?? readPidFile(resolveJobPidFile(cwd, job.id));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = readJobFile(cwd, job.id) || job;
    job = maybeFinalizeBackgroundJob(cwd, stored);
    if (!isActiveJobStatus(job.status)) break;
  }

  let killed = false;
  if (isActiveJobStatus(job.status) && pid) {
    killed = terminateProcessTree(pid, "SIGKILL");
    const exited = await waitForProcessExit(pid, { timeoutMs: 10_000 });
    if (exited && !tryReadResultPayload(job.resultFile).ok) {
      const timestamp = nowIso();
      writeJsonAtomic(job.resultFile, {
        exitCode: 1,
        signal: "SIGKILL",
        stdout: "",
        stderr: "",
        finishedAt: timestamp,
        sessionId: null,
        cancelled: true,
        cancellationReason: "Cancelled by user after forced process-tree termination",
        lifecycle: {
          cancelRequestedAt: marker.requestedAt,
          exitedAt: timestamp,
          closedAt: timestamp
        }
      });
      job = maybeFinalizeBackgroundJob(cwd, readJobFile(cwd, job.id) || job);
    }
  }

  const cancelled = job.status === "cancelled" || job.status === "cancelled_rolled_back";
  const payload = {
    jobId: job.id,
    cancelled,
    cancelRequested: true,
    processClosed: !pid || !isActiveJobStatus(job.status),
    killed,
    pid,
    status: job.status,
    rollback: job.rollback || null
  };
  outputResult(options.json ? payload : renderCancelReport(job, killed), Boolean(options.json));
  process.exitCode = cancelled ? 0 : 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "-h" || command === "--help" || command === "help") {
    printUsage();
    return;
  }

  try {
    switch (command) {
      case "setup":
        await commandSetup(rest);
        break;
      case "task":
        await commandTask(rest);
        break;
      case "plan":
        await commandPlan(rest);
        break;
      case "task-resume-candidate":
        await commandTaskResumeCandidate(rest);
        break;
      case "review":
        await commandReview(rest, { adversarial: false });
        break;
      case "adversarial-review":
        await commandReview(rest, { adversarial: true });
        break;
      case "workflow":
        await commandWorkflow(rest);
        break;
      case "design":
        await commandDesign(rest);
        break;
      case "execute-plan":
        await commandExecutePlan(rest);
        break;
      case "babysit":
        await commandBabysit(rest);
        break;
      case "document":
        await commandDocument(rest);
        break;
      case "sessions":
        await commandSessions(rest);
        break;
      case "image":
        await commandMedia(rest, "image");
        break;
      case "video":
        await commandMedia(rest, "video");
        break;
      case "transfer":
        await commandTransfer(rest);
        break;
      case "stop-gate-review":
        await commandStopGateReview(rest);
        break;
      case "status":
        await commandStatus(rest);
        break;
      case "result":
        await commandResult(rest);
        break;
      case "cancel":
        await commandCancel(rest);
        break;
      default:
        printUsage();
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

await main();
