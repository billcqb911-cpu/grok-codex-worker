#!/usr/bin/env node

import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { buildWorkerEnv, normalizeWorkerPolicy } from "../scripts/lib/security.mjs";
import { redactText } from "../scripts/lib/disclosure.mjs";
import {
  createInvocationEnvelope,
  INVOCATION_ENV,
  POLICY_EVIDENCE_ENV
} from "../scripts/lib/invocation.mjs";
import { HeadTailBuffer } from "../scripts/lib/process.mjs";

const SERVER_VERSION = "0.1.0";
const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MCP_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
const activeRequests = new Map();

function createRequestCancelFile(requestId) {
  const safeId = String(requestId ?? "request").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return path.join(os.tmpdir(), `grok-mcp-cancel-${process.pid}-${safeId}-${Math.random().toString(36).slice(2)}.json`);
}

function writeCancellationMarker(filePath, requestId) {
  const requestedAt = new Date().toISOString();
  const payload = {
    version: 1,
    requestId,
    status: "cancel_requested",
    reason: "Cancelled by MCP client",
    requestedAt
  };
  const temporary = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
  return payload;
}

/**
 * Resolve the companion from the MCP server install directory. MCP hosts
 * may set process.cwd() to the active project, so a relative companion
 * path is unsafe here, especially for detached jobs.
 */
export function resolveCompanionPath() {
  const companion = path.resolve(ROOT_DIR, "scripts", "grok-companion.mjs");
  if (!fs.existsSync(companion)) {
    throw new Error(
      "Grok companion module not found at " + companion + ". " +
        "The plugin MCP server may be using a stale or incomplete install; restart Codex and reinstall the plugin."
    );
  }
  return companion;
}

const COMPANION = resolveCompanionPath();

const stringSchema = (description) => ({ type: "string", description });
const booleanSchema = (description) => ({ type: "boolean", description });
const integerSchema = (description, minimum = 1) => ({ type: "integer", minimum, description });
const enumSchema = (values, description) => ({ type: "string", enum: values, description });
const WORKSPACE_PROPERTY = {
  cwd: stringSchema(
    "Workspace or repository path for this call. Pass the active Codex project path when the plugin runs from its install cache."
  )
};
const ACTIVE_WORKSPACE_PROPERTY = {
  activeWorkspace: stringSchema(
    "Current Codex task workspace from environment_context.cwd. Keep this equal to cwd for the current project; do not replace it with an external target path."
  )
};

const DATA_POLICY_PROPERTY = enumSchema(
  ["strict", "personal-sanitized"],
  "Source disclosure policy. Personal rescue with personalMode=on or once uses task-local consent for the active workspace; an external cwd requires once plus authorizedProject."
);
const SOURCE_DISCLOSURE_CONSENT_PROPERTY = booleanSchema(
  "Direct consent for a credential-redacted staging handoff. Not needed for Personal on/once in the active workspace; external projects use once plus authorizedProject."
);
const PERSONAL_MODE_PROPERTY = enumSchema(
  ["on", "once"],
  "Personal routing scope. Use once for an external project; on never retains external project access."
);
const AUTHORIZED_PROJECT_PROPERTY = stringSchema(
  "Exact external project path authorized for this one Personal delegation. It must match cwd."
);

/** Public controls that can only preserve or narrow the worker policy floor. */
const CONTROL_PROPERTIES = {
  sandbox: enumSchema(
    ["strict", "workspace", "workspace-write", "read-only"],
    "Requested sandbox compatibility profile. The worker always enforces strict."
  ),
  planMode: booleanSchema("Enable Grok plan mode (--plan)."),
  permissionMode: enumSchema(["dontAsk", "plan"], "Bounded permission mode passed to Grok."),
  noSubagents: booleanSchema("Disable Grok subagents."),
  noMemory: booleanSchema("Disable memory for this session."),
  deny: {
    type: "array",
    items: { type: "string" },
    description: "Permission deny rules (repeatable)."
  },
  disableWebSearch: booleanSchema("Disable web search tools."),
  forkSession: booleanSchema("Fork the current Grok session."),
  maxTurns: integerSchema("Maximum Grok turns for this job."),
  hostToolRequired: booleanSchema("Reject delegation when Codex-only plugins, MCP, browser, or credential actions are required.")
};

