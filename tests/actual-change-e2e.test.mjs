import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("write-capable no-op fails the actual-change contract and rolls back", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-no-op-e2e-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "grok-no-op-state-"));
  const mock = path.join(workspace, "mock-grok.mjs");
  const wrapper = path.join(workspace, process.platform === "win32" ? "mock-grok.cmd" : "mock-grok");
  const companion = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/grok-codex-worker/scripts/grok-companion.mjs");
  fs.mkdirSync(path.join(workspace, "tests", "unit"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "tests", "unit", "test_narrative.py"), "baseline\n");
  fs.writeFileSync(mock, "process.stdout.write(JSON.stringify({ text: \"no-op\", stopReason: \"end_turn\", sessionId: \"00000000-0000-4000-8000-000000000099\" }) + \"\\n\");\n");
  if (process.platform === "win32") fs.writeFileSync(wrapper, "@echo off\r\nnode \"" + mock + "\" %*\r\n");
  else fs.writeFileSync(wrapper, "#!/usr/bin/env bash\nexec node \"" + mock + "\" \"$@\"\n", { mode: 0o755 });
  const previousBinary = process.env.GROK_BINARY;
  const previousState = process.env.GROK_CODEX_PLUGIN_STATE;
  process.env.GROK_BINARY = wrapper;
  process.env.GROK_CODEX_PLUGIN_STATE = state;
  try {
    const result = spawnSync(process.execPath, [
      companion, "task", "--model", "mock", "--snapshot", "--rollback-on-failure",
      "--expected-file", "tests/unit/test_narrative.py",
      "--allowed-changed-file", "tests/unit/test_narrative.py", "--json", "no-op"
    ], { cwd: workspace, env: process.env, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "failed_no_change_rolled_back");
    assert.equal(payload.contract.verified, false);
    assert.equal(payload.contract.actualChange.ok, false);
    assert.equal(payload.contract.actualChange.zeroChange, true);
    assert.deepEqual(payload.changes.counts, { added: 0, modified: 0, deleted: 0 });
    assert.equal(fs.readFileSync(path.join(workspace, "tests", "unit", "test_narrative.py"), "utf8"), "baseline\n");
  } finally {
    if (previousBinary === undefined) delete process.env.GROK_BINARY; else process.env.GROK_BINARY = previousBinary;
    if (previousState === undefined) delete process.env.GROK_CODEX_PLUGIN_STATE; else process.env.GROK_CODEX_PLUGIN_STATE = previousState;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("write-capable task is verified when an expected file is actually changed", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-write-e2e-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "grok-write-state-"));
  const mock = path.join(workspace, "mock-grok.mjs");
  const wrapper = path.join(workspace, process.platform === "win32" ? "mock-grok.cmd" : "mock-grok");
  const companion = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/grok-codex-worker/scripts/grok-companion.mjs");
  fs.mkdirSync(path.join(workspace, "tests", "unit"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "tests", "unit", "test_narrative.py"), "baseline\n");
  const mockSource = [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'fs.writeFileSync(path.join(process.cwd(), "tests", "unit", "test_narrative.py"), "new test\\n");',
    'process.stdout.write(JSON.stringify({ text: "changed", stopReason: "end_turn", sessionId: "00000000-0000-4000-8000-000000000100" }) + "\\n");'
  ].join("\n");
  fs.writeFileSync(mock, mockSource);
  if (process.platform === "win32") fs.writeFileSync(wrapper, "@echo off\r\nnode \"" + mock + "\" %*\r\n");
  else fs.writeFileSync(wrapper, "#!/usr/bin/env bash\nexec node \"" + mock + "\" \"$@\"\n", { mode: 0o755 });
  const previousBinary = process.env.GROK_BINARY;
  const previousState = process.env.GROK_CODEX_PLUGIN_STATE;
  process.env.GROK_BINARY = wrapper;
  process.env.GROK_CODEX_PLUGIN_STATE = state;
  try {
    const result = spawnSync(process.execPath, [
      companion, "task", "--model", "mock", "--snapshot",
      "--expected-file", "tests/unit/test_narrative.py",
      "--allowed-changed-file", "tests/unit/test_narrative.py",
      "--check-command", "node -e \"process.exit(0)\"", "--json", "write file"
    ], { cwd: workspace, env: process.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.contract.verified, true);
    assert.equal(payload.contract.actualChange.ok, true);
    assert.equal(payload.contract.actualChange.hashAlgorithm, "sha256");
    assert.equal(payload.changes.counts.modified, 1);
    assert.deepEqual(payload.changes.changedFiles.map((item) => item.path), [path.join("tests", "unit", "test_narrative.py")]);
  } finally {
    if (previousBinary === undefined) delete process.env.GROK_BINARY; else process.env.GROK_BINARY = previousBinary;
    if (previousState === undefined) delete process.env.GROK_CODEX_PLUGIN_STATE; else process.env.GROK_CODEX_PLUGIN_STATE = previousState;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});
