import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpHarness, parseToolResult } from "./helpers/mcp-harness.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PLUGIN = path.join(REPO_ROOT, "plugins", "grok-codex-worker");
const SOURCE_MANIFEST = JSON.parse(
  fs.readFileSync(path.join(SOURCE_PLUGIN, ".codex-plugin", "plugin.json"), "utf8")
);

function installedPluginRoot() {
  if (process.env.GROK_CODEX_INSTALLED_CACHE) {
    return path.resolve(process.env.GROK_CODEX_INSTALLED_CACHE);
  }
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  return path.join(
    codexHome,
    "plugins",
    "cache",
    "grok-codex-worker",
    SOURCE_MANIFEST.name,
    SOURCE_MANIFEST.version
  );
}

function fileHashes(root) {
  const hashes = new Map();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        hashes.set(relative, createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"));
      }
    }
  };
  visit(root);
  return hashes;
}

function sameHashes(left, right) {
  if (left.size !== right.size) return false;
  for (const [relative, digest] of left) {
    if (right.get(relative) !== digest) return false;
  }
  return true;
}

function writeMockGrok(helperRoot, observedFile) {
  const mock = path.join(helperRoot, "mock-grok.mjs");
  const wrapper = path.join(helperRoot, process.platform === "win32" ? "mock-grok.cmd" : "mock-grok");
  fs.writeFileSync(mock, [
    'import fs from "node:fs";',
    `fs.appendFileSync(${JSON.stringify(observedFile)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");`,
    'process.stdout.write(JSON.stringify({ text: "installed-cache-ok", sessionId: "00000000-0000-4000-8000-000000000824", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, modelUsage: { "grok-4.6": { inputTokens: 10, outputTokens: 5, modelCalls: 1, costUSD: 0.0001 } } }) + "\\n");'
  ].join("\n"), "utf8");
  if (process.platform === "win32") {
    fs.writeFileSync(wrapper, `@echo off\r\n${JSON.stringify(process.execPath)} ${JSON.stringify(mock)} %*\r\n`, "utf8");
  } else {
    fs.writeFileSync(wrapper, `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mock)} "$@"\n`, { mode: 0o755 });
  }
  return wrapper;
}

