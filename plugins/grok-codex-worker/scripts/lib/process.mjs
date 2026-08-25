import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

export const DEFAULT_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

export class HeadTailBuffer {
  constructor(maxBytes = DEFAULT_CAPTURE_MAX_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes < 2) {
      throw new Error("HeadTailBuffer maxBytes must be an integer greater than one.");
    }
    this.maxBytes = maxBytes;
    this.headBudget = Math.floor(maxBytes / 2);
    this.tailBudget = maxBytes - this.headBudget;
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.totalBytes = 0;
  }

  append(value) {
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
    this.totalBytes += chunk.length;
    if (this.head.length < this.headBudget) {
      const take = Math.min(this.headBudget - this.head.length, chunk.length);
      this.head = Buffer.concat([this.head, chunk.subarray(0, take)]);
      chunk = chunk.subarray(take);
    }
    if (chunk.length) {
      const combined = Buffer.concat([this.tail, chunk]);
      this.tail = combined.length > this.tailBudget
        ? combined.subarray(combined.length - this.tailBudget)
        : combined;
    }
  }

  get retainedBytes() {
    return this.head.length + this.tail.length;
  }

  get omittedBytes() {
    return Math.max(0, this.totalBytes - this.retainedBytes);
  }

  toBuffer({ marker = true } = {}) {
    if (!marker || this.omittedBytes === 0) {
      return Buffer.concat([this.head, this.tail]);
    }
    const omission = Buffer.from(`\n[... omitted ${this.omittedBytes} bytes ...]\n`, "utf8");
    return Buffer.concat([this.head, omission, this.tail]);
  }

  toString(options = {}) {
    return this.toBuffer(options).toString("utf8");
  }

  stats() {
    return {
      maxBytes: this.maxBytes,
      totalBytes: this.totalBytes,
      retainedBytes: this.retainedBytes,
      omittedBytes: this.omittedBytes,
      truncated: this.omittedBytes > 0
    };
  }
}

export function binaryAvailable(name) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [name], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !String(result.stdout || "").trim()) {
    return false;
  }
  return String(result.stdout).split(/\r?\n/).some((line) => line.trim());
}

export function quoteWindowsArg(value) {
  const text = String(value ?? "");
  if (!text || /[\s"&()^|<>]/.test(text)) return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
  return text;
}

export function resolveSpawnCommand(command, args = []) {
  const isCmdScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(String(command));
  if (!isCmdScript) return { command, args };
  const commandLine = [command, ...args].map(quoteWindowsArg).join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    // CALL makes a batch script return to this cmd.exe so the parent can
    // observe a real close event instead of leaving a detached cmd process.
    args: ["/d", "/v:on", "/s", "/c", `call ${commandLine} & exit /b !errorlevel!`]
  };
}

export function spawnCommand(command, args = [], options = {}) {
  const resolved = resolveSpawnCommand(command, args);
  return spawn(resolved.command, resolved.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: options.detached === true,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

export function runCommand(command, args, options = {}) {
  const resolved = resolveSpawnCommand(command, args || []);
  return spawnSync(resolved.command, resolved.args, {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    stdio: options.stdio,
    windowsHide: true,
    timeout: options.timeout
  });
}

export function runCommandAsync(command, args = [], options = {}) {
  const maxBytes = options.maxBuffer ?? DEFAULT_CAPTURE_MAX_BYTES;
  const stdout = new HeadTailBuffer(maxBytes);
  const stderr = new HeadTailBuffer(maxBytes);
  const child = spawnCommand(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached ?? process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  let cancelled = false;
  let cancellationReason = null;
  let timedOut = false;
  let forceTimer = null;
  let timeoutTimer = null;

  return new Promise((resolve) => {
    let settled = false;
    let spawnError = null;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", requestCancellation);
      resolve({
        status,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        outputStats: { stdout: stdout.stats(), stderr: stderr.stats() },
        error: spawnError,
        cancelled,
        cancellationReason,
        timedOut,
        pid: child.pid ?? null
      });
    };
    const requestCancellation = () => {
      if (cancelled || settled) return;
      cancelled = true;
      cancellationReason = String(options.signal?.reason || "Cancelled");
      terminateProcessTree(child.pid, "SIGTERM");
      forceTimer = setTimeout(() => terminateProcessTree(child.pid, "SIGKILL"), options.killGraceMs ?? 2000);
      forceTimer.unref?.();
    };

    child.stdout?.on("data", (chunk) => stdout.append(chunk));
    child.stderr?.on("data", (chunk) => stderr.append(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", finish);

    if (options.signal) {
      options.signal.addEventListener("abort", requestCancellation, { once: true });
      if (options.signal.aborted) requestCancellation();
    }
    if (Number.isFinite(options.timeout) && options.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        cancellationReason = `Timed out after ${options.timeout}ms`;
        terminateProcessTree(child.pid, "SIGKILL");
      }, options.timeout);
      timeoutTimer.unref?.();
    }
  });
}

export function runCommandChecked(command, args, options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result, command, args));
  }
  return result;
}

export function formatCommandFailure(result, command, args = []) {
  const label = [command, ...args].filter(Boolean).join(" ");
  const stderr = String(result.stderr ?? "").trim();
  const stdout = String(result.stdout ?? "").trim();
  const details = stderr || stdout || `exit code ${result.status}`;
  return `${label || "command"} failed: ${details}`;
}

export function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: options.stdio ?? "ignore"
  });
  child.unref();
  return child;
}

export function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function terminateProcessTree(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true
    });
    return result.status === 0 || !isProcessRunning(pid);
  }

  try {
    // Negative PID targets the process group when the child was detached.
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export async function waitForProcessExit(pid, { timeoutMs = 10_000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !isProcessRunning(pid);
}

export function writePidFile(filePath, pid) {
  fs.writeFileSync(filePath, `${pid}\n`, "utf8");
}

export function readPidFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) ? pid : null;
}