const CONTRACT_PROPERTIES = {
  expectedFiles: {
    type: "array",
    items: { type: "string" },
    description: "Files that must be actually added or modified after the job; existence alone is insufficient."
  },
  allowedChangedFiles: {
    type: "array",
    items: { type: "string" },
    description: "Strict allowlist of files Grok may add, modify, or delete when a snapshot is enabled."
  },
  forbiddenChangedPaths: {
    type: "array",
    items: { type: "string" },
    description: "Files or directories Grok must not change when a snapshot is enabled."
  },
  checkCommand: stringSchema("Optional command to run after Grok finishes; non-zero exit means the job failed its completion contract."),
  checkPolicy: stringSchema("Check policy: on-success (default) or always."),
  checkTimeoutMs: integerSchema("Maximum check command duration in milliseconds.", 100),
  snapshot: booleanSchema("Capture a workspace snapshot before write-capable work."),
  noSnapshot: booleanSchema("Disable the workspace snapshot for this job."),
  rollbackOnFailure: booleanSchema("Restore the pre-job snapshot when the job fails its contract or check.")
};
const COMMON_JOB_PROPERTIES = {
  ...CONTRACT_PROPERTIES,
  ...WORKSPACE_PROPERTY,
  background: booleanSchema("Start a background job and return the job id."),
  model: stringSchema("Grok model id or alias, such as fast or deep."),
  effort: stringSchema("Reasoning effort: none, minimal, low, medium, high, xhigh, or max."),
  json: booleanSchema("Return machine-readable JSON from the companion."),
  ...CONTROL_PROPERTIES
};

