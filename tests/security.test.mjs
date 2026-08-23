import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  auditGrokConfiguration,
  buildWorkerEnv,
  cleanupCommandGuard,
  createCommandGuard,
  evaluateWorkerPolicy,
  HOST_ONLY_COMMANDS,
  normalizeWorkerPolicy,
  WORKER_DENY_RULES
} from "../plugins/grok-codex-worker/scripts/lib/security.mjs";

test("configuration preflight rejects Grok hooks, MCP, LSP, plugins, and permission sections", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-security-config-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "repo");
  fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  try {
    fs.writeFileSync(path.join(home, ".grok", "config.toml"), "[models]\ndefault = \"grok-4.6\"\n");
    assert.equal(auditGrokConfiguration({ cwd, home }).ok, true);
    fs.writeFileSync(path.join(home, ".grok", "config.toml"), "[permission]\nallow = [\"Bash(*)\"]\n");
    assert.equal(auditGrokConfiguration({ cwd, home }).ok, false);
    fs.writeFileSync(path.join(home, ".grok", "config.toml"), "[models]\ndefault = \"grok-4.6\"\n");
    fs.mkdirSync(path.join(cwd, ".grok", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".grok", "hooks", "unsafe.json"), "{}");
    assert.equal(auditGrokConfiguration({ cwd, home }).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worker environment forwards runtime plumbing but drops Codex and provider secrets", () => {
  const env = buildWorkerEnv({
    Path: "C:\\tools",
    USERPROFILE: "C:\\Users\\test",
    GROK_BINARY: "C:\\Users\\test\\.grok\\bin\\grok.exe",
    GROK_CODEX_PLUGIN_STATE: "C:\\state",
    CODEX_API_KEY: "codex-secret",
    CODEX_API_URL: "https://codex.invalid",
    OPENAI_API_KEY: "openai-secret",
    GITHUB_TOKEN: "github-secret",
    XAI_API_KEY: "xai-secret"
  });
  assert.equal(env.Path, "C:\\tools");
  assert.equal(env.USERPROFILE, "C:\\Users\\test");
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.CODEX_API_URL, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_CODEX_WORKER_POLICY, "host-tools-denied;web-disabled;env-allowlist;compat-disabled");
  assert.equal(env.GROK_CURSOR_MCPS_ENABLED, "false");
  assert.equal(env.GROK_CLAUDE_HOOKS_ENABLED, "false");
  assert.equal(env.GROK_SUBAGENTS, "0");
  assert.equal(env.GROK_WEB_FETCH, "0");
});

test("worker policy forces bounded profiles and cannot be widened by callers", () => {
  const read = normalizeWorkerPolicy({ readOnly: true, sandbox: "read-only" }, { toolName: "grok_review", writeCapable: false });
  assert.equal(read.sandbox, "strict");
  assert.equal(read.permissionMode, "dontAsk");
  assert.equal(read.noSubagents, true);
  assert.equal(read.disableWebSearch, true);
  assert.ok(read.deny.includes("Bash(*)"));
  assert.ok(read.deny.includes("MCPTool(*)"));
  assert.ok(read.deny.includes("WebFetch"));
  assert.ok(read.deny.includes("Edit(*)"));

  const write = normalizeWorkerPolicy({}, { toolName: "grok_rescue", writeCapable: true });
  assert.equal(write.sandbox, "strict");
  assert.equal(write.permissionMode, "dontAsk");
  assert.equal(write.noSubagents, true);
  assert.equal(write.disableWebSearch, true);
  assert.deepEqual(write.workerPolicy.hostTools, "codex-only");
  assert.deepEqual(WORKER_DENY_RULES, ["Bash(*)", "MCPTool(*)", "WebFetch", "WebSearch"]);
  assert.equal(evaluateWorkerPolicy(write.workerPolicy, { writeRequested: true }).ok, true);
  assert.equal(evaluateWorkerPolicy(null, { writeRequested: true }).ok, false);
  assert.throws(() => normalizeWorkerPolicy({ sandbox: "off" }, { writeCapable: true }), /Unsafe Grok sandbox/);
  assert.throws(() => normalizeWorkerPolicy({ permissionMode: "bypassPermissions" }, { writeCapable: true }), /Unsafe Grok permission mode/);
  assert.throws(() => normalizeWorkerPolicy({ allow: ["Bash(npm test *)"] }, { writeCapable: true }), /Caller-supplied Grok allow/);
  assert.throws(() => normalizeWorkerPolicy({ agent: "custom" }, { writeCapable: true }), /Custom agents/);
});

