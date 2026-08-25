import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function resolveExpectedFile(cwd, value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("Expected file paths must not be empty.");
  const resolved = path.resolve(cwd, raw);
  if (!isWithin(cwd, resolved)) throw new Error(`Expected file must be inside the workspace: ${raw}`);
  return resolved;
}

export function normalizeExpectedFiles(cwd, values = []) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.filter((value) => String(value ?? "").trim()).map((value) => resolveExpectedFile(cwd, value)))];
}

export function normalizeChangedPaths(cwd, values = []) {
  return normalizeExpectedFiles(cwd, values);
}

function pathKey(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function changedFilePaths(changeSet) {
  const paths = [
    ...(changeSet?.added || []).map((item) => item.path),
    ...(changeSet?.modified || []).map((item) => item.after?.path || item.before?.path),
    ...(changeSet?.deleted || []).map((item) => item.path),
    ...(changeSet?.unverifiedChanges || []).map((item) => item.path)
  ].filter(Boolean).map((item) => path.normalize(String(item)));
  return [...new Set(paths)].sort((a, b) => pathKey(a).localeCompare(pathKey(b)));
}

export function evaluateChangedFileScope(cwd, changeSet, {
  allowedChangedFiles = [],
  forbiddenChangedPaths = []
} = {}) {
  const allowed = normalizeChangedPaths(cwd, allowedChangedFiles);
  const forbidden = normalizeChangedPaths(cwd, forbiddenChangedPaths);
  const changed = changedFilePaths(changeSet);
  const changedAbsolute = changed.map((item) => path.resolve(cwd, item));
  const allowedKeys = new Set(allowed.map((item) => pathKey(item)));
  const outsideAllowed = allowed.length
    ? changedAbsolute.filter((item) => !allowedKeys.has(pathKey(item)))
    : [];
  const forbiddenMatches = forbidden.length
    ? changedAbsolute.filter((item) => forbidden.some((root) => isWithin(root, item)))
    : [];
  const violations = [...new Set([
    ...outsideAllowed.map((item) => path.relative(cwd, item)),
    ...forbiddenMatches.map((item) => path.relative(cwd, item))
  ])];
  return {
    ok: violations.length === 0,
    allowedChangedFiles: allowed,
    forbiddenChangedPaths: forbidden,
    changedFiles: changed,
    violations,
    message: violations.length
      ? "Workspace change scope violated. Unexpected changes: " + violations.join(", ")
      : null
  };
}

export function evaluateActualChangeContract(cwd, job = {}, changeSet = null) {
  const expectedFiles = normalizeExpectedFiles(cwd, job.expectedFiles || []);
  const changedFiles = changedFilePaths(changeSet);
  const unverifiedChanges = Array.isArray(changeSet?.unverifiedChanges)
    ? changeSet.unverifiedChanges
    : [];
  const changedKeys = new Set(changedFiles.map((item) => pathKey(path.resolve(cwd, item))));
  const missingExpectedFiles = expectedFiles.filter((item) => !changedKeys.has(pathKey(item)));
  const writeRequested = Boolean(job.write);
  const snapshotMissing = Boolean((writeRequested || expectedFiles.length) && !changeSet);
  const zeroChange = Boolean(writeRequested && changeSet && changedFiles.length === 0);
  let status = null;
  let message = null;
  if (snapshotMissing) {
    status = "failed_snapshot";
    message = "Actual workspace changes cannot be verified without a workspace snapshot.";
  } else if (zeroChange) {
    status = "failed_no_change";
    message = "Write-capable task completed without any workspace changes.";
  } else if (unverifiedChanges.length) {
    status = "failed_unverified_change";
    message = "Workspace changes include files excluded from snapshot restore: " +
      unverifiedChanges.map((item) => item.path).join(", ");
  } else if (missingExpectedFiles.length) {
    status = "failed_expected_change";
    message = "Expected file(s) were not changed: " + missingExpectedFiles.join(", ");
  }
  return {
    ok: !status,
    required: writeRequested || expectedFiles.length > 0,
    writeRequested,
    hashAlgorithm: changeSet?.hashAlgorithm || "sha256",
    expectedFiles,
    changedFiles,
    missingExpectedFiles,
    zeroChange,
    unverifiedChanges,
    counts: changeSet?.counts || { added: 0, modified: 0, deleted: 0 },
    status,
    message
  };
}
export function appendCompletionContract(prompt, {
  expectedFiles = [],
  allowedChangedFiles = [],
  forbiddenChangedPaths = [],
  checkCommand = null,
  selfCheck = false
} = {}) {
  const files = Array.isArray(expectedFiles) ? expectedFiles : [];
  if (!files.length && !allowedChangedFiles.length && !forbiddenChangedPaths.length && !checkCommand && !selfCheck) return prompt;
  const lines = [
    "",
    "Completion contract (the worker will verify this after you finish):",
    ...files.map((file) => `- Create or update this file: ${file}`),
    ...(allowedChangedFiles.length ? [`- Only change these workspace files: ${allowedChangedFiles.join(", ")}`] : []),
    ...(forbiddenChangedPaths.length ? [`- Do not change these workspace paths: ${forbiddenChangedPaths.join(", ")}`] : []),
    ...(checkCommand ? [`- The worker will run this check command in the workspace: ${checkCommand}`] : []),
    ...(selfCheck ? ["- Before your final response, inspect your own work and perform a concise self-check against the request and constraints."] : []),
    "- Do not claim completion unless the requested files really exist and contain the requested output."
  ];
  return `${prompt}${lines.join("\n")}`;
}

function nonEmptyFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function expectedDirectoryForJob(cwd, job) {
  if (job.kind === "plan") return { dir: path.join(cwd, ".grok-plans"), extensions: new Set([".md"]), label: "plan.md" };
  if (job.kind === "document") {
    const dir = job.mediaDir || path.join(cwd, ".grok-docs");
    const extension = `.${String(job.documentType || "docx").toLowerCase()}`;
    return { dir, extensions: new Set([extension, ".dotx"]), label: extension.slice(1) };
  }
  return null;
}

export function verifyProducedArtifacts(cwd, job, artifacts = []) {
  const expected = expectedDirectoryForJob(cwd, job);
  if (!expected) return { ok: true, kind: null, missing: [], valid: [], expectedDir: null };
  const valid = (Array.isArray(artifacts) ? artifacts : [])
    .map((artifact) => (typeof artifact === "string" ? { path: artifact } : artifact))
    .filter((artifact) => artifact?.path)
    .map((artifact) => ({ ...artifact, path: path.resolve(artifact.path) }))
    .filter((artifact) => isWithin(expected.dir, artifact.path))
    .filter((artifact) => expected.extensions.has(path.extname(artifact.path).toLowerCase()))
    .filter((artifact) => nonEmptyFile(artifact.path));
  if (!valid.length) return { ok: false, kind: "artifact", missing: [expected.label], valid: [], expectedDir: expected.dir, message: `Grok exited successfully but no non-empty ${expected.label} artifact was found under ${expected.dir}.` };
  return { ok: true, kind: "artifact", missing: [], valid, expectedDir: expected.dir };
}

export function verifyExpectedFiles(cwd, expectedFiles = []) {
  const paths = normalizeExpectedFiles(cwd, expectedFiles);
  const missing = paths.filter((file) => !nonEmptyFile(file));
  return { ok: missing.length === 0, paths, missing, message: missing.length ? `Expected file(s) were not produced: ${missing.join(", ")}` : null };
}

export function describeContract(job, artifactCheck, fileCheck, commandCheck, { grokOk = true, actualChange = null, policyCheck = null } = {}) {
  return {
    expectedFiles: fileCheck?.paths || [],
    missingFiles: fileCheck?.missing || [],
    expectedArtifactDir: artifactCheck?.expectedDir || null,
    artifactPaths: artifactCheck?.valid?.map((item) => item.path) || [],
    checkCommand: job.checkCommand || null,
    checkPolicy: job.checkPolicy || "on-success",
    checkTimeoutMs: job.checkTimeoutMs || null,
    allowedChangedFiles: job.allowedChangedFiles || [],
    forbiddenChangedPaths: job.forbiddenChangedPaths || [],
    check: commandCheck || null,
    actualChange,
    policy: policyCheck,
    workerPolicy: job.workerPolicy || null,
    grokOk,
    verified: Boolean(grokOk && (policyCheck?.ok ?? false) && (artifactCheck?.ok ?? true) && (fileCheck?.ok ?? true) && (commandCheck?.ok ?? true) && (actualChange?.ok ?? true))
  };
}

export function shellCommandForPlatform(command) {
  if (process.platform !== "win32") {
    return { command: process.env.SHELL || "/bin/sh", args: ["-lc", command], cleanup: null };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-check-"));
  const scriptPath = path.join(dir, "check.cmd");
  fs.writeFileSync(scriptPath, "@echo off\r\n" + String(command) + "\r\n", "utf8");
  return {
    command: scriptPath,
    args: [],
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}
export function validateSnapshotContract({
  writeCapable = false,
  snapshot = true,
  noSnapshot = false,
  allowedChangedFiles = [],
  forbiddenChangedPaths = [],
  rollbackOnFailure = false
} = {}) {
  if (snapshot && noSnapshot) {
    throw new Error("Conflicting snapshot options: choose snapshot or noSnapshot, not both.");
  }
  if (writeCapable && !snapshot) {
    throw new Error("Write-capable tasks require a workspace snapshot; remove noSnapshot and retry.");
  }
  const scopeRequested = allowedChangedFiles.length > 0 || forbiddenChangedPaths.length > 0;
  if ((scopeRequested || rollbackOnFailure) && !snapshot) {
    throw new Error("Workspace scope controls and rollbackOnFailure require a snapshot; enable snapshot or remove those controls.");
  }
}
const CHECK_POLICIES = new Set(["on-success", "always"]);

export function normalizeCheckPolicy(value) {
  const policy = String(value || "on-success").trim().toLowerCase();
  if (!CHECK_POLICIES.has(policy)) throw new Error(`Invalid check policy: ${value}. Expected on-success or always.`);
  return policy;
}

export function normalizeCheckTimeout(value) {
  if (value == null || value === "") return 120000;
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 3600000) {
    throw new Error("Check timeout must be between 100 and 3600000 milliseconds.");
  }
  return Math.floor(timeout);
}
