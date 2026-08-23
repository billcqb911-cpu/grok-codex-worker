import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Codex owns approvals, MCP, plugins, credentials, and external side effects.
// Grok receives only a project-worker capability assembled in this module.
export const WORKER_ENV_ALLOWLIST = Object.freeze([
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "COMSPEC",
  "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "TMPDIR",
  "LANG", "LC_ALL", "TERM", "NO_COLOR", "GROK_BINARY", "GROK_CODEX_PLUGIN_STATE"
]);

export const HOST_ONLY_COMMANDS = Object.freeze([
  "codex", "codex.cmd", "codex.ps1", "claude", "claude.cmd", "claude.ps1",
  "mcp", "mcp.cmd", "mcp.ps1", "gh", "az", "aws", "gcloud", "op", "vault",
  "ssh", "scp", "curl", "wget", "Invoke-WebRequest", "Invoke-RestMethod"
]);

export const WORKER_DENY_RULES = Object.freeze([
  "Bash(*)",
  "MCPTool(*)",
  "WebFetch",
  "WebSearch"
]);

const POLICY_MARKER = Symbol("grok-codex-worker-policy");
const SAFE_SANDBOX = "strict";
const SAFE_PERMISSION_MODES = new Set(["dontAsk", "plan"]);
const UNSAFE_SANDBOXES = new Set(["off", "devbox"]);
const COMPATIBLE_SANDBOX_REQUESTS = new Set(["strict", "workspace", "workspace-write", "read-only"]);
const HOST_TOOL_RE = /(?:\b(?:call|invoke|use)\s+(?:a\s+|the\s+)?(?:codex|host)\s+(?:mcp\s+tool|plugin|browser|connector)\b|(?:调用|使用).{0,10}(?:Codex|宿主).{0,6}(?:MCP工具|插件|浏览器|连接器))/i;

function rulePath(value) {
  return path.resolve(value).replaceAll("\\", "/");
}

function workspaceAllowRules(cwd, { readOnly, planMode }) {
  if (readOnly || planMode) return [];
  const root = rulePath(cwd);
  return [`Edit(${root}/**)`, `Write(${root}/**)`];
}

function credentialReadDenyRules(source = process.env) {
  const profile = source.USERPROFILE || source.HOME || os.homedir();
  if (!profile) return [];
  const root = rulePath(profile);
  return [
    `.codex`, `.ssh`, `.aws`, `.azure`, `.config/gh`, `.grok/auth.json`,
    `.grok/config.toml`, `.git-credentials`, `AppData/Roaming/gh`
  ].map((entry) => `Read(${root}/${entry}/**)`)
    .concat([
      `Read(${root}/.grok/auth.json)`,
      `Read(${root}/.grok/config.toml)`,
      `Read(${root}/.git-credentials)`
    ]);
}

function platformEvidence() {
  if (process.platform === "linux") {
    return {
      filesystemEnforcement: "grok-strict-kernel-plus-tool-policy",
      childNetworkEnforcement: "grok-strict-kernel-plus-tool-policy"
    };
  }
  if (process.platform === "darwin") {
    return {
      filesystemEnforcement: "grok-strict-kernel-plus-tool-policy",
      childNetworkEnforcement: "tool-policy-only"
    };
  }
  return {
    filesystemEnforcement: "tool-policy-plus-snapshot",
    childNetworkEnforcement: "tool-policy-only"
  };
}

function nonEmptyDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function nonEmptyFile(file) {
  try {
    return fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function workspaceConfigRoots(cwd) {
  const resolved = path.resolve(cwd);
  const ancestors = [];
  let current = resolved;
  while (true) {
    ancestors.push(current);
    if (fs.existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors.reverse();
}

export function auditGrokConfiguration({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const violations = [];
  const grokHome = path.join(path.resolve(home), ".grok");
  const configFiles = [path.join(grokHome, "config.toml")];

  if (nonEmptyDirectory(path.join(grokHome, "hooks"))) violations.push(path.join(grokHome, "hooks"));
  if (nonEmptyFile(path.join(grokHome, "hooks-paths"))) violations.push(path.join(grokHome, "hooks-paths"));
  if (nonEmptyFile(path.join(grokHome, "lsp.json"))) violations.push(path.join(grokHome, "lsp.json"));

  for (const root of workspaceConfigRoots(cwd)) {
    const project = path.join(root, ".grok");
    configFiles.push(path.join(project, "config.toml"));
    if (nonEmptyDirectory(path.join(project, "hooks"))) violations.push(path.join(project, "hooks"));
    if (nonEmptyDirectory(path.join(project, "plugins"))) violations.push(path.join(project, "plugins"));
    if (nonEmptyFile(path.join(project, "lsp.json"))) violations.push(path.join(project, "lsp.json"));
    if (nonEmptyFile(path.join(root, ".mcp.json"))) violations.push(path.join(root, ".mcp.json"));
  }

  for (const file of [...new Set(configFiles)]) {
    if (!nonEmptyFile(file)) continue;
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    // Model/auth routing sections remain usable. Executable discovery and
    // permission sections are rejected because they can widen the worker or
    // run hooks outside Grok tool authorization, especially on Windows.
    if (/^\s*\[+\s*(?:hooks|mcp|plugins|permission|lsp)(?:[.\]"\s])/im.test(text)) {
      violations.push(file);
    }
  }

  return {
    ok: violations.length === 0,
    checked: true,
    violations: [...new Set(violations.map((value) => path.resolve(value)))],
    message: violations.length
      ? "Grok configuration preflight found executable or permission extensions. Keep hooks, MCP, LSP, plugins, and permission grants on the Codex host."
      : null
  };
}

export function isReadOnlyTool(toolName, input = {}) {
  if (toolName === "grok_rescue") return input.readOnly === true;
  return new Set([
    "grok_setup", "grok_review", "grok_adversarial_review", "grok_status",
    "grok_result", "grok_sessions", "grok_transfer"
  ]).has(toolName);
}

export function assertNoHostToolRequest(input = {}) {
  if (input.hostToolRequired === true || input.requiresCodexTools === true) {
    throw new Error("Host-tool handoff required: Codex must invoke Codex plugins/MCP itself; Grok cannot be used as a host-tool proxy.");
  }
  if (HOST_TOOL_RE.test(String(input.prompt || ""))) {
    throw new Error("Host-tool request detected: keep Codex plugins, MCP, browser, credentials, and external submissions on the Codex host.");
  }
}

export function normalizeWorkerPolicy(input = {}, { toolName = "task", writeCapable = true } = {}) {
  if (input[POLICY_MARKER] === true) return input;
  assertNoHostToolRequest(input);

  const cwd = path.resolve(input.cwd || process.cwd());
  const configurationAudit = auditGrokConfiguration({ cwd });
  if (!configurationAudit.ok) {
    throw new Error(`${configurationAudit.message} Blocked paths: ${configurationAudit.violations.join(", ")}`);
  }
  const readOnly = input.readOnly === true || !writeCapable;
  const requestedSandbox = input.sandbox == null || input.sandbox === ""
    ? null : String(input.sandbox).trim().toLowerCase().replace("workspace_write", "workspace-write");
  if (requestedSandbox && UNSAFE_SANDBOXES.has(requestedSandbox)) {
    throw new Error(`Unsafe Grok sandbox '${requestedSandbox}' is not allowed. Phase 7 requires the strict profile.`);
  }
  if (requestedSandbox && !COMPATIBLE_SANDBOX_REQUESTS.has(requestedSandbox)) {
    throw new Error(`Unsupported Grok sandbox '${requestedSandbox}'. Phase 7 requires the strict profile.`);
  }

  const requestedMode = input.planMode === true || input.plan === true
    ? "plan"
    : input.permissionMode ?? input["permission-mode"] ?? null;
  if (requestedMode && !SAFE_PERMISSION_MODES.has(String(requestedMode))) {
    throw new Error(`Unsafe Grok permission mode '${requestedMode}' is not allowed. Use dontAsk or plan.`);
  }
  if (input.yolo === true || input.bypassPermissions === true) {
    throw new Error("Unsafe Grok always-approve/yolo execution is not allowed by the worker policy.");
  }
  if (input.agent || input.agentsJson || input.memory === true || input.memory?.enable === true) {
    throw new Error("Custom agents and cross-session memory cannot be delegated through the bounded Grok worker.");
  }

  const planMode = requestedMode === "plan";
  const safeAllow = workspaceAllowRules(cwd, { readOnly, planMode });
  const requestedAllow = Array.isArray(input.allow) ? input.allow.map(String) : [];
  const safeAllowSet = new Set(safeAllow);
  const wideningRules = requestedAllow.filter((rule) => !safeAllowSet.has(rule));
  if (wideningRules.length) {
    throw new Error(`Caller-supplied Grok allow rules are not permitted: ${wideningRules.join(", ")}.`);
  }

  const permissionMode = planMode ? "plan" : "dontAsk";
  const deny = [...new Set([
    ...(Array.isArray(input.deny) ? input.deny.map(String) : []),
    ...WORKER_DENY_RULES,
    ...credentialReadDenyRules()
  ])];
  if (readOnly) deny.push("Edit(*)", "Write(*)");
  const evidence = platformEvidence();
  const workerPolicy = {
    version: 2,
    enforced: true,
    principal: "grok-worker",
    hostPrincipal: "codex",
    toolName,
    readOnly,
    sandbox: SAFE_SANDBOX,
    permissionMode,
    filesystemScope: "workspace",
    network: "model-transport-only-by-tool-policy",
    webSearch: "disabled",
    webFetch: "disabled",
    subagents: "disabled",
    mcpTools: "denied",
    shellTools: "denied",
    hostTools: "codex-only",
    environment: "allowlist",
    compatibilityDiscovery: "disabled",
    configurationPreflight: "passed",
    commandBoundary: "host-and-network-commands-denied",
    ...evidence
  };
  const result = {
    ...input,
    cwd,
    sandbox: SAFE_SANDBOX,
    permissionMode,
    "permission-mode": permissionMode,
    noSubagents: true,
    disableWebSearch: true,
    memory: { enable: false },
    allow: safeAllow,
    deny: [...new Set(deny)],
    yolo: false,
    workerPolicy
  };
  Object.defineProperty(result, POLICY_MARKER, { value: true, enumerable: true });
  return result;
}

export function evaluateWorkerPolicy(policy = null, { writeRequested = false } = {}) {
  const failures = [];
  if (!policy || policy.enforced !== true) failures.push("missing enforced worker policy evidence");
  if (policy?.principal !== "grok-worker" || policy?.hostPrincipal !== "codex") failures.push("invalid principal boundary");
  if (policy?.sandbox !== SAFE_SANDBOX) failures.push("strict sandbox not recorded");
  if (!SAFE_PERMISSION_MODES.has(policy?.permissionMode)) failures.push("unsafe permission mode");
  if (writeRequested && policy?.readOnly === true) failures.push("write task recorded as read-only");
  if (policy?.mcpTools !== "denied" || policy?.shellTools !== "denied") failures.push("MCP or shell capability not denied");
  if (policy?.webSearch !== "disabled" || policy?.webFetch !== "disabled") failures.push("web capability not disabled");
  if (policy?.subagents !== "disabled") failures.push("subagents not disabled");
  if (policy?.compatibilityDiscovery !== "disabled") failures.push("foreign compatibility discovery not disabled");
  if (policy?.configurationPreflight !== "passed") failures.push("Grok configuration preflight not passed");
  if (policy?.hostTools !== "codex-only" || policy?.environment !== "allowlist") failures.push("host boundary not enforced");
  return {
    ok: failures.length === 0,
    required: true,
    policyVersion: policy?.version ?? null,
    failures,
    message: failures.length ? `Worker security policy verification failed: ${failures.join("; ")}.` : null
  };
}

export function buildWorkerEnv(source = process.env, { stateRoot, grokBinary } = {}) {
  const env = {};
  for (const key of WORKER_ENV_ALLOWLIST) {
    if (source[key] !== undefined) env[key] = String(source[key]);
  }
  if (stateRoot) env.GROK_CODEX_PLUGIN_STATE = String(stateRoot);
  if (grokBinary) env.GROK_BINARY = String(grokBinary);
  Object.assign(env, {
    GROK_CODEX_WORKER_POLICY: "host-tools-denied;web-disabled;env-allowlist;compat-disabled",
    GROK_CODEX_WORKER_DENY_COMMANDS: HOST_ONLY_COMMANDS.join(","),
    GROK_CURSOR_MCPS_ENABLED: "false",
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CURSOR_SKILLS_ENABLED: "false",
    GROK_CLAUDE_SKILLS_ENABLED: "false",
    GROK_CURSOR_RULES_ENABLED: "false",
    GROK_CLAUDE_RULES_ENABLED: "false",
    GROK_CURSOR_AGENTS_ENABLED: "false",
    GROK_CLAUDE_AGENTS_ENABLED: "false",
    GROK_CURSOR_HOOKS_ENABLED: "false",
    GROK_CLAUDE_HOOKS_ENABLED: "false",
    GROK_CURSOR_SESSIONS_ENABLED: "false",
    GROK_CLAUDE_SESSIONS_ENABLED: "false",
    GROK_SUBAGENTS: "0",
    GROK_MEMORY: "0",
    GROK_WORKFLOWS: "0",
    GROK_WEB_FETCH: "0",
    GROK_TELEMETRY_ENABLED: "0",
    GROK_TELEMETRY_TRACE_UPLOAD: "0",
    GROK_FEEDBACK_ENABLED: "0"
  });
  return env;
}

export function createCommandGuard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-command-guard-"));
  const commands = ["codex", "claude", "mcp", "gh", "az", "aws", "gcloud", "op", "vault", "ssh", "scp", "curl", "wget"];
  const message = "Grok worker policy blocked a host, credential, remote-shell, or network command.";
  for (const command of commands) {
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(dir, `${command}.cmd`), `@echo ${message}\r\n@exit /b 126\r\n`, "utf8");
      fs.writeFileSync(path.join(dir, `${command}.ps1`), `Write-Error ${JSON.stringify(message)}; exit 126\r\n`, "utf8");
    } else {
      const file = path.join(dir, command);
      fs.writeFileSync(file, `#!/bin/sh\necho ${JSON.stringify(message)} >&2\nexit 126\n`, { encoding: "utf8", mode: 0o755 });
    }
  }
  return dir;
}

export function cleanupCommandGuard(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

export function prependCommandGuard(env, dir) {
  if (!dir) return env;
  const key = process.platform === "win32" && env.Path !== undefined ? "Path" : "PATH";
  env[key] = [dir, env[key] || ""].filter(Boolean).join(path.delimiter);
  return env;
}

export function summarizeWorkerPolicy(policy = {}) {
  const defaults = platformEvidence();
  return {
    version: policy.version ?? 2,
    enforced: policy.enforced === true,
    principal: policy.principal ?? "grok-worker",
    hostPrincipal: policy.hostPrincipal ?? "codex",
    toolName: policy.toolName ?? "task",
    readOnly: Boolean(policy.readOnly),
    sandbox: policy.sandbox ?? null,
    permissionMode: policy.permissionMode ?? null,
    filesystemScope: policy.filesystemScope ?? "workspace",
    network: policy.network ?? "model-transport-only-by-tool-policy",
    webSearch: policy.webSearch ?? "disabled",
    webFetch: policy.webFetch ?? "disabled",
    subagents: policy.subagents ?? "disabled",
    mcpTools: policy.mcpTools ?? "denied",
    shellTools: policy.shellTools ?? "denied",
    hostTools: "codex-only",
    environment: "allowlist",
    compatibilityDiscovery: policy.compatibilityDiscovery ?? "disabled",
    configurationPreflight: policy.configurationPreflight ?? null,
    commandBoundary: "host-and-network-commands-denied",
    filesystemEnforcement: policy.filesystemEnforcement ?? defaults.filesystemEnforcement,
    childNetworkEnforcement: policy.childNetworkEnforcement ?? defaults.childNetworkEnforcement
  };
}
