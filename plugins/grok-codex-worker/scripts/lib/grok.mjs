import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  binaryAvailable,
  HeadTailBuffer,
  quoteWindowsArg,
  resolveSpawnCommand,
  runCommand,
  runCommandAsync
} from "./process.mjs";
import {
  buildWorkerEnv,
  cleanupCommandGuard,
  createCommandGuard,
  HOST_ONLY_COMMANDS,
  normalizeWorkerPolicy,
  prependCommandGuard,
  summarizeWorkerPolicy
} from "./security.mjs";

// Grok CLI 0.2.93: --tools ALLOWLISTS often fail session create with a
// server-side run_terminal_cmd background-param constraint error. Prefer
// the default toolset + --disallowed-tools denylist instead.
// Also avoid --yolo for media: the permission classifier may deny that flag;
// single-prompt mode already auto-approves tools when the user config allows.
export const READ_ONLY_DISALLOWED_TOOLS =
  "run_terminal_cmd,search_replace,write_file,edit_file";
export const MEDIA_DISALLOWED_TOOLS =
  "run_terminal_cmd,write_file,edit_file,search_replace";

// Deprecated: kept only for tests / callers that still pass tools= explicitly.
export const READ_ONLY_TOOLS = "read_file,grep,list_dir";
export const MEDIA_TOOLS = "image_gen,image_edit,image_to_video,reference_to_video,list_dir,read_file";
export const WORKER_DISALLOWED_COMMANDS = HOST_ONLY_COMMANDS.map((command) => `Bash(${command} *)`).join(",");

export function assertGrokCliCompatibility(options = {}) {
  const bestOfN = Number(options.bestOfN || 0);
  if (Number.isFinite(bestOfN) && bestOfN > 1) {
    throw new Error(
      "The installed Grok CLI does not support the plugin-level bestOfN option. " +
      "Run separate Grok tasks instead of requesting --best-of-n."
    );
  }
}

export function resolveGrokBinary() {
  const envPath = process.env.GROK_BINARY;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const located = runCommand(lookup, [process.platform === "win32" ? "grok.exe" : "grok"], { windowsHide: true });
  if (located.status === 0 && String(located.stdout || "").trim()) {
    const first = String(located.stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) return first;
  }

  const home = path.join(os.homedir(), ".grok", "bin");
  const candidates = process.platform === "win32"
    ? [path.join(home, "grok.exe"), path.join(home, "grok.cmd"), path.join(home, "grok")]
    : [path.join(home, "grok")];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}
export function getGrokAvailability() {
  const binary = resolveGrokBinary();
  if (!binary) {
    return {
      available: false,
      binary: null,
      version: null,
      versionRaw: null,
      reason: "Grok CLI not found on PATH. Install Grok Build and ensure `grok` is available."
    };
  }

  const versionResult = runCommand(binary, ["version"], { env: buildWorkerEnv(process.env, { grokBinary: binary }) });
  const versionRaw =
    versionResult.status === 0 ? versionResult.stdout.trim().split("\n")[0] : null;
  return {
    available: true,
    binary,
    version: versionRaw,
    versionRaw,
    reason: null
  };
}

/**
 * Run `grok doctor` and return stdout/stderr summary (best-effort).
 */
export function runGrokDoctor() {
  const binary = resolveGrokBinary();
  if (!binary) {
    return { ok: false, detail: "Grok CLI not found" };
  }
  const result = runCommand(binary, ["doctor"], { maxBuffer: 2 * 1024 * 1024, env: buildWorkerEnv(process.env, { grokBinary: binary }) });
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  return {
    ok: result.status === 0,
    detail: stdout || stderr || `doctor exited ${result.status}`,
    stdout,
    stderr,
    status: result.status
  };
}

