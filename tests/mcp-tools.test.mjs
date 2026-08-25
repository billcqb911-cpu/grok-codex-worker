import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpHarness } from "./helpers/mcp-harness.mjs";

import {
  buildCompanionInvocation,
  buildPolicyCheckedCompanionInvocation,
  listToolDefinitions,
  resolveCompanionPath,
  resolveMcpCwd,
  runCompanion
} from "../plugins/grok-codex-worker/mcp/server.mjs";

const SERVER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/grok-codex-worker/mcp/server.mjs"
);

const EXPECTED_TOOLS = [
  "grok_adversarial_review",
  "grok_babysit",
  "grok_cancel",
  "grok_design",
  "grok_document",
  "grok_execute_plan",
  "grok_image",
  "grok_personal_read",
  "grok_plan",
  "grok_rescue",
  "grok_result",
  "grok_review",
  "grok_sessions",
  "grok_setup",
  "grok_status",
  "grok_transfer",
  "grok_video",
  "grok_workflow"
];

test("listToolDefinitions exposes every Grok capability as a Codex tool", () => {
  const names = listToolDefinitions().map((tool) => tool.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS);
});

test("depth tools for plan/workflow/design/execute/babysit/document/sessions are present", () => {
  const names = new Set(listToolDefinitions().map((tool) => tool.name));
  for (const name of [
    "grok_plan",
    "grok_workflow",
    "grok_design",
    "grok_execute_plan",
    "grok_babysit",
    "grok_document",
    "grok_sessions"
  ]) {
    assert.ok(names.has(name), `missing ${name}`);
  }
});

test("every MCP tool accepts an explicit workspace cwd", () => {
  for (const tool of listToolDefinitions()) {
    assert.ok(tool.inputSchema.properties.cwd, `${tool.name} is missing cwd`);
  }
});

test("MCP companion calls run in the requested workspace", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-workspace-"));
  const response = await runCompanion("grok_status", { cwd: workspace, json: true });
  const payload = JSON.parse(response.content[0].text);

  assert.equal(response.isError, false);
  assert.equal(payload.workspaceRoot, fs.realpathSync(workspace));
});

test("MCP resolves the companion from the plugin root, not the active workspace", () => {
  const companion = resolveCompanionPath();
  assert.ok(path.isAbsolute(companion));
  assert.equal(path.basename(companion), "grok-companion.mjs");
  assert.ok(fs.existsSync(companion));
  assert.notEqual(path.dirname(companion), fs.realpathSync(os.tmpdir()));
});

test("public job schemas omit controls that the bounded worker always rejects", () => {
  const tools = new Map(listToolDefinitions().map((tool) => [tool.name, tool]));
  for (const tool of tools.values()) {
    const properties = tool.inputSchema.properties || {};
    assert.equal(properties.agent, undefined, `${tool.name} exposes forbidden agent`);
    assert.equal(properties.memory, undefined, `${tool.name} exposes forbidden memory enablement`);
    assert.equal(properties.allow, undefined, `${tool.name} exposes forbidden caller allow rules`);
  }
  assert.ok(tools.get("grok_rescue").inputSchema.properties.dataPolicy);
  assert.ok(tools.get("grok_rescue").inputSchema.properties.sourceDisclosureConsent);
  assert.ok(tools.get("grok_rescue").inputSchema.properties.personalMode);
  assert.ok(tools.get("grok_rescue").inputSchema.properties.authorizedProject);
  for (const name of ["grok_plan", "grok_review", "grok_design", "grok_document", "grok_workflow"]) {
    assert.equal(tools.get(name).inputSchema.properties.dataPolicy, undefined, `${name} advertises unsupported disclosure staging`);
    assert.equal(tools.get(name).inputSchema.properties.sourceDisclosureConsent, undefined, `${name} advertises unsupported disclosure consent`);
  }
});

