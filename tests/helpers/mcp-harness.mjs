import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;

function appendBounded(current, chunk) {
  const next = current + String(chunk);
  if (Buffer.byteLength(next) <= MAX_DIAGNOSTIC_BYTES) return next;
  return Buffer.from(next).subarray(-MAX_DIAGNOSTIC_BYTES).toString("utf8");
}

export class McpHarness {
  constructor(serverPath, options = {}, { timeoutMs = 15_000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.messages = [];
    this.stdoutText = "";
    this.stderrText = "";
    this.stdoutRemainder = "";
    this.closed = false;
    this.child = spawn(process.execPath, [serverPath], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...options
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrText = appendBounded(this.stderrText, chunk);
    });
    this.child.stdout.on("data", (chunk) => this.#receive(chunk));
    this.child.on("error", (error) => this.#rejectAll(error));
    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.exit = { code, signal };
      this.#rejectAll(new Error(`MCP server closed before response (code=${code}, signal=${signal}). stderr: ${this.stderrText}`));
    });
  }

  #receive(chunk) {
    this.stdoutText = appendBounded(this.stdoutText, chunk);
    this.stdoutRemainder += chunk;
    const lines = this.stdoutRemainder.split("\n");
    this.stdoutRemainder = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.messages.push(message);
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  #rejectAll(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    if (this.closed || !this.child.stdin.writable) throw new Error("MCP server stdin is closed.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, { id = this.nextId++, timeoutMs = this.timeoutMs } = {}) {
    if (this.pending.has(id)) throw new Error(`Duplicate MCP request id: ${id}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms. stderr: ${this.stderrText}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  cancel(requestId, reason = "Cancelled by test") {
    this.notify("notifications/cancelled", { requestId, reason });
  }

  async initialize(clientInfo = { name: "mcp-harness", version: "1.0.0" }) {
    const response = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo
    });
    this.notify("notifications/initialized");
    return response;
  }

  stderr() {
    return this.stderrText;
  }

  stdout() {
    return this.stdoutText;
  }

  responsesFor(id) {
    return this.messages.filter((message) => message.id === id);
  }

  async close({ timeoutMs = 5_000 } = {}) {
    if (this.closed) return this.exit;
    const exited = new Promise((resolve) => this.child.once("close", (code, signal) => resolve({ code, signal })));
    this.child.kill();
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const result = await Promise.race([exited, timeout]);
    if (result) return result;
    this.child.kill("SIGKILL");
    return exited;
  }
}

export function parseToolResult(message) {
  assert.equal(message.error, undefined, message.error?.message);
  assert.equal(message.result?.isError, false, message.result?.content?.[0]?.text);
  return JSON.parse(message.result.content[0].text);
}