export function getGrokAuthStatus() {
  const binary = resolveGrokBinary();
  if (!binary) {
    return { authenticated: false, detail: "Grok CLI not found" };
  }

  const result = runCommand(binary, ["models"], { maxBuffer: 2 * 1024 * 1024, env: buildWorkerEnv(process.env, { grokBinary: binary }) });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const combined = `${stdout}\n${stderr}`;

  if (result.status === 0 && /logged in|Available models|Default model/i.test(combined)) {
    const loginMatch = combined.match(/logged in with ([^\n.]+)/i);
    return {
      authenticated: true,
      detail: loginMatch ? `Logged in with ${loginMatch[1].trim()}` : "Authenticated"
    };
  }

  if (/not logged in|sign in|login|unauthorized|auth/i.test(combined)) {
    return {
      authenticated: false,
      detail: "Not authenticated. Run `grok login` or `!grok login` from Claude Code."
    };
  }

  if (result.status === 0 && /grok-/i.test(combined)) {
    return { authenticated: true, detail: "Authenticated (models list succeeded)" };
  }

  return {
    authenticated: false,
    detail: (stderr || stdout || "Unable to verify Grok authentication").trim()
  };
}

export function buildGrokArgs(options = {}) {
  options = normalizeWorkerPolicy(options, {
    toolName: options.workerPolicy?.toolName || "grok-low-level",
    writeCapable: options.write === true
  });
  const args = [];

  if (options.promptFile) {
    args.push("--prompt-file", options.promptFile);
  } else if (options.prompt != null) {
    args.push("-p", options.prompt);
  } else {
    throw new Error("A prompt or prompt file is required");
  }

  const outputFormat = options.outputFormat ?? (options.jsonSchema ? "json" : "json");
  args.push("--output-format", outputFormat);

  if (options.jsonSchema) {
    args.push("--json-schema", options.jsonSchema);
  }
  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }
  if (options.resume) {
    args.push("-r", options.resume);
  } else if (options.continueSession) {
    args.push("-c");
  }
  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options.worktree) {
    if (typeof options.worktree === "string" && options.worktree !== "true") {
      args.push("--worktree", options.worktree);
    } else {
      args.push("--worktree");
    }
  }
  if (options.worktreeRef) {
    args.push("--worktree-ref", options.worktreeRef);
  }

  // Control surface (Grok Build 0.2.118+)
  if (options.sandbox) {
    args.push("--sandbox", options.sandbox);
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.noSubagents) {
    args.push("--no-subagents");
  }
  if (options.agent) {
    args.push("--agent", options.agent);
  }
  if (options.agentsJson) {
    args.push("--agents", options.agentsJson);
  }
  for (const rule of options.allow || []) {
    args.push("--allow", rule);
  }
  for (const rule of options.deny || []) {
    args.push("--deny", rule);
  }
  if (options.disableWebSearch) {
    args.push("--disable-web-search");
  }
  if (options.forkSession) {
    args.push("--fork-session");
  }
  if (options.memory?.enable === true) {
    args.push("--experimental-memory");
  } else if (options.memory?.enable === false) {
    args.push("--no-memory");
  }
  if (options.noPlan) {
    args.push("--no-plan");
  }

  // Do not remove built-in tools from the session graph. Grok 1.0.5 declares
  // get_task_output/kill_task dependencies on the terminal tool and refuses to
  // create a session when that tool is removed. Phase 7 keeps registration
  // intact and blocks invocation with documented permission deny rules.
  if (options.forceToolsAllowlist && options.tools) {
    throw new Error("Caller-supplied Grok tool allowlists are not permitted by the worker policy.");
  }

  const isPlanMode = options.permissionMode === "plan";

  if (options.write && !isPlanMode) {
    // Write access is granted only by the narrow Edit/Write rules assembled by
    // normalizeWorkerPolicy. Never add --yolo at this low-level boundary.
  }

  if (options.rules) {
    args.push("--rules", options.rules);
  } else if (options.media) {
    // Rules supplied by the media command (output dir, no source edits).
  } else if (!options.write) {
    args.push(
      "--rules",
      "Read-only mode: do not modify files, create files, or run mutating shell commands. Review and report only."
    );
  }

  if (options.verbatim) {
    args.push("--verbatim");
  }

  return args;
}

/**
 * Turn raw CLI / Rust dumps into a short human-readable failure message.
 */
