import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  readJobFile,
  resolveJobFile,
  resolveWorkspaceWriteLeaseFile
} from "../plugins/grok-codex-worker/scripts/lib/jobs.mjs";
import { isProcessRunning, waitForProcessExit } from "../plugins/grok-codex-worker/scripts/lib/process.mjs";

const COMPANION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/grok-codex-worker/scripts/grok-companion.mjs"
);

function createMockBinary(root, { delayMs = 0, streaming = false } = {}) {
  const mock = path.join(root, `mock-${delayMs}-${streaming}.mjs`);
  const wrapper = path.join(root, process.platform === "win32" ? `mock-${delayMs}-${streaming}.cmd` : `mock-${delayMs}-${streaming}`);
  fs.writeFileSync(mock, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'const command = process.argv[2] || "";',
    'if (command === "version") { console.log("grok 1.0.5"); process.exit(0); }',
    `fs.writeFileSync(${JSON.stringify(path.join(root, "mock-task.pid"))}, String(process.pid));`,
    'fs.writeFileSync(path.join(process.cwd(), "target.txt"), "changed by first writer\\n");',
    delayMs ? `await new Promise((resolve) => setTimeout(resolve, ${delayMs}));` : "",
    streaming
      ? 'console.log(JSON.stringify({ type: "text", data: "done" })); console.log(JSON.stringify({ type: "end", sessionId: "stage1-bg" }));'
      : 'console.log(JSON.stringify({ text: "done", stopReason: "end_turn", sessionId: "stage1-fg" }));'
  ].filter(Boolean).join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(wrapper, `@echo off\r\nnode "${mock}" %*\r\n`);
  } else {
    fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nexec node "${mock}" "$@"\n`, { mode: 0o755 });
  }
  return wrapper;
}

function writeTaskArgs(extra = []) {
  return [
    COMPANION,
    "task",
    "--model", "mock",
    "--snapshot",
    "--rollback-on-failure",
    "--expected-file", "target.txt",
    "--allowed-changed-file", "target.txt",
    "--json",
    ...extra,
    "change target"
  ];
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("real companion processes serialize writes per canonical workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-stage1-scheduler-"));
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "grok-state");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(workspace, "target.txt"), "baseline\n");
  const binary = createMockBinary(root, { delayMs: 1500 });
  const env = { ...process.env, GROK_BINARY: binary, GROK_CODEX_PLUGIN_STATE: state };
  const previousState = process.env.GROK_CODEX_PLUGIN_STATE;
  process.env.GROK_CODEX_PLUGIN_STATE = state;
  try {
    const first = spawn(process.execPath, writeTaskArgs(), {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const firstDone = waitForChild(first);
    const startedDeadline = Date.now() + 10_000;
    while (
      Date.now() < startedDeadline &&
      fs.readFileSync(path.join(workspace, "target.txt"), "utf8") === "baseline\n"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.readFileSync(path.join(workspace, "target.txt"), "utf8"), "changed by first writer\n");

    const second = spawnSync(process.execPath, writeTaskArgs(), {
      cwd: workspace,
      env,
      encoding: "utf8",
      timeout: 10_000
    });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /active write job/i);

    const completed = await firstDone;
    assert.equal(completed.code, 0, completed.stderr || completed.stdout);
    assert.equal(JSON.parse(completed.stdout).status, "completed");
    assert.equal(fs.existsSync(resolveWorkspaceWriteLeaseFile(workspace)), false);
  } finally {
    if (previousState === undefined) delete process.env.GROK_CODEX_PLUGIN_STATE;
    else process.env.GROK_CODEX_PLUGIN_STATE = previousState;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("background writer automatically finalizes and releases its lease", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-stage1-background-"));
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "grok-state");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(workspace, "target.txt"), "baseline\n");
  const binary = createMockBinary(root, { streaming: true });
  const env = { ...process.env, GROK_BINARY: binary, GROK_CODEX_PLUGIN_STATE: state };
  const previousState = process.env.GROK_CODEX_PLUGIN_STATE;
  process.env.GROK_CODEX_PLUGIN_STATE = state;
  try {
    const started = spawnSync(process.execPath, writeTaskArgs(["--background"]), {
      cwd: workspace,
      env,
      encoding: "utf8",
      timeout: 10_000
    });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const startedPayload = JSON.parse(started.stdout);
    assert.equal(startedPayload.status, "running");

    const jobFile = resolveJobFile(workspace, startedPayload.jobId);
    const deadline = Date.now() + 15_000;
    let job;
    while (Date.now() < deadline) {
      job = readJobFile(workspace, startedPayload.jobId);
      if (job && job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(job, `job file not written: ${jobFile}`);
    assert.equal(job.status, "completed", JSON.stringify(job, null, 2));
    assert.equal(job.contract?.verified, true);
    assert.equal(job.outputStats?.stdout?.truncated, false);
    assert.equal(fs.existsSync(resolveWorkspaceWriteLeaseFile(workspace)), false);
    assert.equal(fs.readFileSync(path.join(workspace, "target.txt"), "utf8"), "changed by first writer\n");

    const results = await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [COMPANION, "result", startedPayload.jobId, "--json"], {
        cwd: workspace,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      waitForChild(child).then(resolve, reject);
    })));
    assert.ok(results.every((result) => JSON.parse(result.stdout).status === "completed"));
    assert.equal(await waitForProcessExit(job.pid, { timeoutMs: 10_000 }), true);
    assert.equal(isProcessRunning(job.pid), false);
    const mockPid = Number.parseInt(fs.readFileSync(path.join(root, "mock-task.pid"), "utf8"), 10);
    assert.equal(await waitForProcessExit(mockPid, { timeoutMs: 10_000 }), true);
    assert.equal(isProcessRunning(mockPid), false);
  } finally {
    if (previousState === undefined) delete process.env.GROK_CODEX_PLUGIN_STATE;
    else process.env.GROK_CODEX_PLUGIN_STATE = previousState;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
