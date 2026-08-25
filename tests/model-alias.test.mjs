import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const companion = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/grok-codex-worker/scripts/grok-companion.mjs"
);

test("configured model aliases target the authenticated Grok 4.6 endpoint", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-model-alias-workspace-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "grok-model-alias-state-"));
  const helper = fs.mkdtempSync(path.join(os.tmpdir(), "grok-model-alias-helper-"));
  const mock = path.join(helper, "mock-grok.mjs");
  const wrapper = path.join(helper, process.platform === "win32" ? "mock-grok.cmd" : "mock-grok");

  fs.writeFileSync(mock, [
    'process.stdout.write(JSON.stringify({ text: JSON.stringify(process.argv.slice(2)), sessionId: "00000000-0000-4000-8000-000000000231" }) + "\\n");'
  ].join("\n"), "utf8");
  if (process.platform === "win32") {
    fs.writeFileSync(wrapper, `@echo off\r\nnode ${JSON.stringify(mock)} %*\r\n`, "utf8");
  } else {
    fs.writeFileSync(wrapper, `#!/usr/bin/env sh\nexec node ${JSON.stringify(mock)} "$@"\n`, { mode: 0o755 });
  }

  const env = {
    ...process.env,
    GROK_BINARY: wrapper,
    GROK_CODEX_PLUGIN_STATE: state
  };

  try {
    for (const alias of ["fast", "deep", "default", "grok", "grok-4.6"]) {
      const result = spawnSync(process.execPath, [
        companion, "task", "--read-only", "--model", alias, "--json", `probe ${alias}`
      ], { cwd: workspace, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "completed");
      const args = JSON.parse(payload.text);
      const modelIndex = args.indexOf("-m");
      assert.notEqual(modelIndex, -1, `mock did not receive a model for ${alias}`);
      assert.equal(args[modelIndex + 1], "grok-4.6", `stale model alias for ${alias}`);
      if (alias === "fast") {
        const effortIndex = args.indexOf("--effort");
        assert.notEqual(effortIndex, -1);
        assert.equal(args[effortIndex + 1], "low");
      } else {
        const effortIndex = args.indexOf("--effort");
        assert.notEqual(effortIndex, -1);
        assert.equal(args[effortIndex + 1], "high");
      }
    }
    const defaultResult = spawnSync(process.execPath, [
      companion, "task", "--read-only", "--json", "probe default-effort"
    ], { cwd: workspace, env, encoding: "utf8" });
    assert.equal(defaultResult.status, 0, defaultResult.stderr || defaultResult.stdout);
    const defaultArgs = JSON.parse(JSON.parse(defaultResult.stdout).text);
    assert.equal(defaultArgs[defaultArgs.indexOf("-m") + 1], "grok-4.6");
    assert.equal(defaultArgs[defaultArgs.indexOf("--effort") + 1], "high");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(helper, { recursive: true, force: true });
  }
});