export function humanizeGrokFailure(sources = {}) {
  const parts = [sources.parsedError, sources.stderr, sources.stdout, sources.message]
    .filter((v) => v != null && String(v).trim())
    .map((v) => String(v).trim());
  const blob = parts.join("\n");
  if (!blob) {
    if (sources.exitCode != null && sources.exitCode !== 0) {
      return `Grok exited with code ${sources.exitCode}.`;
    }
    return "Grok failed with no error details.";
  }

  const compact = blob.replace(/\s+/g, " ").trim();

  // Tool allowlist / session-create constraint (known on Grok 0.2.93)
  if (
    /RequirementError/i.test(blob) &&
    (/run_terminal_cmd/i.test(blob) || /background/i.test(blob) || /--tools/i.test(blob))
  ) {
    return (
      "Grok CLI rejected the tool configuration while creating a session. " +
      "This usually means a tool allowlist/removal is incompatible with your Grok CLI version. " +
      "This plugin keeps the built-in tool graph intact and enforces Phase 7 with permission deny rules. " +
      "Update the plugin or Grok CLI (`grok version`), then retry."
    );
  }

  if (/RequirementError/i.test(blob)) {
    const brief =
      blob.match(/RequirementError[:\s{]*([^}\n]{10,200})/i)?.[1]?.trim() ||
      compact.slice(0, 180);
    return (
      `Grok CLI requirement error: ${brief}. ` +
      "Check `grok version`, auth (`grok login`), and that your plan supports this feature."
    );
  }

  if (/not logged in|unauthori[sz]ed|authentication required|auth.*fail/i.test(blob)) {
    return "Grok is not authenticated. Run `grok login` (or `!grok login` inside Claude Code).";
  }

  if (/command not found|No such file or directory.*grok|Grok CLI not found/i.test(blob)) {
    return "Grok CLI not found. Install Grok Build and ensure `grok` is on your PATH.";
  }

  if (/rate.?limit|too many requests|429/i.test(blob)) {
    return "Grok rate-limited the request. Wait a moment and retry.";
  }

  if (/unexpected argument ['\"]--(?:check|best-of-n)['\"]/i.test(blob)) {
    return (
      "The installed Grok CLI does not support a plugin orchestration flag (`--check` or `--best-of-n`). " +
      "Update the Grok worker plugin and retry; self-check is handled in the task contract."
    );
  }

  if (/model .+ not found|unknown model|invalid model/i.test(blob)) {
    return "Grok rejected the model id. Use a valid model (e.g. `grok-4.6` or `--model fast`).";
  }

  // Prefer structured JSON error message if present in the blob
  try {
    const jsonMatch = blob.match(/\{[\s\S]*"type"\s*:\s*"error"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.message) {
        return humanizeGrokFailure({ message: parsed.message, exitCode: sources.exitCode });
      }
    }
  } catch {
    // fall through
  }

  // Drop obvious Rust debug noise / huge dumps
  const firstUseful =
    blob
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(
        (l) =>
          l &&
          !/^\[stderr\]/i.test(l) &&
          !/^thread '/i.test(l) &&
          !/^note:/i.test(l) &&
          !/^at /i.test(l) &&
          l.length < 400
      ) || compact.slice(0, 280);

  if (sources.exitCode != null && sources.exitCode !== 0) {
    return `Grok failed (exit ${sources.exitCode}): ${firstUseful}`;
  }
  return firstUseful;
}

export function parseGrokJsonOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return { ok: false, error: "Grok produced empty output", raw: "" };
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates = [...lines].reverse();
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        if (parsed.type === "error") {
          const rawMessage = parsed.message || "Grok returned an error object";
          return {
            ok: false,
            error: humanizeGrokFailure({ parsedError: rawMessage, stdout: text }),
            raw: text,
            parsed
          };
        }
        return {
          ok: true,
          text: typeof parsed.text === "string" ? parsed.text : "",
          sessionId: parsed.sessionId ?? null,
          stopReason: parsed.stopReason ?? null,
          requestId: parsed.requestId ?? null,
          thought: parsed.thought ?? null,
          raw: text,
          parsed
        };
      }
    } catch {
      // try next candidate
    }
  }

  // Non-JSON failure dumps (e.g. Rust RequirementError on stdout/stderr merge)
  if (/RequirementError|Error:|panic/i.test(text) && !/^\s*\{/.test(text)) {
    return {
      ok: false,
      error: humanizeGrokFailure({ stdout: text }),
      raw: text,
      parsed: null
    };
  }

  return {
    ok: true,
    text,
    sessionId: null,
    stopReason: null,
    requestId: null,
    thought: null,
    raw: text,
    parsed: null
  };
}

