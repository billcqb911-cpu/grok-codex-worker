import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  shellCommandForPlatform,
  validateSnapshotContract
} from "../plugins/grok-codex-worker/scripts/lib/contracts.mjs";
import { runCommand } from "../plugins/grok-codex-worker/scripts/lib/process.mjs";

test("scope and rollback controls fail closed without a snapshot", () => {
  assert.throws(
    () => validateSnapshotContract({ snapshot: false, allowedChangedFiles: ["tests/unit/test.py"] }),
    /require a snapshot/
  );
  assert.throws(
    () => validateSnapshotContract({ snapshot: false, rollbackOnFailure: true }),
    /require a snapshot/
  );
  assert.throws(
    () => validateSnapshotContract({ snapshot: true, noSnapshot: true }),
    /Conflicting snapshot options/
  );
  assert.throws(
    () => validateSnapshotContract({ writeCapable: true, snapshot: false, noSnapshot: true }),
    /Write-capable tasks require a workspace snapshot/
  );
  assert.doesNotThrow(() => validateSnapshotContract({ snapshot: false }));
});

test("Windows check command preserves quoted program arguments", () => {
  const spec = shellCommandForPlatform(`node -e "process.exit(7)"`);
  try {
    const result = runCommand(spec.command, spec.args);
    assert.equal(result.status, 7, result.stderr || result.stdout);
  } finally {
    spec.cleanup?.();
  }
});

test("CLI rejects no-snapshot scope control before creating a job", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-no-snapshot-"));
  const companion = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../plugins/grok-codex-worker/scripts/grok-companion.mjs"
  );
  try {
    const result = spawnSync(process.execPath, [
      companion,
      "task",
      "--no-snapshot",
      "--allowed-changed-file",
      "tests/unit/test_narrative.py",
      "--json",
      "make a test"
    ], { cwd: workspace, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /require a workspace snapshot|require a snapshot/);
    assert.deepEqual(fs.readdirSync(workspace), []);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
