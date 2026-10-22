"use strict";

// Persistent app configuration. Stored outside the workspace so that switching
// the working folder never loses the LM Studio endpoint or the model choice.

const fs = require("fs");
const path = require("path");
const os = require("os");
const permissions = require("./permissions");

const APP_DIR_NAME = "oh-my-qwen";

// "default" plus every level LM Studio's reasoning_effort accepts.
const REASONING_EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh"];

// House rules handed to the model on every turn. These exist because local
// models keep making the same mistakes in local workspaces: tests that leave
// state behind, unchecked failures, and changes reported without verification.
// Editable in settings; "기본값 복원" puts this text back.
const DEFAULT_CODING_RULES = [
  "Tests must be self-contained: create whatever state they need, and delete every file, directory or database they wrote before they finish, including when they fail. A test that leaves data behind makes the next run fail for the wrong reason.",
  "For C or C++ test programs, print what was expected and what happened, then return a non-zero exit code so failures remain useful in non-interactive CI and terminal sessions.",
  "Check a return value before using it, and free or close what you allocate or open, including on the failure path.",
  "When you change code, build it and run the tests before saying it works."
].join("\n");

// Defaults target the Qwen3.8 class (27B, 262k native context): Qwen's own
// thinking-mode sampling (temperature 0.6, top_p 0.95, top_k 20, presence 0)
// and budgets the 4k/24k values of previous local models made far too small.
const DEFAULTS =
{
  baseUrl: "http://localhost:1234",
  model: "",
  workspace: "",
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  presencePenalty: 0.0,
  // "default" sends nothing and leaves the model's own setting in place. The
  // other values go to LM Studio as reasoning_effort; "none" is the one that
  // switches thinking off on an on/off model such as Qwen3.8.
  reasoningEffort: "default",
  maxTokens: 8192,
  contextTokens: 65536,
  maxToolRounds: 32,
  idleTimeoutSec: 90,
  firstByteTimeoutSec: 300,
  // ask | edits | auto | full, see src/permissions.js.
  permissionMode: "ask",
  showThinking: true,
  codingRules: DEFAULT_CODING_RULES,
  systemPrompt: "",
  // Tavily API key for web_search / web_fetch. Empty means the web tools are
  // not offered to the model at all.
  tavilyApiKey: "",
  recentWorkspaces: []
};

// Portable builds keep settings and chat history next to the executable so a
// USB copy carries its own state. Anchors, in order of precedence:
//   1. OMQ_DATA_DIR environment variable
//   2. a "portable.txt" marker or an existing "data" folder beside the app
//   3. $XDG_CONFIG_HOME/oh-my-qwen or ~/.config/oh-my-qwen (normal install)
const PORTABLE_MARKER = "portable.txt";
const PORTABLE_DATA = "data";

function anchorDirs()
{
  const list = [];

  const sea = (function ()
  {
    try
    {
      const mod = require("node:sea");
      return (mod && typeof mod.isSea === "function" && mod.isSea());
    }
    catch (err)
    {
      return false;
    }
  })();

  if (sea)
  {
    list.push(path.dirname(process.execPath));
  }

  const entry = process.argv[1];
  if (entry)
  {
    const dir = path.dirname(path.resolve(entry));
    list.push(dir);
    // The portable folder layout runs app\oh-my-qwen.js, so check the parent too.
    list.push(path.dirname(dir));
  }

  const seen = new Set();
  return list.filter(function (p)
  {
    const key = process.platform === "win32" ? p.toLowerCase() : p;
    if (seen.has(key))
    {
      return false;
    }
    seen.add(key);
    return true;
  });
}

let cachedDir = null;

function appDir()
{
  if (cachedDir)
  {
    return cachedDir;
  }

  if (process.env.OMQ_DATA_DIR && process.env.OMQ_DATA_DIR.trim())
  {
    cachedDir = path.resolve(process.env.OMQ_DATA_DIR.trim());
    return cachedDir;
  }

  const anchors = anchorDirs();
  for (let i = 0; i < anchors.length; i++)
  {
    const marker = path.join(anchors[i], PORTABLE_MARKER);
    const data = path.join(anchors[i], PORTABLE_DATA);
    let portable = false;

    try
    {
      portable = fs.existsSync(marker) || fs.existsSync(data);
    }
    catch (err)
    {
      portable = false;
    }

    if (portable)
    {
      cachedDir = data;
      return cachedDir;
    }
  }

  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  cachedDir = path.join(base, APP_DIR_NAME);
  return cachedDir;
}

function isPortable()
{
  const dir = appDir();
  return path.basename(dir).toLowerCase() === PORTABLE_DATA;
}

function configPath()
{
  return path.join(appDir(), "config.json");
}

