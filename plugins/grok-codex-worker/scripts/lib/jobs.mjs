import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProcessRunning, readPidFile } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 3;
const PLUGIN_DATA_ENV = "CODEX_PLUGIN_DATA";
const GROK_STATE_ENV = "GROK_CODEX_PLUGIN_STATE";
const FALLBACK_STATE_ROOT = path.join(os.homedir(), ".grok", "codex-plugin", "state");
const MAX_JOBS = 50;
const MAX_TASK_SESSIONS = 20;
const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_LOCK_STALE_MS = 60_000;
const STATE_LOCK_POLL_MS = 25;
const WRITE_LEASE_VERSION = 1;
const FINALIZE_LOCK_STALE_MS = 5 * 60_000;
const JOB_EVENT_VERSION = 1;
const JOB_EVENT_MAX_BYTES = 16 * 1024;
const JOB_EVENT_LOCK_STALE_MS = 60_000;
const JOB_EVENT_SENSITIVE_KEY = /(?:secret|token|password|credential|authorization|cookie|private.?key|api.?key)/i;
const ACTIVE_JOB_STATUSES = new Set(["running", "cancel_requested", "exited", "closed"]);

/**
 * Only trust CODEX_PLUGIN_DATA when it clearly belongs to *this* grok plugin.
 * Host data dirs are often `<plugin>-<marketplace>`. Matching a marketplace
 * substring alone can trust foreign plugins, so we match the **plugin segment**
 * (basename starts with `grok-` or is `grok`). Claude state uses a separate
 * env (`GROK_CLAUDE_PLUGIN_STATE` / `claude-plugin` fallback) and is never
 * read here — Codex only honors `GROK_CODEX_PLUGIN_STATE` / `CODEX_PLUGIN_DATA`.
 */
export function isTrustedGrokPluginDataDir(dir) {
  if (!dir) {
    return false;
  }
  const n = String(dir).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const base = n.split("/").pop() || "";
  // Plugin id is the first hyphen segment(s) before marketplace suffix is hard;
  // require basename to start with "grok-" or equal "grok".
  if (base === "grok" || base.startsWith("grok-")) {
    return true;
  }
  // Explicit test / override path markers
  if (n.includes("grok-plugin-data") || /\/grok-jobs-[^/]+\/grok-plugin-data$/.test(n)) {
    return true;
  }
  return false;
}

/**
 * Read and validate a background result.json written by spawnGrokBackground.
 * Requires parseable JSON with exitCode + stdout (complete wrapper payload).
 * Partial/truncated files (mid-write kill, ENOSPC) return ok:false so the reaper
 * can fail the job instead of leaving it "running" forever.
 */
export function tryReadResultPayload(resultFile) {
  if (!resultFile || !fs.existsSync(resultFile)) {
    return { ok: false, reason: "missing", payload: null };
  }
  let raw = "";
  try {
    raw = fs.readFileSync(resultFile, "utf8");
  } catch {
    return { ok: false, reason: "unreadable", payload: null };
  }
  if (!String(raw).trim()) {
    return { ok: false, reason: "empty", payload: null };
  }
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, reason: "invalid", payload: null };
    }
    // Wrapper always writes these; absence ⇒ incomplete/corrupt write
    if (!Object.prototype.hasOwnProperty.call(payload, "exitCode")) {
      return { ok: false, reason: "incomplete", payload: null };
    }
    if (!Object.prototype.hasOwnProperty.call(payload, "stdout")) {
      return { ok: false, reason: "incomplete", payload: null };
    }
    return { ok: true, reason: null, payload };
  } catch {
    return { ok: false, reason: "unparseable", payload: null };
  }
}

/** True when a complete, parseable result.json is available for reconcile. */
export function hasResultFile(job) {
  return tryReadResultPayload(job?.resultFile).ok;
}

/**
 * Whether maybeFinalizeBackgroundJob should try to reconcile result.json.
 * Includes reaper false-failures so a good result is not permanently lost.
 */
export function shouldAttemptBackgroundFinalize(job) {
  if (!job || !hasResultFile(job)) {
    return false;
  }
  if (ACTIVE_JOB_STATUSES.has(job.status)) {
    return true;
  }
  if (job.status === "failed") {
    // Reaper race: pid gone before finalize, marked failed while result.json is good
    if (job.error === "Background Grok process is no longer running") {
      return true;
    }
    if (job.summary === "Process exited without writing a result") {
      return true;
    }
    // Never fully reconciled from result.json
    if (job.exitCode == null && !job.resultText) {
      return true;
    }
  }
  return false;
}