test("host-tool handoffs fail before a Grok child can start", () => {
  assert.throws(
    () => normalizeWorkerPolicy({ hostToolRequired: true }, { toolName: "grok_rescue", writeCapable: true }),
    /Host-tool handoff required/
  );
  assert.throws(
    () => normalizeWorkerPolicy({ prompt: "Call the Codex browser plugin and upload the report." }, { toolName: "grok_rescue", writeCapable: true }),
    /Host-tool request detected/
  );
  assert.doesNotThrow(() => normalizeWorkerPolicy(
    { prompt: "Implement a browser parser and an MCP-compatible data type in project code." },
    { toolName: "grok_rescue", writeCapable: true }
  ));
});

test("command guard blocks normal host and credential CLI resolution", () => {
  const dir = createCommandGuard();
  try {
    for (const name of ["codex", "claude", "mcp", "gh", "ssh"]) {
      assert.equal(fs.existsSync(path.join(dir, process.platform === "win32" ? `${name}.cmd` : name)), true);
    }
    assert.ok(HOST_ONLY_COMMANDS.includes("codex"));
  } finally {
    cleanupCommandGuard(dir);
    assert.equal(fs.existsSync(dir), false);
  }
});

test("real task launch applies the bounded sandbox, strips secrets, and avoids yolo", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-security-e2e-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "grok-security-state-"));
  const observed = path.join(os.tmpdir(), `grok-security-observed-${Date.now()}-${Math.random()}.json`);
  const mock = path.join(os.tmpdir(), `grok-security-mock-${Date.now()}-${Math.random()}.mjs`);
  const wrapper = path.join(os.tmpdir(), `grok-security-wrapper-${Date.now()}${process.platform === "win32" ? ".cmd" : ""}`);
  const companion = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/grok-codex-worker/scripts/grok-companion.mjs");
  fs.writeFileSync(mock, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ env: { codex: process.env.CODEX_API_KEY, openai: process.env.OPENAI_API_KEY, github: process.env.GITHUB_TOKEN }, args: process.argv.slice(2) }));`,
    `fs.writeFileSync(${JSON.stringify(path.join(workspace, "allowed.txt"))}, "changed\\n");`,
    "process.stdout.write(JSON.stringify({ text: 'secure', stopReason: 'end_turn', sessionId: '00000000-0000-4000-8000-000000000777' }) + '\\n');"
  ].join("\n"));
  if (process.platform === "win32") fs.writeFileSync(wrapper, `@echo off\r\nnode "${mock}" %*\r\n`);
  else fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nexec node "${mock}" "$@"\n`, { mode: 0o755 });
  const previous = {
    binary: process.env.GROK_BINARY,
    state: process.env.GROK_CODEX_PLUGIN_STATE,
    codex: process.env.CODEX_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    github: process.env.GITHUB_TOKEN
  };
  process.env.GROK_BINARY = wrapper;
  process.env.GROK_CODEX_PLUGIN_STATE = state;
  process.env.CODEX_API_KEY = "codex-secret";
  process.env.OPENAI_API_KEY = "openai-secret";
  process.env.GITHUB_TOKEN = "github-secret";
  try {
    const result = spawnSync(process.execPath, [
      companion, "task", "--model", "mock", "--snapshot", "--expected-file", "allowed.txt", "--json", "secure task"
    ], { cwd: workspace, env: process.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    const launch = JSON.parse(fs.readFileSync(observed, "utf8"));
    assert.equal(launch.env.codex, undefined);
    assert.equal(launch.env.openai, undefined);
    assert.equal(launch.env.github, undefined);
    assert.ok(launch.args.includes("--sandbox") && launch.args.includes("strict"));
    assert.ok(launch.args.includes("--permission-mode") && launch.args.includes("dontAsk"));
    assert.ok(launch.args.includes("--disable-web-search"));
    assert.ok(launch.args.includes("--no-subagents"));
    const unquotedArgs = launch.args.map((arg) => String(arg).replace(/^"|"$/g, ""));
    assert.ok(unquotedArgs.includes("Bash(*)"), JSON.stringify(launch.args));
    assert.ok(unquotedArgs.includes("MCPTool(*)"), JSON.stringify(launch.args));
    assert.equal(payload.contract.policy.ok, true);
    assert.equal(payload.contract.verified, true);
    assert.ok(!launch.args.includes("--yolo"));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key === "binary" ? "GROK_BINARY" : key === "state" ? "GROK_CODEX_PLUGIN_STATE" : key === "codex" ? "CODEX_API_KEY" : key === "openai" ? "OPENAI_API_KEY" : "GITHUB_TOKEN"];
      else process.env[key === "binary" ? "GROK_BINARY" : key === "state" ? "GROK_CODEX_PLUGIN_STATE" : key === "codex" ? "CODEX_API_KEY" : key === "openai" ? "OPENAI_API_KEY" : "GITHUB_TOKEN"] = value;
    }
    for (const file of [mock, wrapper, observed]) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});
