import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const DATA_POLICIES = Object.freeze(["strict", "personal-sanitized"]);
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|auth\.json|credentials?(?:\..*)?|secrets?(?:\..*)?|passwords?(?:\..*)?|tokens?(?:\..*)?|.*\.(?:pem|key|p12|pfx|der|asc)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const EXCLUDED_DIR = new Set([
  ".git", ".codex", ".grok", ".grok-snapshots", ".ssh", ".aws", ".azure", ".kube",
  "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  ".cache", ".next", ".nuxt", ".output", ".parcel-cache", ".turbo", ".gradle",
  "coverage", "dist", "build", "out", "target"
]);
const DEFAULT_MAX_DISCLOSURE_FILE_BYTES = 10 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".csv", ".go", ".h", ".hpp", ".html", ".ini",
  ".java", ".js", ".json", ".jsx", ".md", ".mjs", ".php", ".ps1", ".py", ".rb", ".rs",
  ".sh", ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml"
]);

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hashFile(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function safeRelative(root, value) {
  const resolved = path.resolve(root, String(value || "."));
  if (!isWithin(root, resolved)) throw new Error(`Disclosure path escapes workspace: ${value}`);
  return path.relative(root, resolved);
}

function isSensitiveName(name) {
  return SENSITIVE_FILE.test(String(name));
}

function isTextBuffer(buffer, filePath) {
  if (buffer.includes(0)) return false;
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || ext === "";
}

function redactMatch(kind, index) {
  return `[REDACTED_${kind}_${index}]`;
}

/**
 * Replace high-confidence credential material while preserving source shape.
 * The returned count is evidence only; it is never used as proof that a file
 * contains no other sensitive data.
 */
export function redactText(input) {
  let text = String(input ?? "");
  let count = 0;
  const byKind = new Map();
  const replacement = (kind) => {
    const next = (byKind.get(kind) || 0) + 1;
    byKind.set(kind, next);
    count += 1;
    return redactMatch(kind, next);
  };

  text = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, () => replacement("PRIVATE_KEY"));
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, (value) => `Bearer ${replacement("TOKEN")}`);
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,}|gh[po]_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{12,})\b/g, () => replacement("API_KEY"));
  text = text.replace(/([?&\s]|^)(password|passwd|pwd|api[_-]?key|cd[_-]?key|license[_-]?key|product[_-]?key|client[_-]?secret|secret|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key)(\s*[=:]\s*)(["']?)([^\s"'&,;}]+)\4/gi,
    (match, prefix, key, separator, quote, value) => `${prefix}${key}${separator}${quote}${replacement(/password|passwd|pwd/i.test(key) ? "PASSWORD" : /private/i.test(key) ? "PRIVATE_KEY" : /key|secret/i.test(key) ? "API_KEY" : "TOKEN")}${quote}`);
  text = text.replace(/([,{]\s*)(["'])(password|passwd|pwd|api[_-]?key|cd[_-]?key|license[_-]?key|product[_-]?key|client[_-]?secret|secret|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key)\2(\s*:\s*)(["'])([^"']+)\5/gi,
    (match, prefix, quote, key, separator, valueQuote) => `${prefix}${quote}${key}${quote}${separator}${valueQuote}${replacement(/password|passwd|pwd/i.test(key) ? "PASSWORD" : /private/i.test(key) ? "PRIVATE_KEY" : /key|secret/i.test(key) ? "API_KEY" : "TOKEN")}${valueQuote}`);
  text = text.replace(/<(password|passwd|pwd|api[_-]?key|cd[_-]?key|client[_-]?secret|secret|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key)>[^<]+<\/\1>/gi,
    (match, key) => `<${key}>${replacement(/password|passwd|pwd/i.test(key) ? "PASSWORD" : /private/i.test(key) ? "PRIVATE_KEY" : /key|secret/i.test(key) ? "API_KEY" : "TOKEN")}</${key}>`);
  text = text.replace(/(postgres(?:ql)?|mysql|mssql|mongodb(?:\+srv)?):\/\/([^\s:@/]+):([^\s@/]+)@/gi,
    (match, scheme, user, password) => `${scheme}://${user}:${replacement("PASSWORD")}@`);
  text = text.replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g, () => replacement("JWT"));

  return { text, count, changed: count > 0 };
}

function shouldExclude(relativePath, entryName, { excludePaths = [] } = {}) {
  const parts = relativePath ? relativePath.split(/[\\/]/) : [];
  if (parts.some((part) => EXCLUDED_DIR.has(part.toLowerCase()))) return { excluded: true, reason: "protected-directory" };
  if (isSensitiveName(entryName)) return { excluded: true, reason: "credential-file" };
  for (const value of excludePaths) {
    const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
    if (relativePath.replaceAll("\\", "/") === normalized || relativePath.replaceAll("\\", "/").startsWith(`${normalized}/`)) {
      return { excluded: true, reason: "user-excluded" };
    }
  }
  return { excluded: false, reason: null };
}

function copyEntry(sourceRoot, stageRoot, relativePath, manifest, options) {
  const source = path.resolve(sourceRoot, relativePath);
  const target = path.resolve(stageRoot, relativePath);
  if (!isWithin(sourceRoot, source) || !isWithin(stageRoot, target)) throw new Error(`Invalid disclosure path: ${relativePath}`);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    manifest.excluded.push({ path: relativePath, reason: "symlink" });
    return;
  }
  if (stat.isDirectory()) {
    const decision = shouldExclude(relativePath, path.basename(relativePath), options);
    if (decision.excluded) {
      manifest.excluded.push({ path: relativePath, reason: decision.reason });
      return;
    }
    for (const name of fs.readdirSync(source)) copyEntry(sourceRoot, stageRoot, path.join(relativePath, name), manifest, options);
    return;
  }
  if (!stat.isFile()) return;
  const decision = shouldExclude(relativePath, path.basename(relativePath), options);
  if (decision.excluded) {
    manifest.excluded.push({ path: relativePath, reason: decision.reason });
    return;
  }
  if (stat.size > options.maxFileBytes) {
    manifest.excluded.push({ path: relativePath, reason: "max-file-size", size: stat.size });
    return;
  }
  const buffer = fs.readFileSync(source);
  if (!isTextBuffer(buffer, source)) {
    manifest.excluded.push({ path: relativePath, reason: "binary-file" });
    return;
  }
  const originalHash = hashBuffer(buffer);
  const redacted = redactText(buffer.toString("utf8"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, redacted.text, "utf8");
  manifest.files.push({
    path: relativePath,
    originalHash,
    stagedHash: hashFile(target),
    redactions: redacted.count,
    writeBackAllowed: redacted.count === 0
  });
}

export function normalizeDataPolicy(value, { consent = false, scopedConsent = false } = {}) {
  const policy = String(value || "strict").trim().toLowerCase();
  if (!DATA_POLICIES.includes(policy)) throw new Error(`Unsupported data policy '${value}'. Use strict or personal-sanitized.`);
  if (policy === "personal-sanitized" && consent !== true && scopedConsent !== true) {
    throw new Error("personal-sanitized data disclosure requires explicit sourceDisclosureConsent=true.");
  }
  return policy;
}

export const PERSONAL_MODES = Object.freeze(["on", "once"]);

function canonicalProjectPath(value) {
  const resolved = path.resolve(String(value || "."));
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function sameProjectPath(left, right) {
  const a = canonicalProjectPath(left);
  const b = canonicalProjectPath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function normalizePersonalMode(value) {
  if (value == null || value === "") return "on";
  const mode = String(value).trim().toLowerCase();
  if (!PERSONAL_MODES.includes(mode)) {
    throw new Error(`Unsupported personal mode '${value}'. Use on or once.`);
  }
  return mode;
}

/**
 * Keep external-project disclosure task-local. The MCP host supplies the
 * active workspace; a different cwd is external and requires once plus an
 * exact authorizedProject path. The companion can reuse this check for direct
 * callers, where cwd is the only known active workspace.
 */
export function validatePersonalProjectScope({
  dataPolicy = "strict",
  personalMode,
  authorizedProject,
  cwd = process.cwd(),
  activeWorkspace = process.cwd()
} = {}) {
  const policy = String(dataPolicy || "strict").trim().toLowerCase();
  if (policy !== "personal-sanitized") {
    return { mode: null, externalProject: false, authorizedProject: null, activeWorkspace: null };
  }

  const mode = normalizePersonalMode(personalMode);
  const target = canonicalProjectPath(cwd);
  const active = canonicalProjectPath(activeWorkspace);
  const externalProject = !sameProjectPath(target, active);
  const authorized = authorizedProject == null || authorizedProject === ""
    ? null
    : canonicalProjectPath(authorizedProject);

  if (externalProject) {
    if (mode !== "once") {
      throw new Error("External project Personal delegation requires personalMode=once.");
    }
    if (!authorized) {
      throw new Error("External project Personal delegation requires authorizedProject matching cwd.");
    }
    if (!sameProjectPath(authorized, target)) {
      throw new Error("authorizedProject must exactly match the requested project cwd.");
    }
  } else if (authorized) {
    throw new Error("authorizedProject is only valid for a project outside the active Codex workspace.");
  }

  return {
    mode,
    externalProject,
    authorizedProject: authorized,
    activeWorkspace: active
  };
}

export function createDisclosureStage(cwd, {
  jobId,
  dataPolicy = "strict",
  consent = false,
  includePaths = [],
  excludePaths = [],
  maxFileBytes = DEFAULT_MAX_DISCLOSURE_FILE_BYTES
} = {}) {
  const policy = normalizeDataPolicy(dataPolicy, { consent });
  if (policy === "strict") return null;
  const sourceRoot = path.resolve(cwd);
  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), "grok-personal-"));
  const stageRoot = path.join(stageParent, "workspace");
  fs.mkdirSync(stageRoot, { recursive: true });
  const manifest = {
    version: 1,
    jobId: String(jobId || "unknown"),
    policy,
    sourceRoot,
    stageRoot,
    createdAt: new Date().toISOString(),
    maxFileBytes,
    files: [],
    excluded: [],
    redactionCount: 0
  };
  const roots = includePaths.length ? includePaths.map((value) => safeRelative(sourceRoot, value)) : [""];
  try {
    for (const relative of roots) {
      const candidate = path.resolve(sourceRoot, relative);
      if (!fs.existsSync(candidate)) throw new Error(`Disclosure include path does not exist: ${relative || "."}`);
      copyEntry(sourceRoot, stageRoot, relative, manifest, { excludePaths, maxFileBytes });
    }
    manifest.redactionCount = manifest.files.reduce((sum, item) => sum + item.redactions, 0);
    fs.writeFileSync(path.join(stageParent, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { ...manifest, stageParent, manifestPath: path.join(stageParent, "manifest.json") };
  } catch (error) {
    cleanupDisclosureStage({ stageParent });
    throw error;
  }
}

function scanForWriteBack(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (!isTextBuffer(buffer, filePath)) return { ok: false, reason: "binary-file" };
  const text = buffer.toString("utf8");
  if (/\[REDACTED_[A-Z0-9_]+_\d+\]/.test(text)) return { ok: false, reason: "redaction-placeholder" };
  const redacted = redactText(text);
  return redacted.count ? { ok: false, reason: "credential-pattern", count: redacted.count } : { ok: true };
}

export function applyDisclosureStage(cwd, stage, { write = false, allowedChangedFiles = [] } = {}) {
  if (!stage) return { ok: true, applied: [], blocked: [], changed: [] };
  if (!write) return { ok: true, applied: [], blocked: [], changed: [] };
  const sourceRoot = path.resolve(cwd);
  const stageRoot = path.resolve(stage.stageRoot);
  const applied = [];
  const blocked = [];
  const changed = [];
  const planned = [];
  const known = new Set(stage.files.map((item) => item.path.replaceAll("\\", "/")));
  const allowed = new Set(allowedChangedFiles.map((item) => {
    const absolute = path.resolve(sourceRoot, item);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  }));
  const allowedTarget = (target) => !allowed.size || allowed.has(process.platform === "win32" ? path.resolve(target).toLowerCase() : path.resolve(target));
  for (const item of stage.files) {
    const relative = item.path;
    const source = path.resolve(sourceRoot, relative);
    const staged = path.resolve(stageRoot, relative);
    if (!isWithin(sourceRoot, source) || !isWithin(stageRoot, staged)) {
      blocked.push({ path: relative, reason: "path-escape" });
      continue;
    }
    const exists = fs.existsSync(staged);
    const originalExists = fs.existsSync(source);
    if (!allowedTarget(source) && (!exists || hashFile(staged) !== item.stagedHash)) {
      blocked.push({ path: relative, reason: "outside-allowed-changed-files" });
      continue;
    }
    if (!exists) {
      if (item.writeBackAllowed && originalExists) {
        changed.push(relative);
        planned.push({ path: relative, action: "delete", target: source });
      } else if (!item.writeBackAllowed) {
        blocked.push({ path: relative, reason: "original-file-contained-redactions" });
      }
      continue;
    }
    const currentHash = hashFile(staged);
    if (currentHash === item.stagedHash) continue;
    if (!item.writeBackAllowed) {
      blocked.push({ path: relative, reason: "original-file-contained-redactions" });
      continue;
    }
    const scan = scanForWriteBack(staged);
    if (!scan.ok) {
      blocked.push({ path: relative, reason: scan.reason });
      continue;
    }
    changed.push(relative);
    planned.push({ path: relative, action: originalExists ? "modify" : "add", source: staged, target: source });
  }
  // Files created by Grok in the staging workspace are eligible only after a
  // second scan; excluded source files are never inferred as deletions.
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(stageRoot, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) { visit(absolute); continue; }
      if (!entry.isFile() || known.has(relative)) continue;
      const decision = shouldExclude(relative, entry.name);
      if (decision.excluded) { blocked.push({ path: relative, reason: decision.reason }); continue; }
      const scan = scanForWriteBack(absolute);
      if (!scan.ok) { blocked.push({ path: relative, reason: scan.reason }); continue; }
      const target = path.resolve(sourceRoot, relative);
      if (!isWithin(sourceRoot, target)) { blocked.push({ path: relative, reason: "path-escape" }); continue; }
      if (!allowedTarget(target)) { blocked.push({ path: relative, reason: "outside-allowed-changed-files" }); continue; }
      changed.push(relative);
      planned.push({ path: relative, action: fs.existsSync(target) ? "modify" : "add", source: absolute, target });
    }
  };
  visit(stageRoot);
  if (blocked.length) {
    return { ok: false, applied: [], blocked, changed: [], message: `Disclosure write-back blocked: ${blocked.map((item) => `${item.path} (${item.reason})`).join(", ")}` };
  }
  for (const operation of planned) {
    if (operation.action === "delete") {
      fs.rmSync(operation.target, { force: true });
    } else {
      fs.mkdirSync(path.dirname(operation.target), { recursive: true });
      fs.copyFileSync(operation.source, operation.target);
    }
    applied.push({ path: operation.path, action: operation.action });
  }
  return { ok: true, applied, blocked: [], changed, message: null };
}

export function cleanupDisclosureStage(stage) {
  if (!stage?.stageParent) return;
  try { fs.rmSync(stage.stageParent, { recursive: true, force: true }); } catch {}
}
