import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyDisclosureStage,
  cleanupDisclosureStage,
  createDisclosureStage,
  normalizeDataPolicy,
  normalizePersonalMode,
  redactText,
  validatePersonalProjectScope
} from "../plugins/grok-codex-worker/scripts/lib/disclosure.mjs";

test("personal disclosure requires explicit consent", () => {
  assert.equal(normalizeDataPolicy("strict"), "strict");
  assert.throws(() => normalizeDataPolicy("personal-sanitized"), /explicit sourceDisclosureConsent/);
  assert.equal(normalizeDataPolicy("personal-sanitized", { consent: true }), "personal-sanitized");
  assert.equal(normalizeDataPolicy("personal-sanitized", { scopedConsent: true }), "personal-sanitized");
});

test("external Personal disclosure is task-local once and exact-path bound", () => {
  const active = fs.mkdtempSync(path.join(os.tmpdir(), "grok-scope-active-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "grok-scope-external-"));
  try {
    assert.equal(normalizePersonalMode("once"), "once");
    assert.equal(validatePersonalProjectScope({
      dataPolicy: "personal-sanitized",
      personalMode: "on",
      cwd: active,
      activeWorkspace: active
    }).externalProject, false);
    assert.throws(() => validatePersonalProjectScope({
      dataPolicy: "personal-sanitized",
      personalMode: "on",
      authorizedProject: external,
      cwd: active,
      activeWorkspace: active
    }), /only valid for a project outside/);
    assert.throws(() => validatePersonalProjectScope({
      dataPolicy: "personal-sanitized",
      personalMode: "once",
      authorizedProject: active,
      cwd: active,
      activeWorkspace: active
    }), /only valid for a project outside/);
    assert.equal(validatePersonalProjectScope({
      dataPolicy: "personal-sanitized",
      personalMode: "once",
      authorizedProject: external,
      cwd: external,
      activeWorkspace: active
    }).externalProject, true);
    assert.throws(() => validatePersonalProjectScope({
      dataPolicy: "personal-sanitized",
      personalMode: "on",
      cwd: external,
      activeWorkspace: active
    }), /requires personalMode=once/);
    assert.throws(() => validatePersonalProjectScope({
      dataPolicy: "personal-sanitized",
      personalMode: "once",
      cwd: external,
      activeWorkspace: active
    }), /requires authorizedProject/);
    assert.throws(() => validatePersonalProjectScope({
      dataPolicy: "personal-sanitized",
      personalMode: "once",
      authorizedProject: active,
      cwd: external,
      activeWorkspace: active
    }), /exactly match/);
  } finally {
    fs.rmSync(active, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("redactText removes credential-shaped values while retaining ordinary source", () => {
  const result = redactText([
    "const answer = 42;",
    "XAI_API_KEY=xai-abcdefghijklmnop",
    "password=supersecret123",
    "Authorization: Bearer abcdefghijklmnop",
    '{"client_secret":"jsonsecret123"}',
    "<password>xmlsecret123</password>",
    "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP"
  ].join("\n"));
  assert.match(result.text, /const answer = 42/);
  assert.doesNotMatch(result.text, /xai-abcdefghijklmnop|supersecret123|abcdefghijklmnop|jsonsecret123|xmlsecret123|AKIAABCDEFGHIJKLMNOP/);
  assert.equal(result.count, 6);
});

test("personal staging excludes credentials and safely writes clean files back", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-disclosure-test-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "XAI_API_KEY=xai-abcdefghijklmnop\n", "utf8");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "config"), "private", "utf8");
  const stage = createDisclosureStage(root, {
    jobId: "job-1",
    dataPolicy: "personal-sanitized",
    consent: true
  });
  try {
    assert.equal(fs.existsSync(path.join(stage.stageRoot, ".env")), false);
    assert.equal(fs.existsSync(path.join(stage.stageRoot, ".git")), false);
    assert.equal(stage.files.some((item) => item.path.endsWith("app.js")), true);
    fs.writeFileSync(path.join(stage.stageRoot, "src", "app.js"), "export const value = 2;\n", "utf8");
    fs.writeFileSync(path.join(stage.stageRoot, "src", "new.js"), "export const added = true;\n", "utf8");
    const applied = applyDisclosureStage(root, stage, { write: true });
    assert.equal(applied.ok, true);
    assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "export const value = 2;\n");
    assert.equal(fs.readFileSync(path.join(root, "src", "new.js"), "utf8"), "export const added = true;\n");
    assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "XAI_API_KEY=xai-abcdefghijklmnop\n");
  } finally {
    cleanupDisclosureStage(stage);
  }
  assert.equal(fs.existsSync(stage.stageParent), false);
});

