import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPolicyCheckedCompanionInvocation } from "../plugins/grok-codex-worker/mcp/server.mjs";

test("policy-checked MCP personal read reaches the mock through sanitized staging", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-personal-mcp-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "grok-personal-mcp-state-"));
  const helper = fs.mkdtempSync(path.join(os.tmpdir(), "grok-personal-mcp-helper-"));
  const observed = path.join(helper, "observed.json");
  const mock = path.join(helper, "mock-grok.mjs");
  const wrapper = path.join(helper, process.platform === "win32" ? "mock-grok.cmd" : "mock-grok");
  const companion = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/grok-codex-worker/scripts/grok-companion.mjs");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "app.js"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(workspace, ".env"), "XAI_API_KEY=xai-abcdefghijklmnop\n", "utf8");
  fs.writeFileSync(mock, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    `const promptIndex = process.argv.indexOf("--prompt-file"); const prompt = promptIndex >= 0 ? fs.readFileSync(process.argv[promptIndex + 1], "utf8") : ""; fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), hasEnv: fs.existsSync(path.join(process.cwd(), ".env")), hasSource: fs.existsSync(path.join(process.cwd(), "src", "app.js")), hasSelfCheck: /perform a concise self-check/i.test(prompt) }));`,
    'process.stdout.write(JSON.stringify({ text: "reviewed", sessionId: "00000000-0000-4000-8000-000000000212" }) + "\\n");'
  ].join("\n"), "utf8");
  if (process.platform === "win32") fs.writeFileSync(wrapper, `@echo off\r\nnode ${JSON.stringify(mock)} %*\r\n`, "utf8");
  else fs.writeFileSync(wrapper, `#!/usr/bin/env sh\nexec node ${JSON.stringify(mock)} "$@"\n`, { mode: 0o755 });
  try {
    const invocation = buildPolicyCheckedCompanionInvocation("grok_personal_read", {
      cwd: workspace,
      prompt: "review source",
      model: "mock",
      check: true,
      json: true
    }, { cwd: workspace, activeWorkspace: workspace });
    const result = spawnSync(process.execPath, [companion, ...invocation.args], {
      cwd: workspace,
      env: { ...process.env, GROK_BINARY: wrapper, GROK_CODEX_PLUGIN_STATE: state },
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    const launch = JSON.parse(fs.readFileSync(observed, "utf8"));
    assert.equal(payload.status, "completed");
    assert.equal(payload.contract.verified, true);
    assert.equal(payload.contract.workerPolicy.externalProject, false);
    assert.equal(payload.contract.workerPolicy.authorizedProject, null);
    assert.equal(payload.contract.workerPolicy.activeWorkspace, fs.realpathSync(workspace));
    assert.equal(payload.config.activeWorkspace, fs.realpathSync(workspace));
    assert.equal(launch.hasEnv, false);
    assert.equal(launch.hasSource, true);
    assert.equal(launch.hasSelfCheck, true);
    assert.notEqual(path.resolve(launch.cwd), fs.realpathSync(workspace));
    assert.equal(fs.existsSync(launch.cwd), false);
    assert.equal(launch.args.filter((item) => item === "--memory").length, 0);
    assert.equal(launch.args.filter((item) => item === "--no-memory").length, 1);
    assert.equal(launch.args.filter((item) => item === "--check").length, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(helper, { recursive: true, force: true });
  }
});

test("personal write edits staging and applies a verified clean change", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-personal-e2e-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "grok-personal-state-"));
  const helper = fs.mkdtempSync(path.join(os.tmpdir(), "grok-personal-helper-"));
  const mock = path.join(helper, "mock-grok.mjs");
  const wrapper = path.join(helper, process.platform === "win32" ? "mock-grok.cmd" : "mock-grok");
  const companion = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/grok-codex-worker/scripts/grok-companion.mjs");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "app.js"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(workspace, ".env"), "XAI_API_KEY=xai-abcdefghijklmnop\n", "utf8");
  fs.writeFileSync(mock, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'if (fs.existsSync(path.join(process.cwd(), ".env"))) process.exit(9);',
    'const promptIndex = process.argv.indexOf("--prompt-file");',
    'const prompt = promptIndex >= 0 ? fs.readFileSync(process.argv[promptIndex + 1], "utf8") : "";',
    'if (prompt.includes(workspacePathSentinel)) process.exit(10);',
    'fs.writeFileSync(path.join(process.cwd(), "src", "app.js"), "export const value = 2;\\n");',
    'process.stdout.write(JSON.stringify({ text: "changed", sessionId: "00000000-0000-4000-8000-000000000211" }) + "\\n");'
  ].join("\n").replace("workspacePathSentinel", JSON.stringify(workspace)), "utf8");
  if (process.platform === "win32") fs.writeFileSync(wrapper, `@echo off\r\nnode ${JSON.stringify(mock)} %*\r\n`, "utf8");
  else fs.writeFileSync(wrapper, `#!/usr/bin/env sh\nexec node ${JSON.stringify(mock)} "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, GROK_BINARY: wrapper, GROK_CODEX_PLUGIN_STATE: state };
  try {
    const result = spawnSync(process.execPath, [
      companion, "task", "--model", "mock", "--data-policy", "personal-sanitized",
      "--source-disclosure-consent", "--personal-mode", "once", "--active-workspace", workspace,
      "--snapshot", "--rollback-on-failure",
      "--expected-file", "src/app.js", "--allowed-changed-file", "src/app.js",
      "--json", "update the source"
    ], { cwd: workspace, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.contract.verified, true);
    assert.equal(payload.contract.workerPolicy.dataDisclosure, "personal-sanitized");
    assert.equal(payload.contract.workerPolicy.sourceStaged, true);
    assert.equal(payload.contract.workerPolicy.externalProject, false);
    assert.equal(payload.contract.workerPolicy.authorizedProject, null);
    assert.equal(payload.contract.workerPolicy.activeWorkspace, fs.realpathSync(workspace));
    assert.equal(payload.config.activeWorkspace, fs.realpathSync(workspace));
    assert.equal(fs.readFileSync(path.join(workspace, "src", "app.js"), "utf8"), "export const value = 2;\n");
    assert.match(fs.readFileSync(path.join(workspace, ".env"), "utf8"), /xai-abcdefghijklmnop/);
    assert.doesNotMatch(result.stdout, /xai-abcdefghijklmnop/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(helper, { recursive: true, force: true });
  }
});

test("personal write rejects background, missing allowlist, and missing rollback", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-personal-contract-"));
  const companion = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/grok-codex-worker/scripts/grok-companion.mjs");
  fs.writeFileSync(path.join(workspace, "app.js"), "export const x = 1;\n", "utf8");
  const base = [companion, "task", "--data-policy", "personal-sanitized", "--source-disclosure-consent", "change source"];
  try {
    const noRollback = spawnSync(process.execPath, base, { cwd: workspace, encoding: "utf8" });
    assert.equal(noRollback.status, 1);
    assert.match(noRollback.stderr, /rollbackOnFailure=true/);
    const background = spawnSync(process.execPath, [companion, "task", "--read-only", "--background", "--data-policy", "personal-sanitized", "--source-disclosure-consent", "review"], { cwd: workspace, encoding: "utf8" });
    assert.equal(background.status, 1);
    assert.match(background.stderr, /foreground execution/);
    const bestOfN = spawnSync(process.execPath, [companion, "task", "--read-only", "--best-of-n", "2", "review"], { cwd: workspace, encoding: "utf8" });
    assert.equal(bestOfN.status, 1);
    assert.match(bestOfN.stderr, /does not support.*bestOfN/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