export function runGrok(options = {}) {
  const availability = getGrokAvailability();
  if (!availability.available) {
    throw new Error(availability.reason);
  }

  const effectiveOptions = normalizeWorkerPolicy(options, {
    toolName: options.workerPolicy?.toolName || "grok-foreground",
    writeCapable: options.write === true
  });
  assertGrokCliCompatibility(effectiveOptions);
  const args = buildGrokArgs(effectiveOptions);
  const commandGuard = createCommandGuard();
  const env = prependCommandGuard(
    buildWorkerEnv({ ...process.env, ...(effectiveOptions.env ?? {}) }, { grokBinary: availability.binary }),
    commandGuard
  );
  let result;
  try {
    result = runCommand(availability.binary, args, {
      cwd: effectiveOptions.cwd,
      maxBuffer: effectiveOptions.maxBuffer ?? 40 * 1024 * 1024,
      env: { ...env, RUST_LOG: effectiveOptions.rustLog ?? "off" }
    });
  } finally {
    cleanupCommandGuard(commandGuard);
  }

  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const parsed = parseGrokJsonOutput(stdout);
  const ok = result.status === 0 && parsed.ok;

  if (!ok) {
    parsed.error = humanizeGrokFailure({
      parsedError: parsed.error,
      stderr,
      stdout,
      exitCode: result.status
    });
  }

  return {
    binary: availability.binary,
    args,
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
    parsed,
    ok,
    workerPolicy: summarizeWorkerPolicy(effectiveOptions.workerPolicy)
  };
}

export async function runGrokAsync(options = {}) {
  const availability = getGrokAvailability();
  if (!availability.available) {
    throw new Error(availability.reason);
  }

  const effectiveOptions = normalizeWorkerPolicy(options, {
    toolName: options.workerPolicy?.toolName || "grok-foreground",
    writeCapable: options.write === true
  });
  assertGrokCliCompatibility(effectiveOptions);
  const args = buildGrokArgs(effectiveOptions);
  const commandGuard = createCommandGuard();
  const env = prependCommandGuard(
    buildWorkerEnv({ ...process.env, ...(effectiveOptions.env ?? {}) }, { grokBinary: availability.binary }),
    commandGuard
  );
  let result;
  try {
    result = await runCommandAsync(availability.binary, args, {
      cwd: effectiveOptions.cwd,
      maxBuffer: effectiveOptions.maxBuffer,
      env: { ...env, RUST_LOG: effectiveOptions.rustLog ?? "off" },
      signal: effectiveOptions.signal,
      timeout: effectiveOptions.timeout,
      killGraceMs: effectiveOptions.killGraceMs
    });
  } finally {
    cleanupCommandGuard(commandGuard);
  }

  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const parsed = parseGrokJsonOutput(stdout);
  const ok = result.status === 0 && parsed.ok && !result.cancelled && !result.timedOut;
  if (!ok) {
    parsed.error = result.cancelled
      ? result.cancellationReason || "Cancelled"
      : humanizeGrokFailure({
        parsedError: parsed.error,
        stderr,
        stdout,
        exitCode: result.status
      });
  }

  return {
    binary: availability.binary,
    args,
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
    parsed,
    ok,
    cancelled: result.cancelled,
    cancellationReason: result.cancellationReason,
    timedOut: result.timedOut,
    pid: result.pid,
    outputStats: result.outputStats,
    workerPolicy: summarizeWorkerPolicy(effectiveOptions.workerPolicy)
  };
}

/**
 * Compact stream progress for /grok:status: collapse whitespace and keep a tail
 * of accumulated tokens (not a single event).
 *
 * Returns "" when there is no non-whitespace content yet (even if `prefix` is
 * set). Callers should floor empty results to `"running"` so early whitespace-
 * only stream tokens (Grok does emit `"data":" \\n"`) do not blank status.
 *
 * This function's source is embedded into the background worker via
 * {@link getStreamProgressHelperSource} / `Function.prototype.toString` so
 * tests and the live path share one implementation (no drifted copy).
 *
 * @param {string} accumulated
 * @param {{ prefix?: string, maxLen?: number }} [opts]
 */
