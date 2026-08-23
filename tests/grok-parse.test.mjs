import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildGrokArgs,
  buildGrokBackgroundWrapperSource,
  formatStreamProgressMessage,
  getStreamLogSanitizerSource,
  getStreamProgressHelperSource,
  humanizeGrokFailure,
  parseGrokJsonOutput,
  sanitizeStreamLogLine
} from "../plugins/grok-codex-worker/scripts/lib/grok.mjs";

test("parseGrokJsonOutput reads success payload", () => {
  const parsed = parseGrokJsonOutput(
    JSON.stringify({
      text: "hello",
      stopReason: "EndTurn",
      sessionId: "sess-1",
      requestId: "req-1"
    })
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.text, "hello");
  assert.equal(parsed.sessionId, "sess-1");
});

test("parseGrokJsonOutput reads error payload", () => {
  const parsed = parseGrokJsonOutput(JSON.stringify({ type: "error", message: "nope" }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /nope/);
});

test("buildGrokArgs write mode enforces strict dontAsk without yolo", () => {
  const args = buildGrokArgs({ prompt: "hi", write: true, model: "grok-4.5" });
  assert.ok(!args.includes("--yolo"));
  assert.ok(args.includes("strict"));
  assert.ok(args.includes("dontAsk"));
  assert.ok(args.includes("Bash(*)"));
  assert.ok(args.includes("MCPTool(*)"));
  assert.ok(args.includes("-m"));
  assert.ok(args.includes("grok-4.5"));
});

test("buildGrokArgs rejects a direct low-level yolo bypass", () => {
  assert.throws(
    () => buildGrokArgs({ prompt: "hi", write: true, yolo: true }),
    /yolo execution is not allowed/i
  );
});

test("buildGrokArgs read-only mode keeps tool graph and uses permission denies", () => {
  const args = buildGrokArgs({ prompt: "review", write: false });
  assert.ok(!args.includes("--yolo"));
  assert.ok(!args.includes("--tools"));
  assert.ok(!args.includes("--disallowed-tools"));
  assert.ok(args.includes("Bash(*)"));
  assert.ok(args.includes("Edit(*)"));
  assert.ok(args.includes("--rules"));
});

test("buildGrokArgs media mode avoids tool graph mutation and yolo", () => {
  const args = buildGrokArgs({
    prompt: "draw a banner",
    media: true,
    write: false,
    yolo: false
  });
  assert.ok(!args.includes("--tools"));
  assert.ok(!args.includes("--yolo"));
  assert.ok(!args.includes("--disallowed-tools"));
  assert.ok(args.includes("Bash(*)"));
});

test("humanizeGrokFailure maps RequirementError tool dumps", () => {
  const msg = humanizeGrokFailure({
    stderr:
      'RequirementError { message: "run_terminal_cmd background param constraint with --tools allowlist" }',
    exitCode: 1
  });
  assert.match(msg, /tool configuration/i);
  assert.match(msg, /permission deny rules/i);
  assert.ok(!/RequirementError \{/.test(msg));
});

test("humanizeGrokFailure maps auth failures", () => {
  const msg = humanizeGrokFailure({ stderr: "Error: not logged in" });
  assert.match(msg, /not authenticated/i);
  assert.match(msg, /grok login/i);
});

test("parseGrokJsonOutput humanizes bare RequirementError text", () => {
  const parsed = parseGrokJsonOutput(
    'Error: RequirementError { kind: "tools", detail: "run_terminal_cmd background" }'
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /tool configuration|requirement error/i);
});

test("formatStreamProgressMessage tails accumulated text", () => {
  assert.equal(formatStreamProgressMessage("  hello   world  "), "hello world");
  const long = "a".repeat(200);
  const msg = formatStreamProgressMessage(long);
  assert.equal(msg.length, 160);
  assert.equal(msg, "a".repeat(160));
});

test("formatStreamProgressMessage is empty until non-whitespace content exists", () => {
  // Grok emits truthy whitespace-only thought/text chunks; helper must not invent
  // a prefix-only line — call sites floor empty to "running".
  assert.equal(formatStreamProgressMessage(""), "");
  assert.equal(formatStreamProgressMessage("   "), "");
  assert.equal(formatStreamProgressMessage(" \n\t "), "");
  assert.equal(formatStreamProgressMessage("", { prefix: "thinking: " }), "");
  assert.equal(formatStreamProgressMessage("  ", { prefix: "thinking: " }), "");
  // Floor pattern used by the background worker
  assert.equal(formatStreamProgressMessage(" \n") || "running", "running");
  assert.equal(
    formatStreamProgressMessage("  ", { prefix: "thinking: " }) || "running",
    "running"
  );
});

test("formatStreamProgressMessage tails thinking with prefix (not single token)", () => {
  // Live repro: thought events stream as tiny chunks; progress must show a tail of all of them.
  let thoughtAcc = "";
  for (const chunk of [" frame", "...", " how control.mjs is used", " across the plugin"]) {
    thoughtAcc += chunk;
  }
  const msg = formatStreamProgressMessage(thoughtAcc, { prefix: "thinking: " });
  assert.match(msg, /^thinking: /);
  assert.match(msg, /across the plugin/);
  assert.ok(!/^thinking:  frame\.\.\.$/.test(msg), "must not show only first token");
  // Last token alone would be " across the plugin" — full tail is longer.
  assert.ok(msg.length > "thinking:  across the plugin".length);
});

test("background wrapper embeds the same progress helper tests exercise", () => {
  const helperSrc = getStreamProgressHelperSource();
  assert.equal(helperSrc, formatStreamProgressMessage.toString());

  // The string that lands in the worker is the live function body — evaluate it.
  const embedded = new Function(`${helperSrc}; return formatStreamProgressMessage;`)();
  assert.equal(embedded("  hello   world  "), "hello world");
  assert.equal(embedded("a".repeat(200)).length, 160);
  assert.equal(embedded(" \n") || "running", "running");
  assert.equal(embedded("  ", { prefix: "thinking: " }) || "running", "running");

  let thoughtAcc = "";
  for (const chunk of [" frame", "...", " how control.mjs is used", " across the plugin"]) {
    thoughtAcc += chunk;
  }
  const thinking = embedded(thoughtAcc, { prefix: "thinking: " });
  assert.match(thinking, /^thinking: /);
  assert.match(thinking, /across the plugin/);

  const wrapper = buildGrokBackgroundWrapperSource({
    binary: "/usr/bin/true",
    args: ["-p", "hi"],
    resultFile: "/tmp/result.json",
    progressFile: "/tmp/progress.json",
    cwd: "/tmp",
    streaming: true
  });
  assert.ok(
    wrapper.includes(helperSrc),
    "worker script must contain the helper source (not a drifted copy)"
  );
  assert.ok(!wrapper.includes("formatProgressTail"), "old inline copy must be gone");
  assert.match(wrapper, /formatStreamProgressMessage\(thoughtAcc/);
  assert.match(wrapper, /formatStreamProgressMessage\(textAcc/);
  // Call-site floor: empty helper result must not blank /status
  assert.match(
    wrapper,
    /formatStreamProgressMessage\(textAcc,\s*\{\}\)\s*\|\|\s*"running"/
  );
  assert.match(wrapper, /\|\|\s*"running"/g);
  const floors = wrapper.match(/\|\|\s*"running"/g) || [];
  assert.equal(floors.length, 2, "text and thought branches both floor empty progress");
});

test("tool stream logs retain only name, paths, and status", () => {
  const context = new Map();
  const started = sanitizeStreamLogLine(JSON.stringify({
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "read_file",
    status: "started",
    rawInput: {
      target_file: "README.md",
      content: "SECRET_FILE_BODY"
    }
  }), context);
  assert.deepEqual(JSON.parse(started), {
    toolName: "read_file",
    filePaths: ["README.md"],
    status: "started"
  });

  const completed = sanitizeStreamLogLine(JSON.stringify({
    type: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    locations: [{ path: "README.md" }],
    content: [{
      type: "content",
      content: { type: "text", text: "SECRET_FILE_BODY" }
    }]
  }), context);
  assert.deepEqual(JSON.parse(completed), {
    toolName: "read_file",
    filePaths: ["README.md"],
    status: "completed"
  });
  assert.ok(!started.includes("SECRET_FILE_BODY"));
  assert.ok(!completed.includes("SECRET_FILE_BODY"));
  assert.ok(!completed.includes("content"));
});

test("background wrapper embeds log sanitizer and never appends raw stdout chunks", () => {
  const sanitizerSrc = getStreamLogSanitizerSource();
  assert.equal(sanitizerSrc, sanitizeStreamLogLine.toString());

  const wrapper = buildGrokBackgroundWrapperSource({
    binary: "/usr/bin/true",
    args: ["-p", "hi"],
    resultFile: "/tmp/result.json",
    logFile: "/tmp/job.log",
    progressFile: "/tmp/progress.json",
    cwd: "/tmp",
    streaming: true
  });
  assert.ok(wrapper.includes(sanitizerSrc));
  assert.ok(!wrapper.includes("append(text.trimEnd())"));
  assert.match(wrapper, /sanitizeStreamLogLine\(line, toolLogContext\)/);
});

test("background worker persists redacted tool events without file bodies", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-redacted-log-"));
  try {
    const mock = path.join(dir, "mock-stream.mjs");
    const logFile = path.join(dir, "job.log");
    const resultFile = path.join(dir, "result.json");
    const progressFile = path.join(dir, "progress.json");
    fs.writeFileSync(mock, [
      "const events = [",
      "  { type: 'tool_call', toolCallId: 'call-1', toolName: 'read_file', status: 'started', rawInput: { target_file: 'README.md' } },",
      "  { type: 'tool_call_update', toolCallId: 'call-1', status: 'completed', locations: [{ path: 'README.md' }], rawOutput: { type: 'FileContent', FileContent: { absolute_path: 'README.md', content: 'SECRET_FILE_BODY', raw_output: 'SECRET_FILE_BODY' } }, content: [{ type: 'content', content: { type: 'text', text: 'SECRET_FILE_BODY' } }] },",
      "  { type: 'text', data: 'done' },",
      "  { type: 'end', sessionId: 'session-1' }",
      "];",
      "for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');"
    ].join("\n"));

    const wrapper = buildGrokBackgroundWrapperSource({
      binary: process.execPath,
      args: [mock],
      resultFile,
      logFile,
      progressFile,
      cwd: dir,
      streaming: true
    });
    const result = spawnSync(process.execPath, ["-e", wrapper], {
      cwd: dir,
      encoding: "utf8",
      timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);

    const log = fs.readFileSync(logFile, "utf8");
    assert.match(log, /"toolName":"read_file"/);
    assert.match(log, /"filePaths":\["README\.md"\]/);
    assert.match(log, /"status":"completed"/);
    assert.ok(!log.includes("SECRET_FILE_BODY"));
    assert.ok(!log.includes('"content"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("background worker redacts stderr diagnostics and removes its prompt file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-stderr-log-"));
  const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-companion-"));
  const promptFile = path.join(promptDir, "prompt.md");
  try {
    const mock = path.join(dir, "mock-stderr.mjs");
    const logFile = path.join(dir, "job.log");
    const resultFile = path.join(dir, "result.json");
    const progressFile = path.join(dir, "progress.json");
    fs.writeFileSync(promptFile, "PRIVATE_PROMPT_BODY\n");
    fs.writeFileSync(mock, [
      "process.stderr.write('STDERR_SECRET_DIAGNOSTIC\\n');",
      "process.stdout.write(JSON.stringify({ type: 'end', sessionId: 'session-stderr' }) + '\\n');"
    ].join("\n"));
    const wrapper = buildGrokBackgroundWrapperSource({
      binary: process.execPath,
      args: [mock],
      promptFile,
      resultFile,
      logFile,
      progressFile,
      cwd: dir,
      streaming: true
    });
    const result = spawnSync(process.execPath, ["-e", wrapper], {
      cwd: dir,
      encoding: "utf8",
      timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);
    const log = fs.readFileSync(logFile, "utf8");
    assert.match(log, /stderr\] diagnostics emitted/);
    assert.ok(!log.includes("STDERR_SECRET_DIAGNOSTIC"));
    assert.ok(!log.includes("PRIVATE_PROMPT_BODY"));
    assert.equal(fs.existsSync(promptFile), false);
    assert.equal(fs.existsSync(promptDir), false);
    const payload = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.match(payload.stderr, /STDERR_SECRET_DIAGNOSTIC/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(promptDir, { recursive: true, force: true });
  }
});