test("personal staging skips generated trees and oversized files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-disclosure-size-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, ".venv"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "ok\n", "utf8");
  fs.writeFileSync(path.join(root, ".venv", "dependency.py"), "ignored\n", "utf8");
  fs.writeFileSync(path.join(root, "dist", "bundle.js"), "ignored\n", "utf8");
  fs.writeFileSync(path.join(root, "large.txt"), "123456789", "utf8");
  const stage = createDisclosureStage(root, {
    jobId: "job-size",
    dataPolicy: "personal-sanitized",
    consent: true,
    maxFileBytes: 8
  });
  try {
    assert.equal(fs.existsSync(path.join(stage.stageRoot, "src", "app.js")), true);
    assert.equal(fs.existsSync(path.join(stage.stageRoot, ".venv")), false);
    assert.equal(fs.existsSync(path.join(stage.stageRoot, "dist")), false);
    assert.equal(fs.existsSync(path.join(stage.stageRoot, "large.txt")), false);
    assert.ok(stage.excluded.some((item) => item.path === ".venv" && item.reason === "protected-directory"));
    assert.ok(stage.excluded.some((item) => item.path === "dist" && item.reason === "protected-directory"));
    assert.ok(stage.excluded.some((item) => item.path === "large.txt" && item.reason === "max-file-size"));
  } finally {
    cleanupDisclosureStage(stage);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("personal staging never writes back a file that contained redactions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-disclosure-redaction-"));
  fs.writeFileSync(path.join(root, "config.js"), "export const password = 'supersecret123';\n", "utf8");
  const stage = createDisclosureStage(root, { jobId: "job-2", dataPolicy: "personal-sanitized", consent: true });
  try {
    const staged = path.join(stage.stageRoot, "config.js");
    assert.doesNotMatch(fs.readFileSync(staged, "utf8"), /supersecret123/);
    fs.writeFileSync(staged, `${fs.readFileSync(staged, "utf8")}export const changed = true;\n`, "utf8");
    const applied = applyDisclosureStage(root, stage, { write: true });
    assert.equal(applied.ok, false);
    assert.match(applied.message, /config\.js/);
    assert.match(fs.readFileSync(path.join(root, "config.js"), "utf8"), /supersecret123/);
  } finally {
    cleanupDisclosureStage(stage);
  }
});

test("personal write-back is atomic when any staged change is blocked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-disclosure-atomic-"));
  fs.writeFileSync(path.join(root, "clean.js"), "export const clean = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, "secret.js"), "export const password = 'supersecret123';\n", "utf8");
  const stage = createDisclosureStage(root, { jobId: "job-3", dataPolicy: "personal-sanitized", consent: true });
  try {
    fs.writeFileSync(path.join(stage.stageRoot, "clean.js"), "export const clean = 2;\n", "utf8");
    fs.writeFileSync(path.join(stage.stageRoot, "secret.js"), "export const password = '[REDACTED_PASSWORD_1]';\nexport const changed = true;\n", "utf8");
    const applied = applyDisclosureStage(root, stage, { write: true });
    assert.equal(applied.ok, false);
    assert.equal(applied.applied.length, 0);
    assert.equal(fs.readFileSync(path.join(root, "clean.js"), "utf8"), "export const clean = 1;\n");
  } finally {
    cleanupDisclosureStage(stage);
  }
});

test("personal write-back blocks protected or out-of-scope new files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-disclosure-scope-"));
  fs.writeFileSync(path.join(root, "app.js"), "export const x = 1;\n", "utf8");
  const stage = createDisclosureStage(root, { jobId: "job-4", dataPolicy: "personal-sanitized", consent: true });
  try {
    fs.writeFileSync(path.join(stage.stageRoot, "other.js"), "export const other = true;\n", "utf8");
    fs.writeFileSync(path.join(stage.stageRoot, ".env"), "SAFE_NAME=value\n", "utf8");
    const applied = applyDisclosureStage(root, stage, { write: true, allowedChangedFiles: ["app.js"] });
    assert.equal(applied.ok, false);
    assert.equal(fs.existsSync(path.join(root, "other.js")), false);
    assert.equal(fs.existsSync(path.join(root, ".env")), false);
    assert.ok(applied.blocked.some((item) => item.reason === "outside-allowed-changed-files"));
    assert.ok(applied.blocked.some((item) => item.reason === "credential-file"));
  } finally {
    cleanupDisclosureStage(stage);
  }
});