export function formatStreamProgressMessage(accumulated, opts = {}) {
  const prefix = opts.prefix ?? "";
  const maxLen = opts.maxLen ?? 160;
  const compact = String(accumulated ?? "")
    .replace(/\s+/g, " ")
    .trim();
  // No body yet → empty. Prefix alone ("thinking: ") is not useful progress.
  if (!compact) return "";
  const body = compact.length > maxLen ? compact.slice(-maxLen) : compact;
  return prefix + body;
}

/** Source string interpolated into the background worker script. */
export function getStreamProgressHelperSource() {
  return formatStreamProgressMessage.toString();
}

/**
 * Redact streamed tool events before they are persisted to a background job
 * log. Tool output can contain entire source files, command output, or model
 * context; logs retain only the tool name, file paths, and execution status.
 *
 * The function is deliberately self-contained because its source is embedded
 * into the detached background worker.
 */
export function sanitizeStreamLogLine(line, toolCallContext = new Map()) {
  const raw = String(line ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return "";

  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return raw;
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return raw;

  const eventType = String(event.type ?? event.event ?? "").toLowerCase();
  const toolCallId = String(
    event.toolCallId ?? event.tool_call_id ?? event.callId ?? event.call_id ?? ""
  );
  const isToolEvent = eventType.includes("tool") || Boolean(
    toolCallId && (
      event.name || event.toolName || event.tool_name || event.tool ||
      event.content || event.output || event.result
    )
  );
  if (!isToolEvent) return raw;

  const cleanToolName = (value) => {
    const candidate = String(value ?? "").trim();
    return /^[a-zA-Z0-9_.:-]{1,120}$/.test(candidate) ? candidate : "unknown";
  };
  const existing = toolCallId && typeof toolCallContext?.get === "function"
    ? toolCallContext.get(toolCallId) ?? {}
    : {};
  const toolName = cleanToolName(
    event.toolName ?? event.tool_name ?? event.name ?? event.tool?.name ??
    event.toolCall?.name ?? event.tool_call?.name ?? event.function?.name ??
    existing.toolName
  );

  const filePaths = [];
  const seenPaths = new Set();
  const addPath = (value) => {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== "string") continue;
      const candidate = item.trim();
      if (!candidate || candidate.length > 2048 || seenPaths.has(candidate)) continue;
      seenPaths.add(candidate);
      filePaths.push(candidate);
    }
  };
  const collectPaths = (value, depth = 0) => {
    if (value == null || depth > 5) return;
    if (typeof value === "string") {
      const candidate = value.trim();
      if ((candidate.startsWith("{") || candidate.startsWith("[")) && candidate.length < 65536) {
        try {
          collectPaths(JSON.parse(candidate), depth + 1);
        } catch {}
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectPaths(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(path|paths|file|files|filePath|filePaths|file_path|file_paths|filename|target_file|absolute_path)$/i.test(key)) {
        addPath(child);
      } else if (/^(input|rawInput|arguments|args|parameters|params|locations|tool|toolCall|tool_call|function)$/i.test(key)) {
        collectPaths(child, depth + 1);
      }
    }
  };
  for (const source of [
    event.input,
    event.rawInput,
    event.arguments,
    event.args,
    event.parameters,
    event.params,
    event.locations,
    event.tool,
    event.toolCall,
    event.tool_call,
    event.function
  ]) {
    collectPaths(source);
  }
  for (const priorPath of existing.filePaths ?? []) addPath(priorPath);

  const rawStatus = String(event.status ?? event.state ?? "").trim().toLowerCase();
  const allowedStatuses = new Set([
    "queued", "pending", "started", "running", "in_progress", "completed",
    "succeeded", "success", "failed", "error", "cancelled", "canceled"
  ]);
  let status = allowedStatuses.has(rawStatus) ? rawStatus : "unknown";
  if (status === "unknown") {
    if (/error|fail/.test(eventType)) status = "failed";
    else if (/result|complete|finish/.test(eventType)) status = "completed";
    else if (/start|create/.test(eventType)) status = "started";
    else if (/update|delta/.test(eventType)) status = "running";
  }

  if (toolCallId && typeof toolCallContext?.set === "function") {
    toolCallContext.set(toolCallId, { toolName, filePaths });
  }
  return JSON.stringify({ toolName, filePaths, status });
}