test("installed plugin cache preserves Personal current/external workspace scope over stdio", async (t) => {
  const cacheRoot = installedPluginRoot();
  if (!fs.existsSync(cacheRoot)) {
    t.skip(`installed cache for ${SOURCE_MANIFEST.version} not found at ${cacheRoot}`);
    return;
  }

  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(cacheRoot, ".codex-plugin", "plugin.json"), "utf8")
  );
  assert.equal(installedManifest.name, SOURCE_MANIFEST.name);
  assert.equal(installedManifest.version, SOURCE_MANIFEST.version);
  const cacheHashes = fileHashes(cacheRoot);
  const sourceHashes = fileHashes(SOURCE_PLUGIN);
  if (!process.env.GROK_CODEX_INSTALLED_CACHE && !sameHashes(cacheHashes, sourceHashes)) {
    t.skip(`installed cache for ${SOURCE_MANIFEST.version} is stale; reinstall before running this regression`);
    return;
  }
  assert.deepEqual(cacheHashes, sourceHashes, "installed cache differs from plugin source");

  const activeWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cache-active-"));
  const externalWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cache-external-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cache-state-"));
  const helper = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cache-helper-"));
  const observedFile = path.join(helper, "observed.ndjson");
  const wrapper = writeMockGrok(helper, observedFile);
  const serverPath = path.join(cacheRoot, "mcp", "server.mjs");
  fs.writeFileSync(path.join(activeWorkspace, "package.json"), '{"name":"active"}\n', "utf8");
  fs.writeFileSync(path.join(externalWorkspace, "package.json"), '{"name":"external"}\n', "utf8");
  fs.writeFileSync(path.join(activeWorkspace, ".env"), "API_KEY=test-secret-value\n", "utf8");

  const client = new McpHarness(serverPath, {
    cwd: cacheRoot,
    env: { ...process.env, GROK_BINARY: wrapper, GROK_CODEX_PLUGIN_STATE: state },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  try {
    const initialized = await client.initialize({ name: "installed-cache-test", version: "1.0.0" });
    assert.equal(initialized.result?.serverInfo?.name, "grok-codex-worker");

    const current = parseToolResult(await client.request("tools/call", {
      name: "grok_personal_read",
      arguments: {
        cwd: activeWorkspace,
        activeWorkspace,
        prompt: "inspect the active project",
        model: "grok-4.6",
        effort: "high",
        json: true
      }
    }));
    assert.equal(current.status, "completed");
    assert.equal(current.contract.verified, true);
    assert.equal(current.contract.workerPolicy.externalProject, false);
    assert.equal(current.contract.workerPolicy.authorizedProject, null);
    assert.equal(current.contract.workerPolicy.activeWorkspace, fs.realpathSync(activeWorkspace));
    assert.equal(current.config.activeWorkspace, fs.realpathSync(activeWorkspace));
    assert.equal(current.invocation.mcpRequestId, 2);
    assert.equal(current.invocation.jobId, current.jobId);
    assert.equal(current.invocation.policyFingerprint, current.policyEvidence.fingerprint);
    assert.equal(current.policyEvidence.requested.toolName, "grok_personal_read");
    assert.equal(current.policyEvidence.authority.sandbox, "strict");
    assert.equal(current.policyEvidence.effective.sourceStaged, true);
    assert.equal(current.executionEnvironment.targetWorkspace, fs.realpathSync(activeWorkspace));
    assert.notEqual(current.executionEnvironment.executionWorkspace, fs.realpathSync(activeWorkspace));
    assert.equal(fs.existsSync(current.executionEnvironment.executionWorkspace), false);
    const currentEventsRelative = fs.readdirSync(state, { recursive: true }).map(String)
      .find((file) => file.endsWith(`${current.jobId}.events.ndjson`));
    assert.ok(currentEventsRelative, "installed companion did not persist an event journal");
    const currentEvents = fs.readFileSync(path.join(state, currentEventsRelative), "utf8").trim().split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(currentEvents.map((event) => event.seq), currentEvents.map((_, index) => index + 1));
    assert.equal(currentEvents.at(-1).type, "job_completed");
    const currentInvocationCount = fs.readFileSync(observedFile, "utf8").trim().split("\n").length;
    assert.ok(currentInvocationCount >= 1);

    const denied = await client.request("tools/call", {
      name: "grok_personal_read",
      arguments: {
        cwd: externalWorkspace,
        activeWorkspace,
        prompt: "inspect the external project",
        json: true
      }
    });
    assert.match(denied.error?.message || "", /requires authorizedProject matching cwd/);
    assert.equal(
      fs.readFileSync(observedFile, "utf8").trim().split("\n").length,
      currentInvocationCount,
      "an unauthorized external request must fail before the Grok binary starts"
    );

    const external = parseToolResult(await client.request("tools/call", {
      name: "grok_personal_read",
      arguments: {
        cwd: externalWorkspace,
        activeWorkspace,
        authorizedProject: externalWorkspace,
        prompt: "inspect the authorized external project",
        json: true
      }
    }));
    assert.equal(external.status, "completed");
    assert.equal(external.contract.verified, true);
    assert.equal(external.contract.workerPolicy.externalProject, true);
    assert.equal(external.contract.workerPolicy.authorizedProject, fs.realpathSync(externalWorkspace));
    assert.equal(external.contract.workerPolicy.activeWorkspace, fs.realpathSync(activeWorkspace));
    assert.equal(external.config.activeWorkspace, fs.realpathSync(activeWorkspace));
    assert.ok(
      fs.readFileSync(observedFile, "utf8").trim().split("\n").length > currentInvocationCount,
      "an exactly authorized external request must reach the Grok binary"
    );
    assert.equal(client.stderr().trim(), "");
  } finally {
    await client.close();
    fs.rmSync(activeWorkspace, { recursive: true, force: true });
    fs.rmSync(externalWorkspace, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(helper, { recursive: true, force: true });
  }
});