function ensureDir()
{
  const dir = appDir();
  if (!fs.existsSync(dir))
  {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitize(raw)
{
  const out = Object.assign({}, DEFAULTS);
  if (!raw || typeof raw !== "object")
  {
    return out;
  }

  if (typeof raw.baseUrl === "string" && raw.baseUrl.trim())
  {
    out.baseUrl = raw.baseUrl.trim().replace(/\/+$/, "");
  }
  if (typeof raw.model === "string")
  {
    out.model = raw.model;
  }
  if (typeof raw.workspace === "string")
  {
    out.workspace = raw.workspace;
  }
  if (Number.isFinite(raw.temperature))
  {
    out.temperature = Math.min(2, Math.max(0, raw.temperature));
  }
  if (Number.isFinite(raw.topP))
  {
    out.topP = Math.min(1, Math.max(0.01, raw.topP));
  }
  if (Number.isFinite(raw.topK))
  {
    out.topK = Math.min(200, Math.max(0, Math.round(raw.topK)));
  }
  if (Number.isFinite(raw.presencePenalty))
  {
    out.presencePenalty = Math.min(2, Math.max(-2, raw.presencePenalty));
  }
  if (typeof raw.reasoningEffort === "string" &&
    REASONING_EFFORTS.indexOf(raw.reasoningEffort) >= 0)
  {
    out.reasoningEffort = raw.reasoningEffort;
  }
  if (Number.isFinite(raw.maxTokens))
  {
    out.maxTokens = Math.min(32768, Math.max(256, Math.round(raw.maxTokens)));
  }
  if (Number.isFinite(raw.contextTokens))
  {
    // The cap follows the widest native window this app is expected to front
    // (Qwen3.8 262k); nothing here limits how much LM Studio actually loads.
    out.contextTokens = Math.min(262144, Math.max(4000, Math.round(raw.contextTokens)));
  }
  if (Number.isFinite(raw.maxToolRounds))
  {
    out.maxToolRounds = Math.min(100, Math.max(1, Math.round(raw.maxToolRounds)));
  }
  if (Number.isFinite(raw.idleTimeoutSec))
  {
    out.idleTimeoutSec = Math.min(3600, Math.max(10, Math.round(raw.idleTimeoutSec)));
  }
  if (Number.isFinite(raw.firstByteTimeoutSec))
  {
    out.firstByteTimeoutSec = Math.min(3600, Math.max(10, Math.round(raw.firstByteTimeoutSec)));
  }
  if (typeof raw.codingRules === "string")
  {
    // An empty string is a deliberate "no rules", not a missing value.
    out.codingRules = raw.codingRules.slice(0, 8000);
  }
  if (typeof raw.systemPrompt === "string")
  {
    out.systemPrompt = raw.systemPrompt.slice(0, 8000);
  }
  if (typeof raw.tavilyApiKey === "string")
  {
    out.tavilyApiKey = raw.tavilyApiKey.trim().slice(0, 200);
  }
  // Before modes there was only autoApprove, which meant what "auto" means now.
  out.permissionMode = permissions.modeOf(raw);
  if (typeof raw.showThinking === "boolean")
  {
    out.showThinking = raw.showThinking;
  }
  if (Array.isArray(raw.recentWorkspaces))
  {
    out.recentWorkspaces = raw.recentWorkspaces
      .filter(function (p) { return typeof p === "string" && p.trim(); })
      .slice(0, 10);
  }
  return out;
}

let cache = null;

function load()
{
  if (cache)
  {
    return cache;
  }

  let raw = null;
  try
  {
    const text = fs.readFileSync(configPath(), "utf8");
    raw = JSON.parse(text);
  }
  catch (err)
  {
    raw = null;
  }

  cache = sanitize(raw);
  return cache;
}

function save(patch)
{
  const merged = sanitize(Object.assign({}, load(), patch || {}));
  cache = merged;
  try
  {
    ensureDir();
    // The file holds an API key now, so only the owner may read it. mode only
    // applies when the file is created; chmod covers one that already exists.
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600 });
    try
    {
      fs.chmodSync(configPath(), 0o600);
    }
    catch (err)
    {
      // a filesystem without POSIX modes
    }
  }
  catch (err)
  {
    console.error("[config] save failed:", err.message);
  }
  return merged;
}

function pushRecentWorkspace(dir)
{
  const cfg = load();
  const list = cfg.recentWorkspaces.filter(function (p)
  {
    const previous = path.normalize(p);
    const next = path.normalize(dir);
    return process.platform === "win32"
      ? previous.toLowerCase() !== next.toLowerCase()
      : previous !== next;
  });
  list.unshift(dir);
  return save({ recentWorkspaces: list.slice(0, 10) });
}

module.exports =
{
  DEFAULTS: DEFAULTS,
  DEFAULT_CODING_RULES: DEFAULT_CODING_RULES,
  REASONING_EFFORTS: REASONING_EFFORTS,
  appDir: appDir,
  isPortable: isPortable,
  configPath: configPath,
  load: load,
  save: save,
  pushRecentWorkspace: pushRecentWorkspace
};
