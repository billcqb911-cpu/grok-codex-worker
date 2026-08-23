import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

export function binaryAvailable(name) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [name], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !String(result.stdout || "").trim()) {
    return false;
  }
  return String(result.stdout).split(/\r?\n/).some((line) => line.trim());
}

function quoteWindowsArg(value) {
  const text = String(value ?? "");
  if (!text || /[\s"&()^|<>]/.test(text)) return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
  return text;
}

export function runCommand(command, args, options = {}) {
  const isCmdScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(String(command));
  const actualCommand = isCmdScript ? (process.env.ComSpec || "cmd.exe") : command;
  const actualArgs = isCmdScript
    ? ["/d", "/s", "/c", [command, ...(args || [])].map(quoteWindowsArg).join(" ")]
    : args;
  return spawnSync(actualCommand, actualArgs, {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    stdio: options.stdio,
    windowsHide: true,
    timeout: options.timeout
  });
}export function runCommandChecked(command, args, options = {}) {
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