/** Source string interpolated into the background worker script. */
export function getStreamLogSanitizerSource() {
  return sanitizeStreamLogLine.toString();
}

/**
 * Build the Node `-e` script that runs a detached Grok process and streams
 * progress. Exported so tests can assert the progress helper is embedded.
 */
export function buildGrokBackgroundWrapperSource({
  binary,
  args,
  promptFile = "",
  resultFile,
  logFile = "",
  progressFile = "",
  cwd = process.cwd(),
  streaming = false,
  env = null,
  commandGuardDir = "",
  cancelFile = "",
  companionPath = "",
  jobId = "",
  maxCaptureBytes = 8 * 1024 * 1024,
  maxLogBytes = 4 * 1024 * 1024
}) {
  // Embed the same function the module exports (not a hand-maintained copy).
  const streamProgressHelper = getStreamProgressHelperSource();
  const streamLogSanitizer = getStreamLogSanitizerSource();
  return `
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const nodePath = require("node:path");
const binary = ${JSON.stringify(binary)};
const args = ${JSON.stringify(args)};
const promptFile = ${JSON.stringify(promptFile || "")};
const resultFile = ${JSON.stringify(resultFile)};
const logFile = ${JSON.stringify(logFile || "")};
const progressFile = ${JSON.stringify(progressFile)};
const cwd = ${JSON.stringify(cwd)};
const streaming = ${JSON.stringify(streaming)};
const childEnv = ${JSON.stringify(env || {})};
const commandGuardDir = ${JSON.stringify(commandGuardDir || "")};
const cancelFile = ${JSON.stringify(cancelFile || "")};
const companionPath = ${JSON.stringify(companionPath || "")};
const jobId = ${JSON.stringify(jobId || "")};
const maxCaptureBytes = ${JSON.stringify(maxCaptureBytes)};
const maxLogBytes = ${JSON.stringify(maxLogBytes)};

${HeadTailBuffer.toString()}
${quoteWindowsArg.toString()}
${resolveSpawnCommand.toString()}

function writeAtomic(filePath, contents) {
  const tmp = filePath + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function cleanupPromptFile() {
  if (!promptFile) return;
  try {
    const resolved = nodePath.resolve(promptFile);
    const parentDir = nodePath.dirname(resolved);
    const parent = nodePath.basename(parentDir);
    if (nodePath.basename(resolved) !== "prompt.md" || !parent.startsWith("grok-companion-")) return;
    fs.rmSync(resolved, { force: true });
    fs.rmSync(parentDir, { recursive: true, force: true });
  } catch {}
}

function cleanupCommandGuard() {
  if (!commandGuardDir) return;
  try { fs.rmSync(commandGuardDir, { recursive: true, force: true }); } catch {}
}

function append(line) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, "[" + new Date().toISOString() + "] " + line + "\\n");
    const stat = fs.statSync(logFile);
    if (stat.size > maxLogBytes) {
      const retainedBytes = Math.floor(maxLogBytes / 2);
      const fd = fs.openSync(logFile, "r");
      const tail = Buffer.alloc(retainedBytes);
      try { fs.readSync(fd, tail, 0, retainedBytes, stat.size - retainedBytes); }
      finally { fs.closeSync(fd); }
      const marker = Buffer.from("[... earlier bounded log output omitted ...]\\n", "utf8");
      writeAtomic(logFile, Buffer.concat([marker, tail]));
    }
  } catch {}
}

function writeProgress(patch) {
  if (!progressFile) return;
  try {
    let current = {};
    if (fs.existsSync(progressFile)) {
      current = JSON.parse(fs.readFileSync(progressFile, "utf8"));
    }
    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    writeAtomic(progressFile, JSON.stringify(next, null, 2) + "\\n");
  } catch {}
}

append("Starting Grok: " + binary + " " + args.join(" "));
writeProgress({ phase: "starting", message: "Launching Grok", lines: 0 });

const resolved = resolveSpawnCommand(binary, args);
const child = spawn(resolved.command, resolved.args, {
  cwd,
  env: { ...childEnv, RUST_LOG: "off" },
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
child.on("error", () => {
  cleanupPromptFile();
  cleanupCommandGuard();
});

const stdoutCapture = new HeadTailBuffer(maxCaptureBytes);
const stderrCapture = new HeadTailBuffer(maxCaptureBytes);
const textCapture = new HeadTailBuffer(maxCaptureBytes);
const thoughtCapture = new HeadTailBuffer(Math.min(maxCaptureBytes, 1024 * 1024));
let sessionId = null;
let lineCount = 0;
let lastMessage = "running";
let cancelRequested = false;
let cancelRequestedAt = null;

${streamProgressHelper}
${streamLogSanitizer}

const toolLogContext = new Map();

function handleStreamLine(line) {
  lineCount += 1;
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const evt = JSON.parse(trimmed);
    if (evt.type === "text" && evt.data) {
      textCapture.append(evt.data);
      // Tail of accumulated text; floor empty so whitespace-only tokens keep "running"
      lastMessage = formatStreamProgressMessage(textCapture.toString({ marker: false }), {}) || "running";
    } else if (evt.type === "thought" && evt.data) {
      thoughtCapture.append(evt.data);
      lastMessage =
        formatStreamProgressMessage(thoughtCapture.toString({ marker: false }), { prefix: "thinking: " }) || "running";
    } else if (evt.type === "end") {
      sessionId = evt.sessionId || sessionId;
      lastMessage = "finishing";
    } else if (evt.type === "error") {
      lastMessage = evt.message || "error";
    }
    if (evt.sessionId) sessionId = evt.sessionId;
  } catch {
    lastMessage = trimmed.slice(0, 120);
  }
  if (lineCount % 3 === 0 || /end|error/i.test(trimmed)) {
    writeProgress({
      phase: "running",
      message: lastMessage,
      lines: lineCount,
      sessionId
    });
  }
}

let stdoutBuf = "";
child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  stdoutCapture.append(chunk);
  stdoutBuf += text;
  let idx;
  while ((idx = stdoutBuf.indexOf("\\n")) !== -1) {
    const line = stdoutBuf.slice(0, idx);
    stdoutBuf = stdoutBuf.slice(idx + 1);
    const sanitized = sanitizeStreamLogLine(line, toolLogContext);
    if (sanitized) append(sanitized);
    if (streaming) handleStreamLine(line);
  }
});
child.stderr.on("data", (chunk) => {
  stderrCapture.append(chunk);
  append("[stderr] diagnostics emitted");
  writeProgress({ phase: "running", message: "stderr diagnostics emitted", lines: lineCount });
});
const cancelPoll = cancelFile ? setInterval(() => {
  if (cancelRequested || !fs.existsSync(cancelFile)) return;
  cancelRequested = true;
  cancelRequestedAt = new Date().toISOString();
  writeProgress({ phase: "cancel_requested", message: "Cancellation requested", cancelRequestedAt });
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); }
    catch { try { child.kill("SIGTERM"); } catch {} }
  }
}, 100) : null;
cancelPoll?.unref?.();
child.on("close", (code, signal) => {
  if (cancelPoll) clearInterval(cancelPoll);
  if (stdoutBuf.trim()) {
    const sanitized = sanitizeStreamLogLine(stdoutBuf, toolLogContext);
    if (sanitized) append(sanitized);
    if (streaming) handleStreamLine(stdoutBuf);
  }

  const stdout = stdoutCapture.toString();
  const stderr = stderrCapture.toString();
  let finalStdout = stdout;
  if (streaming) {
    // Reconstruct a json-format-like payload for the companion parser.
    finalStdout = JSON.stringify({
      text: textCapture.toString() || stdout,
      stopReason: cancelRequested ? "Cancelled" : (code === 0 ? "EndTurn" : "Error"),
      sessionId,
      requestId: null
    });
  }

  const payload = {
    exitCode: code,
    signal,
    stdout: finalStdout,
    stderr,
    finishedAt: new Date().toISOString(),
    sessionId,
    cancelled: cancelRequested,
    cancellationReason: cancelRequested ? "Cancelled by user" : null,
    lifecycle: {
      cancelRequestedAt,
      exitedAt: new Date().toISOString(),
      closedAt: new Date().toISOString()
    },
    outputStats: {
      stdout: stdoutCapture.stats(),
      stderr: stderrCapture.stats(),
      text: textCapture.stats(),
      thought: thoughtCapture.stats()
    }
  };
  try {
    // Atomic write: only publish result.json when the full payload is on disk.
    // Avoids reaper/finalize seeing a truncated mid-write file as "exists".
    writeAtomic(resultFile, JSON.stringify(payload, null, 2) + "\\n");
    writeProgress({
      phase: "closed",
      message: cancelRequested ? "cancelled and closed" : (code === 0 ? "completed and closed" : "failed with code " + code),
      lines: lineCount,
      sessionId
    });
    append("Finished with code " + code);
  } catch (error) {
    append("Failed to write result: " + error.message);
  }
  cleanupPromptFile();
  cleanupCommandGuard();
  if (companionPath && jobId) {
    spawnSync(process.execPath, [companionPath, "result", jobId, "--json"], {
      cwd,
      env: childEnv,
      stdio: "ignore",
      windowsHide: true
    });
  }
  process.exit(cancelRequested ? 1 : (code === null ? 1 : code));
});
`.trim();
}

