import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const INVOCATION_SCHEMA_VERSION = 1;
export const INVOCATION_ENV = "GROK_CODEX_INVOCATION";
export const POLICY_EVIDENCE_ENV = "GROK_CODEX_POLICY_EVIDENCE";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function fingerprintValue(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalWorkspace(value) {
  if (!value) return null;
  const resolved = path.resolve(String(value));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function createExecutionEnvironment({
  activeWorkspace = null,
  targetWorkspace = null,
  executionWorkspace = null,
  workspaceRoots = []
} = {}) {
  const active = canonicalWorkspace(activeWorkspace);
  const target = canonicalWorkspace(targetWorkspace);
  const execution = canonicalWorkspace(executionWorkspace || target);
  const roots = [...new Set(
    [active, target, ...workspaceRoots.map(canonicalWorkspace)].filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));
  const identity = {
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    host: os.hostname(),
    workspaceRoots: roots,
    activeWorkspace: active,
    targetWorkspace: target,
    executionWorkspace: execution
  };
  return {
    ...identity,
    environmentId: `env_${fingerprintValue(identity).slice(0, 24)}`
  };
}

export function createInvocationEnvelope({
  invocationId = null,
  mcpRequestId = null,
  jobId = null,
  tool,
  backend = "grok-cli",
  attempt = 1,
  model = null,
  effort = null,
  policyFingerprint = null,
  activeWorkspace = null,
  targetWorkspace = null,
  executionWorkspace = null,
  workspaceRoots = []
} = {}) {
  if (!tool) throw new Error("Invocation envelope requires a tool name.");
  const environment = createExecutionEnvironment({
    activeWorkspace,
    targetWorkspace,
    executionWorkspace,
    workspaceRoots
  });
  return {
    schemaVersion: INVOCATION_SCHEMA_VERSION,
    invocationId: invocationId || randomUUID(),
    mcpRequestId,
    jobId,
    tool,
    backend,
    attempt,
    model,
    effort,
    policyFingerprint,
    activeWorkspace: environment.activeWorkspace,
    targetWorkspace: environment.targetWorkspace,
    executionWorkspace: environment.executionWorkspace,
    workspaceRoots: environment.workspaceRoots,
    environmentId: environment.environmentId,
    executionEnvironment: environment
  };
}

export function updateInvocationEnvelope(envelope, patch = {}) {
  if (!envelope) return createInvocationEnvelope(patch);
  return createInvocationEnvelope({
    ...envelope,
    ...patch,
    invocationId: envelope.invocationId,
    workspaceRoots: patch.workspaceRoots || envelope.workspaceRoots || []
  });
}

export function parseEvidenceEnvironment(source = process.env) {
  const parse = (key) => {
    const raw = source[key];
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  return {
    invocation: parse(INVOCATION_ENV),
    policyEvidence: parse(POLICY_EVIDENCE_ENV)
  };
}