export function resolvePluginStateRoot() {
  if (process.env[GROK_STATE_ENV]) {
    return process.env[GROK_STATE_ENV];
  }
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  if (pluginDataDir && isTrustedGrokPluginDataDir(pluginDataDir)) {
    return path.join(pluginDataDir, "state");
  }
  return FALLBACK_STATE_ROOT;
}

export function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    lastTaskSessionId: null,
    taskSessions: [],
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const stateRoot = resolvePluginStateRoot();
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), "state.json");
}

export function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobPidFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.pid`);
}

export function resolveJobProgressFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.progress.json`);
}

export function resolveJobCancelFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.cancel.json`);
}

export function resolveJobEventsFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.events.ndjson`);
}

export function resolveWorkspaceWriteLeaseFile(cwd) {
  return path.join(resolveStateDir(cwd), "workspace-write.lease.json");
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

export function writeFileAtomic(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(temporary, contents);
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    let replaced = false;
    for (let attempt = 0; attempt < 3 && !replaced; attempt += 1) {
      sleepSync(STATE_LOCK_POLL_MS);
      try {
        fs.renameSync(temporary, filePath);
        replaced = true;
      } catch (retryError) {
        if (retryError?.code !== "EEXIST" && retryError?.code !== "EPERM") throw retryError;
        error = retryError;
      }
    }
    if (!replaced) throw error;
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return filePath;
}

export function writeJsonAtomic(filePath, value) {
  return writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sanitizeJobEventValue(value, key = "", depth = 0) {
  if (JOB_EVENT_SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth >= 6) return "[MAX_DEPTH]";
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value);
    if (bytes <= 2048) return value;
    return `${Buffer.from(value).subarray(0, 2048).toString("utf8")}...[TRUNCATED ${bytes - 2048} bytes]`;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, 100).map((item) => sanitizeJobEventValue(item, key, depth + 1));
    if (value.length > kept.length) kept.push(`[TRUNCATED ${value.length - kept.length} items]`);
    return kept;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([childKey, item]) => [childKey, sanitizeJobEventValue(item, childKey, depth + 1)])
    );
  }
  return value ?? null;
}

function acquireJobEventLock(cwd, jobId) {
  ensureStateDir(cwd);
  const lockFile = `${resolveJobEventsFile(cwd, jobId)}.lock`;
  const started = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      return { fd, lockFile };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > JOB_EVENT_LOCK_STALE_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started >= STATE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for job event lock: ${jobId}`);
      }
      sleepSync(STATE_LOCK_POLL_MS);
    }
  }
}

function releaseJobEventLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch {}
  try { fs.rmSync(lock.lockFile, { force: true }); } catch {}
}

export function readJobEvents(cwd, jobId, { afterSeq = 0, limit = 200 } = {}) {
  const filePath = resolveJobEventsFile(cwd, jobId);
  if (!fs.existsSync(filePath)) return [];
  const events = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (Number(event.seq) > Number(afterSeq || 0)) events.push(event);
    } catch {}
    if (events.length >= Math.max(1, Number(limit) || 200)) break;
  }
  return events;
}

export function appendJobEvent(cwd, jobId, type, payload = {}, { at = nowIso() } = {}) {
  if (!jobId) throw new Error("Job event requires a job id.");
  if (!/^[a-z][a-z0-9_]*$/.test(String(type || ""))) {
    throw new Error(`Invalid job event type: ${type}`);
  }
  const lock = acquireJobEventLock(cwd, jobId);
  try {
    const existing = readJobEvents(cwd, jobId, { afterSeq: 0, limit: Number.MAX_SAFE_INTEGER });
    const previousSeq = existing.length ? Number(existing[existing.length - 1].seq) || 0 : 0;
    let safePayload = sanitizeJobEventValue(payload);
    let event = {
      schemaVersion: JOB_EVENT_VERSION,
      seq: previousSeq + 1,
      at,
      type: String(type),
      payload: safePayload
    };
    let line = JSON.stringify(event);
    if (Buffer.byteLength(line) > JOB_EVENT_MAX_BYTES) {
      const digest = createHash("sha256").update(line).digest("hex");
      safePayload = {
        truncated: true,
        originalBytes: Buffer.byteLength(line),
        sha256: digest
      };
      event = { ...event, payload: safePayload };
      line = JSON.stringify(event);
    }
    fs.appendFileSync(resolveJobEventsFile(cwd, jobId), `${line}\n`, "utf8");
    return event;
  } finally {
    releaseJobEventLock(lock);
  }
}

function stateLockPath(cwd) {
  return `${resolveStateFile(cwd)}.lock`;
}

function acquireStateLock(cwd) {
  ensureStateDir(cwd);
  const lockPath = stateLockPath(cwd);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const started = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, `${token}\n`, "utf8");
      return { fd, lockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started >= STATE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Grok state lock: ${lockPath}`);
      }
      sleepSync(STATE_LOCK_POLL_MS);
    }
  }
}