const TOOL_DEFINITIONS = [
  {
    name: "grok_setup",
    description:
      "Check Grok CLI availability, authentication, min version, and doctor. Optionally toggle the stop review gate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        enableReviewGate: booleanSchema("Enable the optional stop review gate."),
        disableReviewGate: booleanSchema("Disable the optional stop review gate."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_rescue",
    description: "Delegate one bounded, verifiable project-worker invocation to Grok. With Personal on/once, the active workspace is implicitly consented after credential redaction; only an external cwd needs once plus authorizedProject. Codex-only plugins, MCP, browser, credentials, approvals, and external submissions remain on the Codex host; set hostToolRequired when delegation must be refused.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: stringSchema("The task for Grok to investigate, implement, or fix."),
        readOnly: booleanSchema("Prevent source edits by running Grok in read-only mode."),
        resume: booleanSchema("Resume the latest Grok task session for this repository."),
        resumeSession: stringSchema("Resume a specific Grok session id."),
        fresh: booleanSchema("Start a fresh Grok session."),
        worktree: booleanSchema("Run edits in a Grok-managed git worktree."),
        worktreeName: stringSchema("Name for a Grok-managed git worktree."),
        worktreeRef: stringSchema("Base ref for the Grok worktree."),
        check: booleanSchema("Ask Grok to verify its own work before returning."),
        bestOfN: integerSchema("Run N parallel attempts of the same task and keep the best."),
        verbatim: booleanSchema("Avoid adding extra wrapper instructions to the prompt."),
        dataPolicy: DATA_POLICY_PROPERTY,
        sourceDisclosureConsent: SOURCE_DISCLOSURE_CONSENT_PROPERTY,
        personalMode: PERSONAL_MODE_PROPERTY,
        authorizedProject: AUTHORIZED_PROJECT_PROPERTY,
        ...ACTIVE_WORKSPACE_PROPERTY,
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_personal_read",
    description: "Run one credential-redacted, strictly read-only Personal analysis with Grok. The active Codex workspace is authorized by this tool call; an external cwd additionally requires an exact authorizedProject path. Source is sent to the configured remote Grok upstream through a temporary sanitized staging copy.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt", "activeWorkspace"],
      properties: {
        prompt: stringSchema("The source investigation or analysis task for Grok."),
        ...WORKSPACE_PROPERTY,
        ...ACTIVE_WORKSPACE_PROPERTY,
        authorizedProject: AUTHORIZED_PROJECT_PROPERTY,
        model: stringSchema("Grok model id or alias. Defaults to grok-4.6."),
        effort: stringSchema("Reasoning effort. Defaults to high."),
        maxTurns: integerSchema("Maximum Grok turns for this read-only job."),
        check: booleanSchema("Ask Grok to perform a concise self-check before returning."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_plan",
    description:
      "Headless Grok plan mode. Explores the codebase and harvests plan.md into .grok-plans/.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: stringSchema("What to plan. Defaults to a generic explore-and-plan brief."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_review",
    description: "Run a structured read-only Grok review of the working tree, branch, or PR.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        focus: stringSchema("Optional review focus, such as auth, race conditions, or data loss."),
        base: stringSchema("Base git ref for branch review."),
        scope: stringSchema("Review scope: auto, working-tree, or branch."),
        pr: stringSchema("GitHub pull request number."),
        postPending: booleanSchema("Post pending review findings to the PR when applicable."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_adversarial_review",
    description: "Ask Grok to challenge a design, branch, working tree, or PR for hidden risks.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        focus: stringSchema("Design or implementation assumptions Grok should challenge."),
        base: stringSchema("Base git ref for branch review."),
        scope: stringSchema("Review scope: auto, working-tree, or branch."),
        pr: stringSchema("GitHub pull request number."),
        postPending: booleanSchema("Post pending review findings to the PR when applicable."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_workflow",
    description:
      "List or run Grok Rhai multi-agent workflows. Use action=list (read-only) or action=run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: stringSchema("list (default) or run."),
        name: stringSchema("Workflow name (required for run)."),
        args: {
          type: "array",
          items: { type: "string" },
          description: "Workflow args as key=value pairs."
        },
        validateOnly: booleanSchema("Validate the workflow without executing (read-only)."),
        prompt: stringSchema("Optional free-form prompt passed after flags."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_design",
    description:
      "Run design-doc writer/reviewer loop. Harvests design docs into .grok-designs/.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: stringSchema("Design brief."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_execute_plan",
    description:
      "Execute a design-doc PR Plan DAG. Pass designDoc path, or latest=true for the newest design.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        designDoc: stringSchema("Path to design doc. Omit with latest=true."),
        latest: booleanSchema("Use the latest design doc under .grok-designs/."),
        concurrency: integerSchema("Parallel PR plan concurrency."),
        dryRun: booleanSchema("Dry-run only (read-only, no yolo)."),
        autoPr: booleanSchema("Open PRs automatically when the plan supports it."),
        noGraphite: booleanSchema("Disable Graphite stacking."),
        resume: stringSchema("Resume a prior execute-plan PLAN_ID."),
        instructions: stringSchema("Extra instructions for the executor."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_babysit",
    description:
      "Watch PRs and fix CI/review issues via pr-babysit. action=list is read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: stringSchema("add | list | check | remove. Defaults to list."),
        prs: {
          type: "array",
          items: { type: "string" },
          description: "PR numbers for add/check/remove."
        },
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_document",
    description: "Generate docx, pdf, or pptx via Grok document skills into .grok-docs/.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: stringSchema("Document type: docx, pdf, or pptx."),
        prompt: stringSchema("Document brief / content request."),
        ...COMMON_JOB_PROPERTIES
      }
    }
  },
  {
    name: "grok_sessions",
    description: "List, search, or export Grok sessions for this workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        action: stringSchema("list (default), search, or export."),
        query: stringSchema("Search query (for search)."),
        sessionId: stringSchema("Session id (for export)."),
        limit: integerSchema("Max sessions to return."),
        output: stringSchema("Export output path."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_image",
    description: "Generate or edit an image with Grok and store artifacts under .grok-media/image by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        prompt: stringSchema("Image prompt."),
        background: booleanSchema("Start a background image job and return the job id."),
        edit: stringSchema("Path to an image to edit."),
        aspect: stringSchema("Aspect ratio, such as 16:9, 1:1, or 9:16."),
        model: stringSchema("Grok model id or alias."),
        effort: stringSchema("Reasoning effort."),
        out: stringSchema("Output directory, relative to the workspace or absolute."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_video",
    description: "Generate a short video with Grok and store artifacts under .grok-media/video by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        prompt: stringSchema("Video prompt."),
        background: booleanSchema("Start a background video job and return the job id."),
        image: stringSchema("Primary source image path."),
        refs: {
          type: "array",
          items: { type: "string" },
          description: "Additional reference image paths."
        },
        duration: stringSchema("Video duration supported by Grok, commonly 6 or 10."),
        aspect: stringSchema("Aspect ratio, such as 16:9, 1:1, or 9:16."),
        model: stringSchema("Grok model id or alias."),
        effort: stringSchema("Reasoning effort."),
        out: stringSchema("Output directory, relative to the workspace or absolute."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_status",
    description: "Show active and recent Grok jobs, live progress, and usage when available.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        jobId: stringSchema("Specific job id to inspect."),
        all: booleanSchema("Include older jobs, not only the recent default window."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_result",
    description: "Read the stored result for a completed Grok job (plan body preferred for plan jobs).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        jobId: stringSchema("Specific job id. Omit only when there is one unambiguous recent job."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_cancel",
    description: "Cancel a running Grok background job.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: {
        ...WORKSPACE_PROPERTY,
        jobId: stringSchema("Job id to cancel."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  },
  {
    name: "grok_transfer",
    description: "Build guidance for transferring host-session context into Grok.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...WORKSPACE_PROPERTY,
        source: stringSchema("Optional transcript/source path."),
        json: booleanSchema("Return machine-readable JSON from the companion.")
      }
    }
  }
];

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

export function resolveMcpCwd(input = {}) {
  const requested = hasValue(input.cwd) ? String(input.cwd) : process.cwd();
  const cwd = path.resolve(requested);

  let stats;
  try {
    stats = fs.statSync(cwd);
  } catch {
    throw new Error(`Workspace directory does not exist: ${cwd}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${cwd}`);
  }
  return cwd;
}

function pushFlag(args, condition, flag) {
  if (condition === true) {
    args.push(flag);
  }
}

function pushValue(args, value, flag) {
  if (hasValue(value)) {
    args.push(flag, String(value));
  }
}

function pushArray(args, values, flag) {
  if (!Array.isArray(values)) {
    return;
  }
  for (const value of values) {
    if (hasValue(value)) {
      args.push(flag, String(value));
    }
  }
}

function appendMemoryArgs(args, input) {
  const enabled = input.memory === true || input.memory?.enable === true;
  const disabled = input.noMemory === true || input.memory === false || input.memory?.enable === false;
  if (enabled && disabled) {
    throw new Error("Conflicting Grok memory controls: memory cannot be both enabled and disabled.");
  }
  pushFlag(args, enabled, "--memory");
  pushFlag(args, disabled, "--no-memory");
}

function appendControlArgs(args, input) {
  pushValue(args, input.sandbox, "--sandbox");
  pushFlag(args, input.planMode, "--plan");
  pushValue(args, input.permissionMode, "--permission-mode");
  pushValue(args, input.agent, "--agent");
  pushFlag(args, input.noSubagents, "--no-subagents");
  appendMemoryArgs(args, input);
  pushArray(args, input.allow, "--allow");
  pushArray(args, input.deny, "--deny");
  pushFlag(args, input.disableWebSearch, "--disable-web-search");
  pushFlag(args, input.forkSession, "--fork-session");
  pushValue(args, input.maxTurns, "--max-turns");
}

function appendCommonJobArgs(args, input) {
  pushFlag(args, input.background, "--background");
  pushValue(args, input.model, "--model");
  pushArray(args, input.expectedFiles, "--expected-file");
  pushArray(args, input.allowedChangedFiles, "--allowed-changed-file");
  pushArray(args, input.forbiddenChangedPaths, "--forbidden-changed-path");
  pushValue(args, input.checkCommand, "--check-command");
  pushValue(args, input.checkPolicy, "--check-policy");
  pushValue(args, input.checkTimeoutMs, "--check-timeout-ms");
  pushFlag(args, input.snapshot, "--snapshot");
  pushFlag(args, input.noSnapshot, "--no-snapshot");
  pushFlag(args, input.rollbackOnFailure, "--rollback-on-failure");
  pushValue(args, input.effort, "--effort");
  appendControlArgs(args, input);
  pushFlag(args, input.json, "--json");
}

function appendReviewArgs(args, input) {
  appendCommonJobArgs(args, input);
  pushValue(args, input.base, "--base");
  pushValue(args, input.scope, "--scope");
  pushValue(args, input.pr, "--pr");
  pushFlag(args, input.postPending, "--post-pending");
  if (hasValue(input.focus)) {
    args.push(String(input.focus));
  }
}

function appendTaskArgs(args, input) {
  pushFlag(args, input.background, "--background");
  pushFlag(args, input.readOnly, "--read-only");
  if (input.resumeSession) {
    pushValue(args, input.resumeSession, "--resume-session");
  } else if (input.resume) {
    args.push("--resume-last");
  } else if (input.fresh) {
    args.push("--fresh");
  }

  pushValue(args, input.model, "--model");
  pushValue(args, input.effort, "--effort");
  if (input.worktreeName) {
    pushValue(args, input.worktreeName, "--worktree-name");
  } else {
    pushFlag(args, input.worktree, "--worktree");
  }
  pushValue(args, input.worktreeRef, "--worktree-ref");
  pushFlag(args, input.check, "--check");
  pushValue(args, input.bestOfN, "--best-of-n");
  pushArray(args, input.expectedFiles, "--expected-file");
  pushArray(args, input.allowedChangedFiles, "--allowed-changed-file");
  pushArray(args, input.forbiddenChangedPaths, "--forbidden-changed-path");
  pushValue(args, input.checkCommand, "--check-command");
  pushValue(args, input.checkPolicy, "--check-policy");
  pushValue(args, input.checkTimeoutMs, "--check-timeout-ms");
  pushFlag(args, input.snapshot, "--snapshot");
  pushFlag(args, input.noSnapshot, "--no-snapshot");
  pushFlag(args, input.rollbackOnFailure, "--rollback-on-failure");
  pushFlag(args, input.verbatim, "--verbatim");
  pushValue(args, input.dataPolicy, "--data-policy");
  pushFlag(args, input.sourceDisclosureConsent, "--source-disclosure-consent");
  pushValue(args, input.personalMode, "--personal-mode");
  pushValue(args, input.authorizedProject, "--authorized-project");
  pushValue(args, input.activeWorkspace, "--active-workspace");
  appendControlArgs(args, input);
  pushFlag(args, input.json, "--json");
  if (hasValue(input.prompt)) {
    args.push(input.dataPolicy === "personal-sanitized" ? redactText(String(input.prompt)).text : String(input.prompt));
  }
}

function appendMediaArgs(args, input, kind) {
  pushFlag(args, input.background, "--background");
  pushValue(args, input.model, "--model");
  pushValue(args, input.effort, "--effort");
  pushValue(args, input.aspect, "--aspect");
  pushValue(args, input.out, "--out");
  if (kind === "image") {
    pushValue(args, input.edit, "--edit");
  } else {
    pushValue(args, input.image, "--image");
    pushValue(args, input.duration, "--duration");
    for (const ref of input.refs || []) {
      pushValue(args, ref, "--ref");
    }
  }
  pushFlag(args, input.json, "--json");
  if (hasValue(input.prompt)) {
    args.push(String(input.prompt));
  }
}

function serializeSetup(input) {
  const args = ["setup"];
  pushFlag(args, input.enableReviewGate, "--enable-review-gate");
  pushFlag(args, input.disableReviewGate, "--disable-review-gate");
  pushFlag(args, input.json, "--json");
  return { command: "setup", args };
}

function serializeTask(input) {
  const args = ["task"];
  appendTaskArgs(args, input);
  return { command: "task", args };
}

function serializePromptJob(command, input) {
  const args = [command];
  appendCommonJobArgs(args, input);
  if (hasValue(input.prompt)) args.push(String(input.prompt));
  return { command, args };
}

function serializeReview(command, input) {
  const args = [command];
  appendReviewArgs(args, input);
  return { command, args };
}

function serializeWorkflow(input) {
  const args = ["workflow"];
  const action = String(input.action || "list").toLowerCase();
  args.push(action);
  if (action === "run") {
    if (hasValue(input.name)) args.push(String(input.name));
    for (const pair of input.args || []) {
      if (hasValue(pair)) args.push("--arg", String(pair));
    }
    pushFlag(args, input.validateOnly, "--validate-only");
    appendCommonJobArgs(args, input);
    if (hasValue(input.prompt)) args.push(String(input.prompt));
  } else {
    pushFlag(args, input.json, "--json");
  }
  return { command: "workflow", args };
}

function serializeExecutePlan(input) {
  const args = ["execute-plan"];
  if (input.latest) args.push("--latest");
  else if (hasValue(input.designDoc)) args.push(String(input.designDoc));
  pushValue(args, input.concurrency, "--concurrency");
  pushFlag(args, input.dryRun, "--dry-run");
  pushFlag(args, input.autoPr, "--auto-pr");
  pushFlag(args, input.noGraphite, "--no-graphite");
  pushValue(args, input.resume, "--resume");
  pushValue(args, input.instructions, "--instructions");
  appendCommonJobArgs(args, input);
  return { command: "execute-plan", args };
}

function serializeBabysit(input) {
  const args = ["babysit"];
  const action = String(input.action || "list").toLowerCase();
  args.push(action);
  for (const pr of input.prs || []) {
    if (hasValue(pr)) args.push(String(pr));
  }
  if (action === "list") pushFlag(args, input.json, "--json");
  else appendCommonJobArgs(args, input);
  return { command: "babysit", args };
}

function serializeDocument(input) {
  const args = ["document"];
  pushValue(args, input.type, "--type");
  appendCommonJobArgs(args, input);
  if (hasValue(input.prompt)) args.push(String(input.prompt));
  return { command: "document", args };
}

function serializeSessions(input) {
  const args = ["sessions"];
  const action = String(input.action || "list").toLowerCase();
  args.push(action);
  if (action === "search" && hasValue(input.query)) args.push(String(input.query));
  if (action === "export" && hasValue(input.sessionId)) args.push(String(input.sessionId));
  pushValue(args, input.limit, "--limit");
  pushValue(args, input.output, "--output");
  pushFlag(args, input.json, "--json");
  return { command: "sessions", args };
}

function serializeMedia(kind, input) {
  const args = [kind];
  appendMediaArgs(args, input, kind);
  return { command: kind, args };
}

function serializeStatus(input) {
  const args = ["status"];
  pushFlag(args, input.all, "--all");
  pushFlag(args, input.json, "--json");
  if (hasValue(input.jobId)) args.push(String(input.jobId));
  return { command: "status", args };
}

function serializeJobLookup(command, input) {
  const args = [command];
  pushFlag(args, input.json, "--json");
  if (hasValue(input.jobId)) args.push(String(input.jobId));
  return { command, args };
}

function serializeTransfer(input) {
  const args = ["transfer"];
  pushValue(args, input.source, "--source");
  pushFlag(args, input.json, "--json");
  return { command: "transfer", args };
}

const readOnlyRescue = (input) => input.readOnly === true;
const readOnlyWorkflow = (input) => String(input.action || "list").toLowerCase() !== "run" || input.validateOnly === true;
const readOnlyExecutePlan = (input) => input.dryRun === true;
const readOnlyBabysit = (input) => String(input.action || "list").toLowerCase() === "list";
const opposite = (predicate) => (input) => !predicate(input);

const TOOL_RUNTIME = Object.freeze({
  grok_setup: { serialize: serializeSetup, readOnly: true, mutatesWorkspace: false, supportsParallel: true, supportsBackground: false, approvalClass: "plugin-state" },
  grok_rescue: { serialize: serializeTask, readOnly: readOnlyRescue, mutatesWorkspace: opposite(readOnlyRescue), supportsParallel: readOnlyRescue, supportsBackground: true, approvalClass: "workspace-conditional" },
  grok_personal_read: { serialize: serializeTask, readOnly: true, mutatesWorkspace: false, supportsParallel: true, supportsBackground: false, approvalClass: "sanitized-source-read" },
  grok_plan: { serialize: (input) => serializePromptJob("plan", input), readOnly: false, mutatesWorkspace: true, supportsParallel: false, supportsBackground: true, approvalClass: "workspace-artifact" },
  grok_review: { serialize: (input) => serializeReview("review", input), readOnly: true, mutatesWorkspace: false, supportsParallel: true, supportsBackground: true, approvalClass: "workspace-read" },
  grok_adversarial_review: { serialize: (input) => serializeReview("adversarial-review", input), readOnly: true, mutatesWorkspace: false, supportsParallel: true, supportsBackground: true, approvalClass: "workspace-read" },
  grok_workflow: { serialize: serializeWorkflow, readOnly: readOnlyWorkflow, mutatesWorkspace: opposite(readOnlyWorkflow), supportsParallel: readOnlyWorkflow, supportsBackground: true, approvalClass: "workflow-conditional" },
  grok_design: { serialize: (input) => serializePromptJob("design", input), readOnly: false, mutatesWorkspace: true, supportsParallel: false, supportsBackground: true, approvalClass: "workspace-write" },
  grok_execute_plan: { serialize: serializeExecutePlan, readOnly: readOnlyExecutePlan, mutatesWorkspace: opposite(readOnlyExecutePlan), supportsParallel: readOnlyExecutePlan, supportsBackground: true, approvalClass: "workspace-conditional" },
  grok_babysit: { serialize: serializeBabysit, readOnly: readOnlyBabysit, mutatesWorkspace: opposite(readOnlyBabysit), supportsParallel: readOnlyBabysit, supportsBackground: true, approvalClass: "repository-conditional" },
  grok_document: { serialize: serializeDocument, readOnly: false, mutatesWorkspace: true, supportsParallel: false, supportsBackground: true, approvalClass: "workspace-write" },
  grok_sessions: { serialize: serializeSessions, readOnly: true, mutatesWorkspace: false, supportsParallel: true, supportsBackground: false, approvalClass: "session-read" },
  grok_image: { serialize: (input) => serializeMedia("image", input), readOnly: false, mutatesWorkspace: true, supportsParallel: false, supportsBackground: true, approvalClass: "media-write" },
  grok_video: { serialize: (input) => serializeMedia("video", input), readOnly: false, mutatesWorkspace: true, supportsParallel: false, supportsBackground: true, approvalClass: "media-write" },
  grok_status: { serialize: serializeStatus, readOnly: true, mutatesWorkspace: false, supportsParallel: true, supportsBackground: false, approvalClass: "job-read" },
  grok_result: { serialize: (input) => serializeJobLookup("result", input), readOnly: true, mutatesWorkspace: false, supportsParallel: true, supportsBackground: false, approvalClass: "job-read" },
  grok_cancel: { serialize: (input) => serializeJobLookup("cancel", input), readOnly: true, mutatesWorkspace: false, supportsParallel: true, supportsBackground: false, approvalClass: "job-control" },
  grok_transfer: { serialize: serializeTransfer, readOnly: true, mutatesWorkspace: false, supportsParallel: true, supportsBackground: false, approvalClass: "workspace-read" }
});

function capabilityValue(value, input) {
  return typeof value === "function" ? Boolean(value(input)) : Boolean(value);
}

export function validateToolManifest(definitions = TOOL_DEFINITIONS, runtime = TOOL_RUNTIME) {
  const names = new Set();
  const reserved = new Set(["initialize", "tools/list", "tools/call", "notifications/cancelled"]);
  const records = definitions.map((definition) => {
    if (!definition || typeof definition.name !== "string" || !/^grok_[a-z0-9_]+$/.test(definition.name)) {
      throw new Error(`Invalid Grok tool definition name: ${definition?.name}`);
    }
    if (names.has(definition.name) || reserved.has(definition.name)) {
      throw new Error(`Duplicate or reserved Grok tool name: ${definition.name}`);
    }
    names.add(definition.name);
    const behavior = runtime[definition.name];
    if (!behavior || typeof behavior.serialize !== "function") {
      throw new Error(`Grok tool ${definition.name} is missing a companion serializer.`);
    }
    for (const field of ["readOnly", "mutatesWorkspace", "supportsParallel", "supportsBackground"]) {
      if (!(field in behavior) || !["boolean", "function"].includes(typeof behavior[field])) {
        throw new Error(`Grok tool ${definition.name} is missing capability metadata: ${field}.`);
      }
    }
    if (!behavior.approvalClass || definition.inputSchema?.type !== "object" || definition.inputSchema?.additionalProperties !== false || !definition.inputSchema?.properties) {
      throw new Error(`Grok tool ${definition.name} has incomplete approval or input-schema metadata.`);
    }
    const defaultReadOnly = capabilityValue(behavior.readOnly, {});
    const normalizedDefinition = {
      ...definition,
      annotations: definition.annotations || {
        readOnlyHint: defaultReadOnly,
        destructiveHint: !defaultReadOnly,
        idempotentHint: defaultReadOnly,
        openWorldHint: false
      }
    };
    return Object.freeze({ definition: Object.freeze(normalizedDefinition), ...behavior });
  });
  const unknownRuntime = Object.keys(runtime).filter((name) => !names.has(name));
  if (unknownRuntime.length) throw new Error(`Runtime metadata exists for unknown Grok tools: ${unknownRuntime.join(", ")}`);
  return Object.freeze(records);
}

const TOOL_MANIFEST = validateToolManifest();
const TOOL_MAP = new Map(TOOL_MANIFEST.map((record) => [record.definition.name, record]));

function resolveToolRecord(toolName) {
  const record = TOOL_MAP.get(toolName);
  if (!record) throw new Error(`Unknown Grok tool: ${toolName}`);
  return record;
}

export function getToolCapabilities(toolName, input = {}) {
  const record = resolveToolRecord(toolName);
  return {
    readOnly: capabilityValue(record.readOnly, input),
    mutatesWorkspace: capabilityValue(record.mutatesWorkspace, input),
    supportsParallel: capabilityValue(record.supportsParallel, input),
    supportsBackground: capabilityValue(record.supportsBackground, input),
    approvalClass: record.approvalClass
  };
}

export function listToolManifest() {
  return TOOL_MANIFEST.map((record) => ({
    name: record.definition.name,
    ...getToolCapabilities(record.definition.name, {}),
    dynamicCapabilities: [record.readOnly, record.mutatesWorkspace, record.supportsParallel].some((value) => typeof value === "function")
  }));
}

export function listToolDefinitions() {
  return TOOL_MANIFEST.map((record) => ({ ...record.definition }));
}

export function buildCompanionInvocation(toolName, input = {}) {
  return resolveToolRecord(toolName).serialize(input);
}

export function buildPolicyCheckedCompanionInvocation(
  toolName,
  input = {},
  {
    cwd = resolveMcpCwd(input),
    activeWorkspace = input.activeWorkspace || null,
    writeCapable = getToolCapabilities(toolName, input).mutatesWorkspace,
    mcpRequestId = null,
    invocationId = null
  } = {}
) {
  const personalRead = toolName === "grok_personal_read";
  const shorthandPersonal = personalRead || toolName === "grok_rescue" &&
    (input.personalMode === "on" || input.personalMode === "once");
  if (shorthandPersonal && !hasValue(activeWorkspace)) {
    throw new Error("Personal delegation requires activeWorkspace from the current Codex environment_context.cwd.");
  }
  const invocationInput = {
    ...input,
    cwd,
    activeWorkspace,
    ...(shorthandPersonal ? {
      dataPolicy: input.dataPolicy ?? "personal-sanitized",
      sourceDisclosureConsent: input.sourceDisclosureConsent ?? true,
      model: input.model ?? "grok-4.6",
      effort: input.effort ?? "high"
    } : {}),
    ...(personalRead ? {
      readOnly: true,
      dataPolicy: "personal-sanitized",
      sourceDisclosureConsent: true,
      personalMode: "once",
      fresh: true,
      noMemory: true,
      noSubagents: true,
      disableWebSearch: true,
      sandbox: "read-only",
      permissionMode: "dontAsk",
      background: false
    } : {}),
    planMode: input.planMode === true || toolName === "grok_plan"
  };
  const normalizedPolicy = normalizeWorkerPolicy(invocationInput, { toolName, writeCapable });
  const invocation = createInvocationEnvelope({
    invocationId,
    mcpRequestId,
    tool: toolName,
    model: invocationInput.model || null,
    effort: invocationInput.effort || null,
    activeWorkspace,
    targetWorkspace: cwd,
    executionWorkspace: cwd,
    workspaceRoots: [activeWorkspace, cwd].filter(Boolean),
    policyFingerprint: normalizedPolicy.policyEvidence.fingerprint
  });
  return {
    ...buildCompanionInvocation(toolName, invocationInput),
    invocation,
    policyEvidence: normalizedPolicy.policyEvidence,
    workerPolicy: normalizedPolicy.workerPolicy
  };
}

export function runCompanion(toolName, input = {}, {
  cancelFile = null,
  onSpawn = null,
  mcpRequestId = null,
  invocationId = null
} = {}) {
  const cwd = resolveMcpCwd(input);
  const activeWorkspace = hasValue(input.activeWorkspace)
    ? resolveMcpCwd({ cwd: input.activeWorkspace })
    : null;
  const writeCapable = getToolCapabilities(toolName, input).mutatesWorkspace;
  const { args, invocation, policyEvidence } = buildPolicyCheckedCompanionInvocation(toolName, input, {
    cwd,
    activeWorkspace,
    writeCapable,
    mcpRequestId,
    invocationId
  });
  // Resolve again at call time so a partially removed cache fails with a
  // precise diagnostic instead of Node generic MODULE_NOT_FOUND output.
  const companion = resolveCompanionPath();

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [companion, ...args], {
      cwd,
      env: {
        ...buildWorkerEnv(process.env),
        ...(cancelFile ? { GROK_CANCEL_FILE: cancelFile } : {}),
        [INVOCATION_ENV]: JSON.stringify(invocation),
        [POLICY_EVIDENCE_ENV]: JSON.stringify(policyEvidence)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    onSpawn?.(child);

    const stdout = new HeadTailBuffer(MCP_CAPTURE_MAX_BYTES);
    const stderr = new HeadTailBuffer(MCP_CAPTURE_MAX_BYTES);
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
    });
    child.on("error", (error) => {
      finish({
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
      });
    });
    child.on("close", (code, signal) => {
      const stdoutText = stdout.toString();
      const stderrText = stderr.toString();
      const text = stdoutText || stderrText || `grok companion exited with code ${code ?? signal}`;
      finish({
        isError: code !== 0,
        content: [{ type: "text", text }],
        _meta: {
          outputStats: {
            stdout: stdout.stats(),
            stderr: stderr.stats()
          },
          processClosed: true,
          exitCode: code,
          signal,
          invocation
        }
      });
    });
  });
}

/**
 * Codex plugin MCP hosts speak newline-delimited JSON over stdio
 * (same framing as bundled plugins such as sites / codex-security).
 * Do not use LSP Content-Length framing — Codex never sends those headers,
 * so tools/list never completes and grok_* tools never appear in the session.
 */
function sendMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleRequest(message) {
  const id = message.id;
  try {
    switch (message.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: message.params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "grok-codex-worker", version: SERVER_VERSION }
          }
        };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: listToolDefinitions() } };
      case "tools/call": {
        const name = message.params?.name;
        const input = message.params?.arguments || {};
        const requestKey = String(id);
        const cancelFile = createRequestCancelFile(requestKey);
        const active = { cancelFile, child: null, requestedAt: null };
        activeRequests.set(requestKey, active);
        try {
          const result = await runCompanion(name, input, {
            cancelFile,
            mcpRequestId: id,
            onSpawn: (child) => { active.child = child; }
          });
          return { jsonrpc: "2.0", id, result };
        } finally {
          activeRequests.delete(requestKey);
          try { fs.rmSync(cancelFile, { force: true }); } catch {}
        }
      }
      case "notifications/initialized":
        return null;
      case "notifications/cancelled": {
        const requestKey = String(message.params?.requestId ?? message.params?.id ?? "");
        const active = activeRequests.get(requestKey);
        if (active && !active.requestedAt) {
          const marker = writeCancellationMarker(active.cancelFile, requestKey);
          active.requestedAt = marker.requestedAt;
        }
        return null;
      }
      default:
        if (id === undefined || id === null) {
          return null;
        }
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown method: ${message.method}` }
        };
    }
  } catch (error) {
    if (id === undefined || id === null) {
      return null;
    }
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function startStdioServer() {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  lines.on("line", (line) => {
    if (line.trim().length === 0) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.method === undefined && message.id !== undefined) {
      return;
    }

    void handleRequest(message).then((response) => {
      if (response) {
        sendMessage(response);
      }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startStdioServer();
}
