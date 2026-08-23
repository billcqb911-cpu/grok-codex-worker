import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".grok-snapshots"
]);
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const HASH_ALGORITHM = "sha256";

function keyFor(relativePath) {
  return process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hashFile(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function walkFiles(root, { maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const files = [];
  const skipped = [];
  function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) visit(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          skipped.push({
            path: path.relative(root, full),
            reason: "symlink",
            target: fs.readlinkSync(full)
          });
        } catch {
          skipped.push({ path: path.relative(root, full), reason: "symlink-unreadable" });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(full);
        const relativePath = path.relative(root, full);
        if (stat.size > maxFileBytes) {
          skipped.push({
            path: relativePath,
            size: stat.size,
            hash: hashFile(full),
            reason: "max-file-size"
          });
          continue;
        }
        files.push({ path: relativePath, size: stat.size, hash: hashFile(full) });
      } catch {
        skipped.push({ path: path.relative(root, full), reason: "unreadable" });
      }
    }
  }
  visit(path.resolve(root));
  return { files, skipped };
}

export function resolveSnapshotDir(cwd, jobId, stateDir) {
  const root = stateDir || path.dirname(path.dirname(path.resolve(cwd)));
  const dir = path.join(root, "snapshots", String(jobId));
  return {
    dir,
    filesDir: path.join(dir, "files"),
    manifestPath: path.join(dir, "manifest.json")
  };
}

export function createWorkspaceSnapshot(cwd, { jobId, stateDir, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  if (!jobId) throw new Error("Snapshot jobId is required");
  const root = path.resolve(cwd);
  const locations = resolveSnapshotDir(root, jobId, stateDir);
  fs.mkdirSync(locations.filesDir, { recursive: true });
  const inventory = walkFiles(root, { maxFileBytes });
  const entries = [];
  for (const file of inventory.files) {
    const source = path.resolve(root, file.path);
    const target = path.resolve(locations.filesDir, file.path);
    if (!isWithin(locations.filesDir, target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    entries.push({
      path: file.path,
      key: keyFor(file.path),
      size: file.size,
      hash: file.hash,
      snapshotPath: target
    });
  }
  const manifest = {
    version: 2,
    hashAlgorithm: HASH_ALGORITHM,
    jobId: String(jobId),
    workspaceRoot: root,
    createdAt: new Date().toISOString(),
    maxFileBytes,
    files: entries,
    skipped: inventory.skipped
  };
  const tmp = `${locations.manifestPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, locations.manifestPath);
  return { ...locations, ...manifest };
}

export function readWorkspaceSnapshot(snapshot) {
  if (!snapshot?.manifestPath || !fs.existsSync(snapshot.manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(snapshot.manifestPath, "utf8"));
    return { ...snapshot, ...manifest };
  } catch {
    return null;
  }
}

export function buildWorkspaceChangeSet(cwd, snapshot) {
  const baseline = readWorkspaceSnapshot(snapshot);
  if (!baseline) throw new Error("Workspace snapshot is missing or corrupt");
  const current = walkFiles(path.resolve(cwd), { maxFileBytes: baseline.maxFileBytes });
  const before = new Map((baseline.files || []).map((item) => [item.key || keyFor(item.path), item]));
  const after = new Map(current.files.map((item) => [keyFor(item.path), item]));
  const beforeSkipped = new Map((baseline.skipped || []).map((item) => [keyFor(item.path), item]));
  const afterSkipped = new Map((current.skipped || []).map((item) => [keyFor(item.path), item]));
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [key, item] of after) {
    if (!before.has(key)) added.push(item);
    else if (before.get(key).hash !== item.hash) modified.push({ before: before.get(key), after: item });
  }
  for (const [key, item] of before) {
    if (!after.has(key)) deleted.push(item);
  }
  added.sort((a, b) => keyFor(a.path).localeCompare(keyFor(b.path)));
  modified.sort((a, b) => keyFor(a.after?.path || a.before?.path).localeCompare(keyFor(b.after?.path || b.before?.path)));
  deleted.sort((a, b) => keyFor(a.path).localeCompare(keyFor(b.path)));
  const changedFiles = [
    ...added.map((item) => ({ path: item.path, status: "added", beforeHash: null, afterHash: item.hash })),
    ...modified.map((entry) => ({ path: entry.after.path, status: "modified", beforeHash: entry.before.hash, afterHash: entry.after.hash })),
    ...deleted.map((item) => ({ path: item.path, status: "deleted", beforeHash: item.hash, afterHash: null }))
  ].sort((a, b) => keyFor(a.path).localeCompare(keyFor(b.path)));
  const unverifiedChanges = [];
  for (const key of new Set([...beforeSkipped.keys(), ...afterSkipped.keys()])) {
    const beforeItem = beforeSkipped.get(key) || null;
    const afterItem = afterSkipped.get(key) || null;
    const beforeFingerprint = JSON.stringify({
      reason: beforeItem?.reason,
      size: beforeItem?.size,
      hash: beforeItem?.hash,
      target: beforeItem?.target
    });
    const afterFingerprint = JSON.stringify({
      reason: afterItem?.reason,
      size: afterItem?.size,
      hash: afterItem?.hash,
      target: afterItem?.target
    });
    if (beforeFingerprint !== afterFingerprint) {
      const item = afterItem || beforeItem;
      unverifiedChanges.push({
        path: item.path,
        status: "unverified",
        reason: afterItem?.reason || beforeItem?.reason || "skipped",
        beforeHash: beforeItem?.hash || null,
        afterHash: afterItem?.hash || null
      });
    }
  }
  unverifiedChanges.sort((a, b) => keyFor(a.path).localeCompare(keyFor(b.path)));
  changedFiles.push(...unverifiedChanges);
  changedFiles.sort((a, b) => keyFor(a.path).localeCompare(keyFor(b.path)));
  return {
    version: 2,
    hashAlgorithm: baseline.hashAlgorithm || HASH_ALGORITHM,
    workspaceRoot: path.resolve(cwd),
    snapshotDir: baseline.dir,
    generatedAt: new Date().toISOString(),
    added,
    modified,
    deleted,
    unverifiedChanges,
    changedFiles,
    skipped: current.skipped,
    counts: { added: added.length, modified: modified.length, deleted: deleted.length }
  };
}

export function rollbackWorkspaceSnapshot(cwd, snapshot, changeSet = null) {
  const baseline = readWorkspaceSnapshot(snapshot);
  if (!baseline) throw new Error("Workspace snapshot is missing or corrupt");
  const changes = changeSet || buildWorkspaceChangeSet(cwd, baseline);
  const operations = [];
  for (const item of changes.added) {
    const target = path.resolve(cwd, item.path);
    if (!isWithin(cwd, target)) continue;
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      fs.rmSync(target, { force: true });
      operations.push({ action: "remove-added", path: item.path });
    }
  }
  for (const item of [...changes.modified.map((entry) => entry.before), ...changes.deleted]) {
    const target = path.resolve(cwd, item.path);
    const source = path.resolve(item.snapshotPath);
    if (!isWithin(cwd, target) || !isWithin(baseline.filesDir, source) || !fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    operations.push({ action: "restore", path: item.path });
  }
  return {
    ok: true,
    rolledBackAt: new Date().toISOString(),
    counts: { removed: changes.added.length, restored: changes.modified.length + changes.deleted.length },
    operations
  };
}