function releaseStateLock(lock) {
  if (!lock) return;
  try {
    fs.closeSync(lock.fd);
  } catch {}
  try {
    if (fs.readFileSync(lock.lockPath, "utf8").trim() === lock.token) {
      fs.rmSync(lock.lockPath, { force: true });
    }
  } catch {}
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      taskSessions: Array.isArray(parsed.taskSessions) ? parsed.taskSessions : [],
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function pruneTaskSessions(sessions) {
  return [...(sessions ?? [])]
    .filter((entry) => entry && entry.sessionId)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, MAX_TASK_SESSIONS);
}

function saveStateUnlocked(cwd, state) {
  ensureStateDir(cwd);
  const next = {
    version: STATE_VERSION,
    lastTaskSessionId: state.lastTaskSessionId ?? null,
    taskSessions: pruneTaskSessions(state.taskSessions ?? []),
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: pruneJobs(state.jobs ?? [])
  };
  writeJsonAtomic(resolveStateFile(cwd), next);
  return next;
}

export function saveState(cwd, state) {
  const lock = acquireStateLock(cwd);
  try {
    return saveStateUnlocked(cwd, state);
  } finally {
    releaseStateLock(lock);
  }
}

export function updateState(cwd, mutate) {
  const lock = acquireStateLock(cwd);
  try {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  } finally {
    releaseStateLock(lock);
  }
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function setConfig(cwd, patch) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      ...patch
    };
  }).config;
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const index = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (index === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[index] = {
      ...state.jobs[index],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function writeJobFile(cwd, job) {
  ensureStateDir(cwd);
  const filePath = resolveJobFile(cwd, job.id);
  writeJsonAtomic(filePath, job);
  return filePath;
}

export function writeJobProgress(cwd, jobId, patch, { replace = false } = {}) {
  const filePath = resolveJobProgressFile(cwd, jobId);
  let current = {};
  if (!replace && fs.existsSync(filePath)) {
    try {
      current = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {}
  }
  const next = {
    ...current,
    ...patch,
    updatedAt: patch.updatedAt || nowIso()
  };
  writeJsonAtomic(filePath, next);
  return next;
}

export function requestJobCancellation(cwd, jobId, reason = "Cancelled by user") {
  const requestedAt = nowIso();
  const payload = { version: 1, jobId, status: "cancel_requested", reason, requestedAt };
  writeJsonAtomic(resolveJobCancelFile(cwd, jobId), payload);
  return payload;
}

export function readJobCancellation(cwd, jobId) {
  const filePath = resolveJobCancelFile(cwd, jobId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { version: 1, jobId, status: "cancel_requested", reason: "Cancellation marker is unreadable", requestedAt: null };
  }
}

export class WorkspaceBusyError extends Error {
  constructor(lease) {
    super(`Workspace already has an active write job${lease?.jobId ? `: ${lease.jobId}` : ""}. Wait for it to finish or cancel it before starting another write.`);
    this.name = "WorkspaceBusyError";
    this.lease = lease || null;
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function leaseOwnerIsAlive(lease) {
  return isProcessRunning(Number(lease?.childPid)) || isProcessRunning(Number(lease?.ownerPid));
}

export function acquireWorkspaceWriteLease(cwd, { jobId, phase = "preparing" } = {}) {
  ensureStateDir(cwd);
  const leaseFile = resolveWorkspaceWriteLeaseFile(cwd);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timestamp = nowIso();
    const lease = {
      version: WRITE_LEASE_VERSION,
      token: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      jobId: jobId || null,
      workspaceRoot: resolveWorkspaceRoot(cwd),
      ownerPid: process.pid,
      childPid: null,
      phase,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    try {
      const fd = fs.openSync(leaseFile, "wx");
      try {
        fs.writeFileSync(fd, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return lease;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readJsonFile(leaseFile);
      if (existing && leaseOwnerIsAlive(existing)) throw new WorkspaceBusyError(existing);
      try {
        fs.rmSync(leaseFile, { force: true });
      } catch {
        throw new WorkspaceBusyError(existing);
      }
    }
  }
  throw new WorkspaceBusyError(readJsonFile(leaseFile));
}

export function updateWorkspaceWriteLease(cwd, lease, patch = {}) {
  if (!lease?.token) return null;
  const leaseFile = resolveWorkspaceWriteLeaseFile(cwd);
  const current = readJsonFile(leaseFile);
  if (!current || current.token !== lease.token) return null;
  const next = { ...current, ...patch, token: current.token, updatedAt: nowIso() };
  writeJsonAtomic(leaseFile, next);
  Object.assign(lease, next);
  return next;
}

export function releaseWorkspaceWriteLease(cwd, lease) {
  if (!lease?.token) return false;
  const leaseFile = resolveWorkspaceWriteLeaseFile(cwd);
  const current = readJsonFile(leaseFile);
  if (!current || current.token !== lease.token) return false;
  fs.rmSync(leaseFile, { force: true });
  return true;
}

export function withJobFinalizationLock(cwd, jobId, callback) {
  ensureStateDir(cwd);
  const lockFile = path.join(resolveJobsDir(cwd), `${jobId}.finalize.lock`);
  const started = Date.now();
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockFile, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > FINALIZE_LOCK_STALE_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started >= STATE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for job finalization lock: ${jobId}`);
      }
      sleepSync(STATE_LOCK_POLL_MS);
    }
  }
  try {
    return callback();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(lockFile, { force: true }); } catch {}
  }
}

export function readJobFile(cwd, jobId) {
  const filePath = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Record a finished task/rescue session for multi-session resume.
 * Keeps lastTaskSessionId as the latest (backward compatible).
 */
export function recordTaskSession(cwd, { sessionId, jobId = null, title = null, kind = "task" } = {}) {
  if (!sessionId) {
    return;
  }
  updateState(cwd, (state) => {
    state.lastTaskSessionId = sessionId;
    const entry = {
      sessionId,
      jobId,
      title,
      kind,
      updatedAt: nowIso()
    };
    const existing = Array.isArray(state.taskSessions) ? state.taskSessions : [];
    state.taskSessions = [entry, ...existing.filter((s) => s.sessionId !== sessionId)];
  });
}

/** @deprecated Prefer recordTaskSession — kept for call sites that only have a session id. */
export function setLastTaskSessionId(cwd, sessionId) {
  recordTaskSession(cwd, { sessionId });
}

export function getLastTaskSessionId(cwd) {
  const state = loadState(cwd);
  if (state.lastTaskSessionId) {
    return state.lastTaskSessionId;
  }
  const sessions = listTaskSessions(cwd);
  return sessions[0]?.sessionId ?? null;
}

export function listTaskSessions(cwd) {
  const state = loadState(cwd);
  const sessions = pruneTaskSessions(state.taskSessions ?? []);
  if (sessions.length) {
    return sessions;
  }
  // Migrate v2 state that only had lastTaskSessionId
  if (state.lastTaskSessionId) {
    return [
      {
        sessionId: state.lastTaskSessionId,
        jobId: null,
        title: null,
        kind: "task",
        updatedAt: null
      }
    ];
  }
  return [];
}

export function readJobProgress(cwd, jobId) {
  const filePath = resolveJobProgressFile(cwd, jobId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Tail a job log. Truncates huge NDJSON status lines (e.g. available_commands dumps)
 * so status output stays readable.
 */
export function tailLog(filePath, maxLines = 12, { maxBytesPerLine = 480 } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  try {
    const stat = fs.statSync(filePath);
    const maxReadBytes = Math.max(64 * 1024, maxLines * maxBytesPerLine * 4);
    const start = Math.max(0, stat.size - maxReadBytes);
    const length = stat.size - start;
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString("utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxLines)
      .map((line) => {
        const bytes = Buffer.byteLength(line, "utf8");
        if (bytes <= maxBytesPerLine) {
          return line;
        }
        if (
          /available_commands|"tools"\s*:|"slash_commands"|stream_event/i.test(line)
        ) {
          return `[truncated ${bytes}-byte status/NDJSON line]`;
        }
        // Keep head of line for context
        let cut = line.slice(0, maxBytesPerLine);
        while (Buffer.byteLength(cut, "utf8") > maxBytesPerLine && cut.length > 0) {
          cut = cut.slice(0, -1);
        }
        return `${cut}…`;
      });
  } catch {
    return [];
  }
}

export function refreshJobLiveness(cwd, job) {
  if (!job || !ACTIVE_JOB_STATUSES.has(job.status)) {
    return job;
  }

  const pid = job.pid ?? readPidFile(resolveJobPidFile(cwd, job.id));
  if (pid && isProcessRunning(pid)) {
    const progress = readJobProgress(cwd, job.id);
    return { ...job, pid, alive: true, progress };
  }

  const stored = readJobFile(cwd, job.id);
  if (stored && stored.status && stored.status !== "running") {
    upsertJob(cwd, {
      id: job.id,
      status: stored.status,
      finishedAt: stored.finishedAt ?? nowIso(),
      summary: stored.summary ?? job.summary,
      exitCode: stored.exitCode ?? null,
      grokSessionId: stored.grokSessionId ?? job.grokSessionId,
      error: stored.error ?? null
    });
    return { ...job, ...stored, alive: false };
  }

  // Pid gone: only hold "running" when a *complete* result.json is ready to
  // finalize. Truncated/unparseable files must fail (not zombie forever).
  if (ACTIVE_JOB_STATUSES.has(job.status)) {
    const resultPath = job.resultFile || stored?.resultFile;
    const complete = tryReadResultPayload(resultPath);
    if (complete.ok) {
      return {
        ...job,
        ...(stored || {}),
        status: "running",
        pid: pid ?? job.pid ?? null,
        alive: false,
        pendingResult: true
      };
    }
    const corrupt =
      resultPath &&
      fs.existsSync(resultPath) &&
      !complete.ok &&
      complete.reason !== "missing";
    const finished = {
      ...job,
      status: "failed",
      finishedAt: nowIso(),
      summary: corrupt
        ? "Background Grok result file is corrupt or incomplete"
        : job.summary || "Process exited without writing a result",
      error: corrupt
        ? `Background result.json is ${complete.reason} (process dead)`
        : "Background Grok process is no longer running",
      alive: false
    };
    upsertJob(cwd, {
      id: job.id,
      status: "failed",
      finishedAt: finished.finishedAt,
      summary: finished.summary,
      error: finished.error
    });
    writeJobFile(cwd, finished);
    return finished;
  }

  return { ...job, alive: false };
}

export function listRunningJobs(cwd) {
  return listJobs(cwd)
    .map((job) => refreshJobLiveness(cwd, job))
    .filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
}

export function isActiveJobStatus(status) {
  return ACTIVE_JOB_STATUSES.has(status);
}

export class AmbiguousJobError extends Error {
  constructor(running) {
    const ids = running.map((job) => `\`${job.id}\``).join(", ");
    super(
      `Multiple Grok jobs are running (${running.length}). Pass a job id: ${ids}. Use \`/grok:status\` to list them.`
    );
    this.name = "AmbiguousJobError";
    this.running = running;
  }
}

export function resolveJob(cwd, jobId) {
  const jobs = listJobs(cwd).map((job) => refreshJobLiveness(cwd, job));
  if (jobId) {
    const match = jobs.find((job) => job.id === jobId) || readJobFile(cwd, jobId);
    if (!match) {
      throw new Error(`Unknown job id: ${jobId}`);
    }
    return refreshJobLiveness(cwd, match);
  }

  const running = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
  if (running.length === 1) {
    return running[0];
  }
  if (running.length > 1) {
    throw new AmbiguousJobError(running);
  }
  if (jobs[0]) {
    return jobs[0];
  }
  throw new Error("No Grok jobs found for this repository. Run a /grok command first.");
}