/**
 * Spawn Grok as a detached background process.
 * Uses streaming-json when progressFile is set so status can show live activity.
 */
export function spawnGrokBackground(options = {}) {
  const availability = getGrokAvailability();
  if (!availability.available) {
    throw new Error(availability.reason);
  }

  const effectiveOptions = normalizeWorkerPolicy(options, {
    toolName: options.workerPolicy?.toolName || "grok-background",
    writeCapable: options.write === true
  });
  assertGrokCliCompatibility(effectiveOptions);
  const useStreaming = Boolean(effectiveOptions.progressFile);
  const args = buildGrokArgs({
    ...effectiveOptions,
    outputFormat: useStreaming ? "streaming-json" : effectiveOptions.outputFormat ?? "json"
  });
  const resultFile = effectiveOptions.resultFile;
  if (!resultFile) {
    throw new Error("resultFile is required for background runs");
  }

  const commandGuard = createCommandGuard();

  let wrapper;
  try {
    wrapper = buildGrokBackgroundWrapperSource({
      binary: availability.binary,
      args,
      resultFile,
      promptFile: effectiveOptions.promptFile || "",
      logFile: effectiveOptions.logFile || "",
      progressFile: effectiveOptions.progressFile || "",
      cwd: effectiveOptions.cwd || process.cwd(),
      streaming: useStreaming,
      env: prependCommandGuard(
        buildWorkerEnv({ ...process.env, ...(effectiveOptions.env ?? {}) }, { grokBinary: availability.binary }),
        commandGuard
      ),
      commandGuardDir: commandGuard,
      cancelFile: effectiveOptions.cancelFile || "",
      companionPath: effectiveOptions.companionPath || "",
      jobId: effectiveOptions.jobId || "",
      maxCaptureBytes: effectiveOptions.maxBuffer ?? 8 * 1024 * 1024,
      maxLogBytes: effectiveOptions.maxLogBytes ?? 4 * 1024 * 1024
    });
  } catch (error) {
    cleanupCommandGuard(commandGuard);
    throw error;
  }

  const child = spawn(process.execPath, ["-e", wrapper], {
    cwd: effectiveOptions.cwd,
    detached: true,
    stdio: "ignore",
    env: buildWorkerEnv(process.env, { grokBinary: availability.binary })
  });
  child.once("error", () => cleanupCommandGuard(commandGuard));
  child.unref();
  return { pid: child.pid, binary: availability.binary, args };
}

export function hasNode() {
  return binaryAvailable("node");
}
