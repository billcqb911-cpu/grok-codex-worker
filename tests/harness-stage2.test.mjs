import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  getToolCapabilities,
  listToolDefinitions,
  listToolManifest,
  validateToolManifest
} from "../plugins/grok-codex-worker/mcp/server.mjs";
import {
  canonicalJson,
  createInvocationEnvelope,
  fingerprintValue,
  updateInvocationEnvelope
} from "../plugins/grok-codex-worker/scripts/lib/invocation.mjs";
import {
  appendJobEvent,
  readJobEvents,
  resolveJobEventsFile
} from "../plugins/grok-codex-worker/scripts/lib/jobs.mjs";
import { normalizeWorkerPolicy } from "../plugins/grok-codex-worker/scripts/lib/security.mjs";

function runNode(source, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`event writer exited ${code}: ${stderr}`));
    });
  });
}

test("canonical invocation envelope has stable identity and explicit workspace roles", () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 2, b: 3 } }), '{"a":{"b":3,"d":2},"z":1}');
  assert.equal(fingerprintValue({ b: 2, a: 1 }), fingerprintValue({ a: 1, b: 2 }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-invocation-"));
  const execution = path.join(root, "staging");
  fs.mkdirSync(execution);
  try {
    const envelope = createInvocationEnvelope({
      invocationId: "invocation-test",
      mcpRequestId: 42,
      tool: "grok_rescue",
      activeWorkspace: root,
      targetWorkspace: root,
      executionWorkspace: root,
      policyFingerprint: "a".repeat(64)
    });
    const staged = updateInvocationEnvelope(envelope, { jobId: "job-test", executionWorkspace: execution });
    assert.equal(staged.invocationId, "invocation-test");
    assert.equal(staged.mcpRequestId, 42);
    assert.equal(staged.jobId, "job-test");
    assert.equal(staged.targetWorkspace, fs.realpathSync(root));
    assert.equal(staged.executionWorkspace, fs.realpathSync(execution));
    assert.notEqual(staged.environmentId, envelope.environmentId);
    assert.deepEqual(staged.workspaceRoots, [fs.realpathSync(root)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical tool manifest validates ownership and dynamic capabilities", () => {
  const definitions = listToolDefinitions();
  const manifest = listToolManifest();
  assert.equal(manifest.length, definitions.length);
  assert.ok(definitions.every((definition) => definition.annotations && definition.inputSchema.additionalProperties === false));
  assert.equal(getToolCapabilities("grok_rescue", { readOnly: true }).mutatesWorkspace, false);
  assert.equal(getToolCapabilities("grok_rescue", {}).mutatesWorkspace, true);
  assert.equal(getToolCapabilities("grok_workflow", { action: "run", validateOnly: true }).readOnly, true);
  assert.equal(getToolCapabilities("grok_execute_plan", { dryRun: true }).supportsParallel, true);
  assert.equal(getToolCapabilities("grok_babysit", { action: "list" }).approvalClass, "repository-conditional");

  const definition = {
    name: "grok_fixture",
    description: "fixture",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  };
  const runtime = {
    grok_fixture: {
      serialize: () => ({ command: "fixture", args: ["fixture"] }),
      readOnly: true,
      mutatesWorkspace: false,
      supportsParallel: true,
      supportsBackground: false,
      approvalClass: "fixture"
    }
  };
  assert.equal(validateToolManifest([definition], runtime).length, 1);
  assert.throws(() => validateToolManifest([definition, definition], runtime), /Duplicate or reserved/);
  assert.throws(() => validateToolManifest([definition], {}), /missing a companion serializer/);
  assert.throws(
    () => validateToolManifest([{ ...definition, inputSchema: { type: "object", properties: {} } }], runtime),
    /incomplete approval or input-schema metadata/
  );
});

test("worker policy records requested, authority, effective, and stable fingerprint evidence", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-policy-evidence-"));
  try {
    const normalized = normalizeWorkerPolicy({
      cwd,
      readOnly: true,
      sandbox: "read-only",
      permissionMode: "dontAsk",
      noSubagents: true,
      disableWebSearch: true
    }, { toolName: "grok_review", writeCapable: false });
    const evidence = normalized.policyEvidence;
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.requested.sandbox, "read-only");
    assert.equal(evidence.authority.sandbox, "strict");
    assert.equal(evidence.effective.sandbox, "strict");
    assert.equal(evidence.effective.readOnly, true);
    assert.equal(evidence.fingerprint, fingerprintValue(evidence.effective));
    assert.doesNotMatch(JSON.stringify(evidence), /prompt|API_KEY|password-value/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("append-only job journal serializes real cross-process writers and redacts bounded payloads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-stage2-events-"));
  const cwd = path.join(root, "workspace");
  const state = path.join(root, "grok-state");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const previous = process.env.GROK_CODEX_PLUGIN_STATE;
  process.env.GROK_CODEX_PLUGIN_STATE = state;
  const moduleUrl = pathToFileURL(path.resolve("plugins/grok-codex-worker/scripts/lib/jobs.mjs")).href;
  const source = [
    `import { appendJobEvent } from ${JSON.stringify(moduleUrl)};`,
    "for (let index = 0; index < 10; index += 1) {",
    "  appendJobEvent(process.cwd(), 'shared-job', 'progress', { writer: process.env.GROK_EVENT_WRITER, index });",
    "}"
  ].join("\n");
  try {
    await Promise.all(Array.from({ length: 4 }, (_, index) => runNode(source, {
      cwd,
      env: { ...process.env, GROK_CODEX_PLUGIN_STATE: state, GROK_EVENT_WRITER: String(index) }
    })));
    appendJobEvent(cwd, "shared-job", "policy_resolved", {
      apiKey: "should-never-persist",
      nested: { password: "also-secret" },
      safe: "x".repeat(40_000)
    });
    const events = readJobEvents(cwd, "shared-job", { limit: 100 });
    assert.equal(events.length, 41);
    assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 41 }, (_, index) => index + 1));
    assert.equal(events[40].payload.apiKey, "[REDACTED]");
    assert.equal(events[40].payload.nested.password, "[REDACTED]");
    const journal = fs.readFileSync(resolveJobEventsFile(cwd, "shared-job"), "utf8");
    assert.doesNotMatch(journal, /should-never-persist|also-secret/);
    assert.ok(Math.max(...journal.trim().split("\n").map((line) => Buffer.byteLength(line))) <= 16 * 1024);
  } finally {
    if (previous === undefined) delete process.env.GROK_CODEX_PLUGIN_STATE;
    else process.env.GROK_CODEX_PLUGIN_STATE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
