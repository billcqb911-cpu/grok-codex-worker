import assert from "node:assert/strict";
import test from "node:test";

import {
  HeadTailBuffer,
  isProcessRunning,
  runCommandAsync
} from "../plugins/grok-codex-worker/scripts/lib/process.mjs";

test("HeadTailBuffer retains bounded head and tail with exact byte evidence", () => {
  const buffer = new HeadTailBuffer(10);
  buffer.append("012345");
  buffer.append("6789abcdef");

  assert.deepEqual(buffer.stats(), {
    maxBytes: 10,
    totalBytes: 16,
    retainedBytes: 10,
    omittedBytes: 6,
    truncated: true
  });
  assert.equal(buffer.toString({ marker: false }), "01234bcdef");
  assert.match(buffer.toString(), /^01234\n\[\.\.\. omitted 6 bytes \.\.\.\]\nbcdef$/);
});

test("runCommandAsync confirms an aborted child has closed", async () => {
  const controller = new AbortController();
  const running = runCommandAsync(
    process.execPath,
    ["-e", "setInterval(() => process.stdout.write('tick\\n'), 20)"],
    { signal: controller.signal, killGraceMs: 250, maxBuffer: 1024 }
  );
  setTimeout(() => controller.abort("test cancellation"), 100);

  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.cancellationReason, "test cancellation");
  assert.ok(Number.isInteger(result.pid));
  assert.equal(isProcessRunning(result.pid), false);
  assert.ok(result.signal || result.status !== 0);
});

test("runCommandAsync times out and returns only after process close", async () => {
  const result = await runCommandAsync(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { timeout: 100, killGraceMs: 100, maxBuffer: 1024 }
  );

  assert.equal(result.timedOut, true);
  assert.match(result.cancellationReason, /Timed out after 100ms/);
  assert.ok(Number.isInteger(result.pid));
  assert.equal(isProcessRunning(result.pid), false);
});