test("Personal read has an accurate non-destructive annotation and a narrow schema", () => {
  const tool = listToolDefinitions().find((item) => item.name === "grok_personal_read");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  });
  assert.deepEqual(tool.inputSchema.required, ["prompt", "activeWorkspace"]);
  const properties = tool.inputSchema.properties;
  for (const name of ["prompt", "cwd", "activeWorkspace", "authorizedProject", "model", "effort", "maxTurns", "check", "json"]) {
    assert.ok(properties[name], `grok_personal_read is missing ${name}`);
  }
  for (const name of [
    "readOnly", "background", "dataPolicy", "sourceDisclosureConsent", "personalMode",
    "resume", "resumeSession", "worktree", "memory", "noMemory", "snapshot",
    "allowedChangedFiles", "rollbackOnFailure", "sandbox", "permissionMode"
  ]) {
    assert.equal(properties[name], undefined, `grok_personal_read exposes ${name}`);
  }
});

test("MCP rejects a missing workspace before spawning the companion", () => {
  const missing = path.join(os.tmpdir(), "grok-mcp-missing-workspace");
  assert.throws(() => resolveMcpCwd({ cwd: missing }), /Workspace directory does not exist/);
});

test("buildCompanionInvocation maps review arguments to the companion runtime", () => {
  const invocation = buildCompanionInvocation("grok_review", {
    background: true,
    base: "main",
    scope: "branch",
    focus: "auth and race conditions"
  });

  assert.equal(invocation.command, "review");
  assert.deepEqual(invocation.args, [
    "review",
    "--background",
    "--base",
    "main",
    "--scope",
    "branch",
    "auth and race conditions"
  ]);
});


test("buildCompanionInvocation maps strict changed-file scope flags", () => {
  const invocation = buildCompanionInvocation("grok_rescue", {
    prompt: "only edit test",
    allowedChangedFiles: ["tests/unit/test_narrative.py"],
    forbiddenChangedPaths: ["src"],
    snapshot: true,
    rollbackOnFailure: true
  });
  assert.ok(invocation.args.includes("--allowed-changed-file"));
  assert.ok(invocation.args.includes("tests/unit/test_narrative.py"));
  assert.ok(invocation.args.includes("--forbidden-changed-path"));
  assert.ok(invocation.args.includes("src"));
  assert.ok(invocation.args.includes("--snapshot"));
  assert.ok(invocation.args.includes("--rollback-on-failure"));
});

test("buildCompanionInvocation maps personal disclosure consent", () => {
  const invocation = buildCompanionInvocation("grok_rescue", {
    prompt: "review source with XAI_API_KEY=xai-abcdefghijklmnop",
    dataPolicy: "personal-sanitized",
    sourceDisclosureConsent: true,
    personalMode: "once",
    activeWorkspace: "C:\\Projects\\CurrentProject",
    authorizedProject: "C:\\Projects\\MoneyPrinterTurbo",
    readOnly: true
  });
  assert.ok(invocation.args.includes("--data-policy"));
  assert.ok(invocation.args.includes("personal-sanitized"));
  assert.ok(invocation.args.includes("--source-disclosure-consent"));
  assert.ok(invocation.args.includes("--personal-mode"));
  assert.ok(invocation.args.includes("once"));
  assert.ok(invocation.args.includes("--authorized-project"));
  assert.ok(invocation.args.includes("--active-workspace"));
  assert.ok(invocation.args.includes("C:\\Projects\\CurrentProject"));
  assert.equal(invocation.args.some((item) => String(item).includes("xai-abcdefghijklmnop")), false);
  assert.ok(invocation.args.some((item) => String(item).includes("[REDACTED_API_KEY_1]")));
});

