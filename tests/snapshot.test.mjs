import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWorkspaceChangeSet,
  createWorkspaceSnapshot,
  rollbackWorkspaceSnapshot
} from "../plugins/grok-codex-worker/scripts/lib/snapshot.mjs";

test("workspace snapshot tracks changes and restores the baseline", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-snapshot-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-snapshot-state-"));
  try {
    fs.writeFileSync(path.join(cwd, "keep.txt"), "before\n");
    fs.writeFileSync(path.join(cwd, "delete.txt"), "remove me\n");
    fs.mkdirSync(path.join(cwd, "node_modules"));
    fs.writeFileSync(path.join(cwd, "node_modules", "ignored.js"), "ignored\n");

    const snapshot = createWorkspaceSnapshot(cwd, { jobId: "job-1", stateDir });
    fs.writeFileSync(path.join(cwd, "keep.txt"), "after\n");
    fs.rmSync(path.join(cwd, "delete.txt"));
    fs.writeFileSync(path.join(cwd, "added.txt"), "new\n");
    fs.writeFileSync(path.join(cwd, "node_modules", "ignored.js"), "changed\n");

    const changes = buildWorkspaceChangeSet(cwd, snapshot);
    assert.equal(snapshot.hashAlgorithm, "sha256");
    assert.equal(changes.hashAlgorithm, "sha256");
    assert.deepEqual(changes.counts, { added: 1, modified: 1, deleted: 1 });
    assert.equal(changes.added[0].path, "added.txt");
    assert.equal(changes.modified[0].before.path, "keep.txt");
    assert.equal(changes.deleted[0].path, "delete.txt");
    assert.deepEqual(changes.changedFiles.map((item) => item.path), ["added.txt", "delete.txt", "keep.txt"]);
    const modified = changes.changedFiles.find((item) => item.path === "keep.txt");
    assert.equal(modified.status, "modified");
    assert.equal(modified.beforeHash, snapshot.files.find((item) => item.path === "keep.txt").hash);
    assert.ok(modified.afterHash);

    const rollback = rollbackWorkspaceSnapshot(cwd, snapshot, changes);
    assert.equal(rollback.ok, true);
    assert.equal(fs.readFileSync(path.join(cwd, "keep.txt"), "utf8"), "before\n");
    assert.equal(fs.readFileSync(path.join(cwd, "delete.txt"), "utf8"), "remove me\n");
    assert.equal(fs.existsSync(path.join(cwd, "added.txt")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("snapshot skips ignored directories and files above the configured limit", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-snapshot-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-snapshot-state-"));
  try {
    fs.mkdirSync(path.join(cwd, ".git"));
    fs.writeFileSync(path.join(cwd, ".git", "config"), "secret\n");
    fs.writeFileSync(path.join(cwd, "large.bin"), "123456789");
    fs.writeFileSync(path.join(cwd, "small.txt"), "ok");
    const snapshot = createWorkspaceSnapshot(cwd, { jobId: "job-2", stateDir, maxFileBytes: 8 });
    assert.deepEqual(snapshot.files.map((item) => item.path), ["small.txt"]);
    const skippedLarge = snapshot.skipped.find((item) => item.path === "large.bin");
    assert.equal(Boolean(skippedLarge), true);
    assert.equal(skippedLarge.reason, "max-file-size");
    assert.match(skippedLarge.hash, /^[a-f0-9]{64}$/);
    assert.equal(snapshot.files.some((item) => item.path.startsWith(".git")), false);

    fs.writeFileSync(path.join(cwd, "large.bin"), "changed-large");
    const changes = buildWorkspaceChangeSet(cwd, snapshot);
    assert.equal(changes.unverifiedChanges.length, 1);
    assert.deepEqual(changes.unverifiedChanges[0], {
      path: "large.bin",
      status: "unverified",
      reason: "max-file-size",
      beforeHash: skippedLarge.hash,
      afterHash: changes.skipped.find((item) => item.path === "large.bin").hash
    });
    assert.equal(changes.changedFiles.some((item) => item.path === "large.bin" && item.status === "unverified"), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
