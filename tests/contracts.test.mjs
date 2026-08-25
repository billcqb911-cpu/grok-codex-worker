import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendCompletionContract,
  normalizeCheckPolicy,
  normalizeCheckTimeout,
  normalizeExpectedFiles,
  shellCommandForPlatform,
  verifyExpectedFiles,
  verifyProducedArtifacts,
  describeContract,
  evaluateChangedFileScope,
  evaluateActualChangeContract
} from "../plugins/grok-codex-worker/scripts/lib/contracts.mjs";

test("completion contract keeps expected files inside workspace", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-contract-"));
  assert.deepEqual(normalizeExpectedFiles(cwd, ["notes.md", "notes.md"]), [path.join(cwd, "notes.md")]);
  assert.throws(() => normalizeExpectedFiles(cwd, ["..\\outside.md"]), /inside the workspace/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("expected file verification rejects missing and accepts non-empty files", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-contract-"));
  const file = path.join(cwd, "result.md");
  assert.equal(verifyExpectedFiles(cwd, ["result.md"]).ok, false);
  fs.writeFileSync(file, "done\n");
  const result = verifyExpectedFiles(cwd, ["result.md"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("plan artifact verification fails closed when Grok only narrates success", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-contract-"));
  const result = verifyProducedArtifacts(cwd, { kind: "plan" }, []);
  assert.equal(result.ok, false);
  assert.match(result.message, /no non-empty plan\.md artifact/);
  fs.mkdirSync(path.join(cwd, ".grok-plans"), { recursive: true });
  const plan = path.join(cwd, ".grok-plans", "plan.md");
  fs.writeFileSync(plan, "# Plan\n");
  const verified = verifyProducedArtifacts(cwd, { kind: "plan" }, [{ kind: "plan-copy", path: plan }]);
  assert.equal(verified.ok, true);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("completion prompt states the verification contract", () => {
  const prompt = appendCompletionContract("Implement it", { expectedFiles: ["out.md"], checkCommand: "node --check index.mjs" });
  assert.match(prompt, /Create or update this file/);
  assert.match(prompt, /node --check index\.mjs/);
});

test("completion contract expresses self-check without a CLI flag", () => {
  const prompt = appendCompletionContract("Review it", { selfCheck: true });
  assert.match(prompt, /perform a concise self-check/i);
  assert.doesNotMatch(prompt, /--check/);
});

test("check command uses a platform shell", () => {
  const spec = shellCommandForPlatform("echo ok");
  assert.ok(spec.command);
  assert.ok(Array.isArray(spec.args));
});
test("check policy and timeout normalization fail closed", () => {
  assert.equal(normalizeCheckPolicy(undefined), "on-success");
  assert.equal(normalizeCheckPolicy("always"), "always");
  assert.throws(() => normalizeCheckPolicy("never"), /Invalid check policy/);
  assert.equal(normalizeCheckTimeout(undefined), 120000);
  assert.equal(normalizeCheckTimeout("500"), 500);
  assert.throws(() => normalizeCheckTimeout("50"), /between 100 and 3600000/);
  assert.throws(() => normalizeCheckTimeout("bad"), /between 100 and 3600000/);
});
test("contract evidence is not verified when Grok itself fails", () => {
  const contract = describeContract(
    {},
    { ok: true, valid: [], expectedDir: null },
    { ok: true, paths: [], missing: [] },
    null,
    { grokOk: false }
  );
  assert.equal(contract.grokOk, false);
  assert.equal(contract.verified, false);
});
test("contract verification requires worker security policy evidence", () => {
  const base = [
    {},
    { ok: true, valid: [], expectedDir: null },
    { ok: true, paths: [], missing: [] },
    { ok: true }
  ];
  const missing = describeContract(...base, { grokOk: true });
  assert.equal(missing.verified, false);
  const present = describeContract(...base, {
    grokOk: true,
    policyCheck: { ok: true, required: true, policyVersion: 2 }
  });
  assert.equal(present.verified, true);
});
test("strict changed-file scope detects allowlist and forbidden-path violations", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-contract-scope-"));
  try {
    const changes = {
      added: [{ path: "tests/unit/test_narrative.py" }],
      modified: [{ before: { path: "src/app.py" }, after: { path: "src/app.py" } }],
      deleted: []
    };
    const result = evaluateChangedFileScope(cwd, changes, {
      allowedChangedFiles: ["tests/unit/test_narrative.py"],
      forbiddenChangedPaths: ["src"]
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.violations, [path.join("src", "app.py")]);

    const allowed = evaluateChangedFileScope(cwd, { added: [{ path: "tests/unit/test_narrative.py" }] }, {
      allowedChangedFiles: ["tests/unit/test_narrative.py"]
    });
    assert.equal(allowed.ok, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("actual change contract rejects a write no-op even when the expected file already exists", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-contract-no-op-"));
  try {
    fs.mkdirSync(path.join(cwd, "tests", "unit"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "tests", "unit", "test_narrative.py"), "baseline\n");
    const result = evaluateActualChangeContract(cwd, { write: true, expectedFiles: ["tests/unit/test_narrative.py"] }, { hashAlgorithm: "sha256", added: [], modified: [], deleted: [], counts: { added: 0, modified: 0, deleted: 0 } });
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed_no_change");
    assert.equal(result.zeroChange, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("actual change contract requires every expected file to be changed", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-contract-expected-change-"));
  try {
    const result = evaluateActualChangeContract(cwd, { write: true, expectedFiles: ["tests/unit/test_narrative.py"] }, { hashAlgorithm: "sha256", added: [{ path: "README.md", hash: "after" }], modified: [], deleted: [], counts: { added: 1, modified: 0, deleted: 0 } });
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed_expected_change");
    assert.deepEqual(result.changedFiles, ["README.md"]);
    assert.equal(result.missingExpectedFiles.length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("actual change contract accepts a changed expected file and preserves hash evidence", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-contract-actual-change-"));
  try {
    const result = evaluateActualChangeContract(cwd, { write: true, expectedFiles: ["tests/unit/test_narrative.py"] }, { hashAlgorithm: "sha256", added: [{ path: "tests/unit/test_narrative.py", hash: "after" }], modified: [], deleted: [], counts: { added: 1, modified: 0, deleted: 0 } });
    assert.equal(result.ok, true);
    assert.equal(result.hashAlgorithm, "sha256");
    assert.deepEqual(result.changedFiles, [path.normalize("tests/unit/test_narrative.py")]);
    assert.deepEqual(result.missingExpectedFiles, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("actual change contract fails closed for snapshot-excluded files", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-contract-unverified-"));
  try {
    const result = evaluateActualChangeContract(cwd, { write: true }, {
      hashAlgorithm: "sha256",
      added: [],
      modified: [],
      deleted: [],
      unverifiedChanges: [{ path: "large.bin", status: "unverified", reason: "max-file-size" }],
      counts: { added: 0, modified: 0, deleted: 0 }
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed_unverified_change");
    assert.deepEqual(result.unverifiedChanges.map((item) => item.path), ["large.bin"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