test("policy-checked MCP serialization keeps policy output internal and maps disabled memory once", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-policy-"));
  try {
    const personal = buildPolicyCheckedCompanionInvocation("grok_rescue", {
      cwd: workspace,
      prompt: "review source",
      dataPolicy: "personal-sanitized",
      sourceDisclosureConsent: true,
      personalMode: "once",
      readOnly: true,
      noMemory: true,
      fresh: true
    }, { cwd: workspace, activeWorkspace: workspace, writeCapable: false });
    assert.equal(personal.args.filter((item) => item === "--memory").length, 0);
    assert.equal(personal.args.filter((item) => item === "--no-memory").length, 1);
    assert.equal(personal.args.includes("--allow"), false);
    assert.equal(personal.args.includes("--deny"), false);
    assert.equal(personal.args.includes("--sandbox"), false);

    const standard = buildPolicyCheckedCompanionInvocation("grok_rescue", {
      cwd: workspace,
      prompt: "review source",
      readOnly: true
    }, { cwd: workspace, writeCapable: false });
    assert.equal(standard.args.includes("--memory"), false);
    assert.equal(standard.args.includes("--no-memory"), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Personal once shorthand authorizes the active workspace and defaults to Grok 4.6 high", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-personal-default-"));
  try {
    const invocation = buildPolicyCheckedCompanionInvocation("grok_rescue", {
      cwd: workspace,
      prompt: "explain this project",
      personalMode: "once",
      readOnly: true,
      fresh: true
    }, { cwd: workspace, activeWorkspace: workspace, writeCapable: false });
    const model = invocation.args.indexOf("--model");
    const effort = invocation.args.indexOf("--effort");
    assert.equal(invocation.args[invocation.args.indexOf("--data-policy") + 1], "personal-sanitized");
    assert.notEqual(model, -1);
    assert.equal(invocation.args[model + 1], "grok-4.6");
    assert.notEqual(effort, -1);
    assert.equal(invocation.args[effort + 1], "high");
    assert.ok(invocation.args.includes("--source-disclosure-consent"));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("dedicated Personal read forces the active-workspace read contract and defaults", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-personal-read-"));
  try {
    const invocation = buildPolicyCheckedCompanionInvocation("grok_personal_read", {
      cwd: workspace,
      prompt: "explain this project",
      readOnly: false,
      background: true,
      dataPolicy: "strict",
      sourceDisclosureConsent: false,
      personalMode: "on",
      fresh: false,
      noMemory: false,
      noSubagents: false,
      disableWebSearch: false,
      sandbox: "workspace-write",
      permissionMode: "plan",
      json: true
    }, { cwd: workspace, activeWorkspace: workspace });
    assert.equal(invocation.command, "task");
    assert.ok(invocation.args.includes("--read-only"));
    assert.ok(invocation.args.includes("--fresh"));
    assert.ok(invocation.args.includes("--source-disclosure-consent"));
    assert.equal(invocation.args[invocation.args.indexOf("--data-policy") + 1], "personal-sanitized");
    assert.equal(invocation.args[invocation.args.indexOf("--personal-mode") + 1], "once");
    assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "grok-4.6");
    assert.equal(invocation.args[invocation.args.indexOf("--effort") + 1], "high");
    assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.ok(invocation.args.includes("--no-memory"));
    assert.ok(invocation.args.includes("--no-subagents"));
    assert.ok(invocation.args.includes("--disable-web-search"));
    assert.equal(invocation.args.includes("--background"), false);
    assert.equal(invocation.args.includes("--authorized-project"), false);
    assert.equal(invocation.args[invocation.args.indexOf("--active-workspace") + 1], workspace);
    assert.equal(invocation.args.filter((item) => item === "--no-memory").length, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Personal MCP calls reject a missing activeWorkspace before Grok starts", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-personal-missing-active-"));
  try {
    assert.throws(
      () => buildPolicyCheckedCompanionInvocation("grok_personal_read", {
        cwd: workspace,
        prompt: "review"
      }, { cwd: workspace, activeWorkspace: null }),
      /requires activeWorkspace.*environment_context\.cwd/
    );
    assert.throws(
      () => buildPolicyCheckedCompanionInvocation("grok_rescue", {
        cwd: workspace,
        prompt: "update source",
        personalMode: "once"
      }, { cwd: workspace, activeWorkspace: null, writeCapable: true }),
      /requires activeWorkspace.*environment_context\.cwd/
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("dedicated Personal read reserves authorizedProject for one exact external target", () => {
  const active = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-personal-read-active-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-personal-read-external-"));
  try {
    assert.throws(
      () => buildPolicyCheckedCompanionInvocation("grok_personal_read", {
        cwd: active, prompt: "review", authorizedProject: active
      }, { cwd: active, activeWorkspace: active }),
      /only valid.*outside the active Codex workspace/
    );
    assert.throws(
      () => buildPolicyCheckedCompanionInvocation("grok_personal_read", {
        cwd: external, prompt: "review"
      }, { cwd: external, activeWorkspace: active }),
      /requires authorizedProject/
    );
    assert.throws(
      () => buildPolicyCheckedCompanionInvocation("grok_personal_read", {
        cwd: external, prompt: "review", authorizedProject: active
      }, { cwd: external, activeWorkspace: active }),
      /exactly match/
    );
    const accepted = buildPolicyCheckedCompanionInvocation("grok_personal_read", {
      cwd: external, prompt: "review", authorizedProject: external
    }, { cwd: external, activeWorkspace: active });
    assert.equal(accepted.args[accepted.args.indexOf("--authorized-project") + 1], external);
    assert.equal(accepted.args.filter((item) => item === "--no-memory").length, 1);
  } finally {
    fs.rmSync(active, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("external Personal scope requires once and an exact project authorization", () => {
  const active = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-active-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-external-"));
  try {
    const base = {
      cwd: external,
      prompt: "review source",
      dataPolicy: "personal-sanitized",
      sourceDisclosureConsent: true,
      readOnly: true,
      fresh: true
    };
    assert.throws(
      () => buildPolicyCheckedCompanionInvocation("grok_rescue", { ...base, personalMode: "on" }, { cwd: external, activeWorkspace: active, writeCapable: false }),
      /requires personalMode=once/
    );
    assert.throws(
      () => buildPolicyCheckedCompanionInvocation("grok_rescue", { ...base, personalMode: "once" }, { cwd: external, activeWorkspace: active, writeCapable: false }),
      /requires authorizedProject/
    );
    assert.throws(
      () => buildPolicyCheckedCompanionInvocation("grok_rescue", { ...base, personalMode: "once", authorizedProject: active }, { cwd: external, activeWorkspace: active, writeCapable: false }),
      /exactly match/
    );
    const accepted = buildPolicyCheckedCompanionInvocation("grok_rescue", { ...base, personalMode: "once", authorizedProject: external }, { cwd: external, activeWorkspace: active, writeCapable: false });
    assert.ok(accepted.args.includes("--personal-mode"));
    assert.ok(accepted.args.includes("--authorized-project"));
  } finally {
    fs.rmSync(active, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("memory object serialization emits one unambiguous CLI flag", () => {
  const disabled = buildCompanionInvocation("grok_rescue", {
    prompt: "review source",
    memory: { enable: false },
    noMemory: true
  });
  assert.equal(disabled.args.filter((item) => item === "--memory").length, 0);
  assert.equal(disabled.args.filter((item) => item === "--no-memory").length, 1);
  assert.throws(
    () => buildCompanionInvocation("grok_rescue", { prompt: "review", memory: { enable: true }, noMemory: true }),
    /Conflicting Grok memory controls/
  );
});

test("buildCompanionInvocation maps rescue aliases, control flags, and flags", () => {
  const invocation = buildCompanionInvocation("grok_rescue", {
    prompt: "fix flaky tests",
    model: "deep",
    effort: "high",
    worktree: true,
    check: true,
    bestOfN: 3,
    resume: true,
    sandbox: "workspace-write",
    noSubagents: true,
    maxTurns: 40
  });

  assert.equal(invocation.command, "task");
  assert.deepEqual(invocation.args, [
    "task",
    "--resume-last",
    "--model",
    "deep",
    "--effort",
    "high",
    "--worktree",
    "--check",
    "--best-of-n",
    "3",
    "--sandbox",
    "workspace-write",
    "--no-subagents",
    "--max-turns",
    "40",
    "fix flaky tests"
  ]);
});

test("buildCompanionInvocation maps plan and execute-plan depth tools", () => {
  const plan = buildCompanionInvocation("grok_plan", {
    prompt: "plan the auth rewrite",
    background: true,
    model: "deep"
  });
  assert.equal(plan.command, "plan");
  assert.ok(plan.args.includes("plan"));
  assert.ok(plan.args.includes("--background"));
  assert.ok(plan.args.includes("plan the auth rewrite"));

  const exec = buildCompanionInvocation("grok_execute_plan", {
    latest: true,
    dryRun: true,
    concurrency: 2
  });
  assert.equal(exec.command, "execute-plan");
  assert.ok(exec.args.includes("--latest"));
  assert.ok(exec.args.includes("--dry-run"));
  assert.ok(exec.args.includes("--concurrency"));
  assert.ok(exec.args.includes("2"));
});

test("buildCompanionInvocation maps workflow list/run and babysit list", () => {
  const list = buildCompanionInvocation("grok_workflow", { action: "list", json: true });
  assert.deepEqual(list.args, ["workflow", "list", "--json"]);

  const run = buildCompanionInvocation("grok_workflow", {
    action: "run",
    name: "review-changes",
    validateOnly: true,
    args: ["scope=branch"]
  });
  assert.ok(run.args.includes("run"));
  assert.ok(run.args.includes("review-changes"));
  assert.ok(run.args.includes("--validate-only"));
  assert.ok(run.args.includes("--arg"));
  assert.ok(run.args.includes("scope=branch"));

  const babysit = buildCompanionInvocation("grok_babysit", { action: "list", json: true });
  assert.deepEqual(babysit.args, ["babysit", "list", "--json"]);
});

test("buildCompanionInvocation maps sessions and document tools", () => {
  const sessions = buildCompanionInvocation("grok_sessions", {
    action: "search",
    query: "auth",
    limit: 5,
    json: true
  });
  assert.ok(sessions.args.includes("sessions"));
  assert.ok(sessions.args.includes("search"));
  assert.ok(sessions.args.includes("auth"));

  const exported = buildCompanionInvocation("grok_sessions", {
    action: "export",
    sessionId: "session-123",
    output: "session.md"
  });
  assert.ok(exported.args.includes("session-123"));
  assert.ok(exported.args.includes("--output"));
  assert.ok(exported.args.includes("session.md"));

  const doc = buildCompanionInvocation("grok_document", {
    type: "pdf",
    prompt: "one-pager",
    background: true
  });
  assert.equal(doc.command, "document");
  assert.ok(doc.args.includes("--type"));
  assert.ok(doc.args.includes("pdf"));
  assert.ok(doc.args.includes("one-pager"));
});

/**
 * Codex speaks newline-delimited JSON over stdio for plugin MCP servers.
 * Content-Length framing must not be required or emitted.
 */
test("stdio MCP transport speaks NDJSON (Codex framing)", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-stdio-workspace-"));
  const client = new McpHarness(SERVER_PATH, {}, { timeoutMs: 3_000 });
  try {
    const init = await client.initialize({ name: "mcp-tools-test", version: "0.0.0" });
    const tools = await client.request("tools/list");
    const status = await client.request("tools/call", {
      name: "grok_status",
      arguments: { cwd: workspace, json: true }
    });
    assert.equal(init.result?.serverInfo?.name, "grok-codex-worker");
    assert.equal(init.result?.serverInfo?.version, "0.1.0");
    assert.ok(Array.isArray(tools.result?.tools));
    assert.equal(tools.result.tools.length, EXPECTED_TOOLS.length);
    assert.ok(tools.result.tools.some((tool) => tool.name === "grok_plan"));
    assert.ok(tools.result.tools.some((tool) => tool.name === "grok_workflow"));
    const personalRead = tools.result.tools.find((tool) => tool.name === "grok_personal_read");
    assert.deepEqual(personalRead?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    });
    assert.equal(status.result?.isError, false);
    assert.equal(JSON.parse(status.result.content[0].text).workspaceRoot, fs.realpathSync(workspace));
    assert.doesNotMatch(client.stdout(), /Content-Length:/i);
    assert.equal(client.stderr().trim(), "");
  } finally {
    await client.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("stdio MCP cancellation closes Grok, rolls back writes, and publishes one terminal result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcp-cancel-"));
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "grok-state");
  const target = path.join(workspace, "target.txt");
  const mock = path.join(root, "slow-grok.mjs");
  const wrapper = path.join(root, process.platform === "win32" ? "slow-grok.cmd" : "slow-grok");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(target, "baseline\n");
  fs.writeFileSync(mock, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'const command = process.argv[2] || "";',
    'if (command === "version") { console.log("grok 1.0.5"); process.exit(0); }',
    'if (command === "doctor") { console.log("ok"); process.exit(0); }',
    'fs.writeFileSync(path.join(process.cwd(), "target.txt"), "partial change\\n");',
    'setInterval(() => {}, 1000);'
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(wrapper, `@echo off\r\nnode "${mock}" %*\r\n`);
  } else {
    fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nexec node "${mock}" "$@"\n`, { mode: 0o755 });
  }

  const client = new McpHarness(SERVER_PATH, {
    env: { ...process.env, GROK_BINARY: wrapper, GROK_CODEX_PLUGIN_STATE: state },
    stdio: ["pipe", "pipe", "pipe"]
  }, { timeoutMs: 20_000 });

  try {
    await client.initialize({ name: "mcp-cancellation-test", version: "1.0.0" });
    const responsePromise = client.request("tools/call", {
        name: "grok_rescue",
        arguments: {
          cwd: workspace,
          prompt: "Change only target.txt and then wait.",
          model: "mock",
          snapshot: true,
          rollbackOnFailure: true,
          expectedFiles: ["target.txt"],
          allowedChangedFiles: ["target.txt"],
          json: true
        }
    }, { id: 10, timeoutMs: 20_000 });

    const changeDeadline = Date.now() + 10_000;
    while (Date.now() < changeDeadline && fs.readFileSync(target, "utf8") === "baseline\n") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.readFileSync(target, "utf8"), "partial change\n", `mock Grok did not start:\n${client.stderr()}`);
    client.cancel(10, "test");
    const response = await responsePromise;
    assert.equal(response.result?.isError, true);
    assert.equal(response.result?._meta?.processClosed, true);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.status, "cancelled_rolled_back");
    assert.equal(payload.cancellation?.processClosed, true);
    assert.equal(payload.contract?.verified, false);
    assert.equal(payload.rollback?.ok, true);
    assert.equal(payload.invocation?.mcpRequestId, 10);
    assert.equal(payload.invocation?.jobId, payload.jobId);
    assert.equal(payload.invocation?.tool, "grok_rescue");
    assert.equal(payload.invocation?.targetWorkspace, fs.realpathSync(workspace));
    assert.equal(payload.invocation?.executionWorkspace, fs.realpathSync(workspace));
    assert.equal(payload.invocation?.policyFingerprint, payload.policyEvidence?.fingerprint);
    assert.equal(payload.policyEvidence?.requested?.toolName, "grok_rescue");
    assert.equal(payload.policyEvidence?.authority?.sandbox, "strict");
    assert.equal(payload.policyEvidence?.effective?.sandbox, "strict");
    assert.equal(payload.executionEnvironment?.environmentId, payload.invocation?.environmentId);
    assert.equal(fs.readFileSync(target, "utf8"), "baseline\n");

    const stateFiles = fs.readdirSync(state, { recursive: true }).map(String);
    assert.equal(stateFiles.some((file) => file.endsWith("workspace-write.lease.json")), false);
    const eventRelative = stateFiles.find((file) => file.endsWith(`${payload.jobId}.events.ndjson`));
    assert.ok(eventRelative, "job event journal was not persisted");
    const events = fs.readFileSync(path.join(state, eventRelative), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
    const eventTypes = events.map((event) => event.type);
    for (const type of [
      "accepted", "policy_resolved", "snapshot_created", "process_started", "cancel_requested",
      "process_exited", "output_closed", "rollback_started", "rollback_completed",
      "verification_completed", "job_failed"
    ]) {
      assert.ok(eventTypes.includes(type), `missing lifecycle event ${type}`);
    }
    assert.equal(eventTypes.filter((type) => type === "job_completed" || type === "job_failed").length, 1);
    assert.equal(client.responsesFor(10).length, 1);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
