import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("scope and check failures are both recorded before rollback", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-scope-check-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "grok-scope-check-state-"));
  const mock = path.join(workspace, "mock-grok.mjs");
  const wrapper = path.join(workspace, process.platform === "win32" ? "mock-grok.cmd" : "mock-grok");
  const companion = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/grok-codex-worker/scripts/grok-companion.mjs");
  fs.mkdirSync(path.join(workspace, "tests", "unit"), { recursive: true });
  fs.writeFileSync(mock, [
    "import fs from \"node:fs\";",
    "import path from \"node:path\";",
    "const root = process.cwd();",
    "fs.writeFileSync(path.join(root, \"tests\", \"unit\", \"test_narrative.py\"), \"new test\\n\");",
    "fs.mkdirSync(path.join(root, \"src\"), { recursive: true });",
    "fs.writeFileSync(path.join(root, \"src\", \"bad.py\"), \"forbidden\\n\");",
    "process.stdout.write(JSON.stringify({ text: \"done\", stopReason: \"end_turn\", sessionId: \"00000000-0000-4000-8000-000000000098\" }) + \"\\n\");"
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(wrapper, `@echo off\r\nnode "${mock}" %*\r\n`);
  } else {
    fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nexec node "${mock}" "$@"\n`, { mode: 0o755 });
  }
  const previousBinary = process.env.GROK_BINARY;
  const previousState = process.env.GROK_CODEX_PLUGIN_STATE;
  process.env.GROK_BINARY = wrapper;
  process.env.GROK_CODEX_PLUGIN_STATE = state;
  try {
    const result = spawnSync(process.execPath, [
      companion, "task", "--model", "mock", "--snapshot", "--rollback-on-failure",
      "--expected-file", "tests/unit/test_narrative.py",
      "--allowed-changed-file", "tests/unit/test_narrative.py",
      "--forbidden-changed-path", "src",
      "--check-command", `node -e "process.exit(7)"`,
      "--json", "modify files"
    ], { cwd: workspace, env: process.env, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "failed_scope_and_check_rolled_back");
    assert.equal(payload.contract.check.exitCode, 7);
    assert.equal(payload.contract.scope.ok, false);
    assert.equal(payload.rollback.ok, true);
    assert.deepEqual(payload.rollback.remainingChanges, { added: 0, modified: 0, deleted: 0 });
    assert.equal(fs.existsSync(path.join(workspace, "tests", "unit", "test_narrative.py")), false);
    assert.equal(fs.existsSync(path.join(workspace, "src", "bad.py")), false);
  } finally {
    if (previousBinary === undefined) delete process.env.GROK_BINARY; else process.env.GROK_BINARY = previousBinary;
    if (previousState === undefined) delete process.env.GROK_CODEX_PLUGIN_STATE; else process.env.GROK_CODEX_PLUGIN_STATE = previousState;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});
