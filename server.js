"use strict";

// oh-my-qwen local server.
// Serves the chat UI, brokers LM Studio requests, and runs workspace tools.
// Binds to 127.0.0.1 only: this process can write files and run commands.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const config = require("./src/config");
const logger = require("./src/logger");
const tools = require("./src/tools");
const lmstudio = require("./src/lmstudio");
const sessionStore = require("./src/session");
const agent = require("./src/agent");
const picker = require("./src/picker");
const assets = require("./src/assets");
const websearch = require("./src/websearch");
const permissions = require("./src/permissions");

// In a single-file build the UI is embedded, so this path is only a fallback.
const PUBLIC_DIR = path.join(__dirname, "public");
const HOST = "127.0.0.1";

const MIME =
{
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2"
};

const clients = new Set();

function parseArgs(argv)
{
  const out = { port: 8787, open: true };
  for (let i = 2; i < argv.length; i++)
  {
    const a = argv[i];
    if ((a === "--port" || a === "-p") && argv[i + 1])
    {
      out.port = parseInt(argv[i + 1], 10) || out.port;
      i++;
    }
    else if (a === "--no-open")
    {
      out.open = false;
    }
  }
  return out;
}

// Live events used to carry no room identity, so a turn still running in the
// previous folder rendered into whatever room the user had switched to - down
// to its approval cards. Every event now names the room it belongs to.
function broadcast(event, data, workspace)
{
  const body = (data === undefined || data === null) ? {} : data;
  if (workspace && typeof body === "object" && body.workspace === undefined)
  {
    body.workspace = workspace;
  }
  const payload = "event: " + event + "\ndata: " + JSON.stringify(body) + "\n\n";
  const dead = [];

  clients.forEach(function (res)
  {
    try
    {
      res.write(payload);
    }
    catch (err)
    {
      dead.push(res);
    }
  });

  for (let i = 0; i < dead.length; i++)
  {
    clients.delete(dead[i]);
  }
}

function sendJson(res, code, obj)
{
  const body = JSON.stringify(obj);
  res.writeHead(code,
  {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req, limitBytes)
{
  return new Promise(function (resolve, reject)
  {
    let size = 0;
    let over = false;
    const chunks = [];

    req.on("data", function (chunk)
    {
      if (over)
      {
        // Still arriving, no longer kept. Memory stays bounded and the socket
        // stays alive long enough to answer.
        return;
      }

      size += chunk.length;
      if (size > (limitBytes || 4 * 1024 * 1024))
      {
        over = true;
        // Say which side was at fault, and do not tear the socket down first:
        // destroying it here meant the caller got a connection reset instead of
        // a reason, so a request that was merely too big looked like a crash.
        const tooBig = new Error("request body too large");
        tooBig.status = 413;
        reject(tooBig);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function ()
    {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text)
      {
        resolve({});
        return;
      }
      try
      {
        resolve(JSON.parse(text));
      }
      catch (err)
      {
        // The caller sent something malformed. Answering 500 says the server
        // broke, which points anyone debugging at the wrong side of the wire.
        const bad = new Error("invalid JSON body");
        bad.status = 400;
        reject(bad);
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(req, res, urlPath)
{
  const rel = assets.normalizeRequest(urlPath);
  if (rel === null)
  {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }

  const data = await assets.read(urlPath, PUBLIC_DIR);
  if (!data)
  {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }

  res.writeHead(200,
  {
    "Content-Type": MIME[path.extname(rel).toLowerCase()] || "application/octet-stream",
    "Content-Length": data.length,
    "Cache-Control": "no-store"
  });
  res.end(data);
}

function publicConfig()
{
  const cfg = config.load();
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    workspace: cfg.workspace,
    temperature: cfg.temperature,
    topP: cfg.topP,
    topK: cfg.topK,
    presencePenalty: cfg.presencePenalty,
    reasoningEffort: cfg.reasoningEffort,
    maxTokens: cfg.maxTokens,
    contextTokens: cfg.contextTokens,
    maxToolRounds: cfg.maxToolRounds,
    idleTimeoutSec: cfg.idleTimeoutSec,
    firstByteTimeoutSec: cfg.firstByteTimeoutSec,
    permissionMode: cfg.permissionMode,
    showThinking: cfg.showThinking,
    codingRules: cfg.codingRules,
    // What the tool schema costs on every request. The settings screen adds it
    // to the budget check, which used to compare only the conversation budget
    // and the reply against the model's context and so showed a comfortable
    // green while the real request was thousands of tokens over.
    schemaTokens: agent.toolSchemaTokens(cfg),
    // The key itself never leaves the server: the page only learns whether one
    // is set and a hint to recognise it by.
    webSearch: { configured: !!cfg.tavilyApiKey, keyHint: websearch.keyHint(cfg.tavilyApiKey) },
    defaultCodingRules: config.DEFAULT_CODING_RULES,
    systemPrompt: cfg.systemPrompt,
    recentWorkspaces: cfg.recentWorkspaces,
    dataDir: config.appDir(),
    portable: config.isPortable(),
    logPath: logger.logPath()
  };
}

function workspaceInfo()
{
  const cfg = config.load();
  if (!cfg.workspace)
  {
    return { path: "", name: "", valid: false };
  }

  let valid = false;
  try
  {
    valid = fs.statSync(cfg.workspace).isDirectory();
  }
  catch (err)
  {
    valid = false;
  }

  // Carried on every state read, not just on registration: a risky folder stays
  // risky after a reload and the warning has to survive with it.
  const risk = valid ? tools.workspaceRisk(cfg.workspace) : null;

  return {
    path: cfg.workspace,
    name: path.basename(cfg.workspace) || cfg.workspace,
    valid: valid,
    risk: risk
  };
}

function currentSession()
{
  return sessionStore.get(config.load().workspace);
}

// Switching to a more permissive mode while a card is waiting should not leave
// the turn stuck on a question the new mode would never have asked.
function releaseApprovals(mode)
{
  const session = currentSession();
  const ids = Array.from(session.pending.keys());
  for (let i = 0; i < ids.length; i++)
  {
    const entry = session.pending.get(ids[i]);
    const info = entry && entry.info;
    if (!info || permissions.needsApproval(mode, info.name, info))
    {
      continue;
    }
    entry.resolve({ approved: true });
    broadcast("approval_resolved", { id: info.id, approved: true, reason: "mode" }, session.workspace);
  }
}

async function handleApi(req, res, url)
{
  const route = url.pathname;

  if (route === "/api/state" && req.method === "GET")
  {
    const session = currentSession();
    sendJson(res, 200,
    {
      config: publicConfig(),
      workspace: workspaceInfo(),
      transcript: session.transcript,
      busy: session.busy,
      pendingApprovals: Array.from(session.pending.values()).map(function (entry)
      {
        return entry && entry.info ? entry.info : null;
      }).filter(Boolean)
    });
    return;
  }

  if (route === "/api/models" && req.method === "GET")
  {
    const baseUrl = url.searchParams.get("baseUrl") || config.load().baseUrl;
    try
    {
      const result = await lmstudio.listModels(baseUrl);
      sendJson(res, 200, { ok: true, baseUrl: result.baseUrl, detailed: result.detailed, models: result.models });
    }
    catch (err)
    {
      sendJson(res, 200, { ok: false, error: err.message, models: [] });
    }
    return;
  }

  if (route === "/api/config" && req.method === "POST")
  {
    const body = await readBody(req);
    const patch = {};

    // A missing or non-numeric value has to mean "leave it unchanged". JSON has
    // no NaN, and JSON.stringify renders NaN as null, so Number(null) === 0
    // would silently rewrite a cleared field to the bottom of its clamp range.
    function numericField(field)
    {
      const value = body[field];
      if (value === undefined || value === null)
      {
        return null;
      }
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    function applyNumber(field)
    {
      const n = numericField(field);
      if (n !== null)
      {
        patch[field] = n;
      }
    }

    if (typeof body.baseUrl === "string")
    {
      patch.baseUrl = lmstudio.normalizeBase(body.baseUrl);
    }
    if (typeof body.model === "string")
    {
      patch.model = body.model;
    }

    applyNumber("temperature");
    applyNumber("topP");
    applyNumber("topK");
    applyNumber("presencePenalty");
    applyNumber("maxTokens");
    applyNumber("contextTokens");
    applyNumber("maxToolRounds");
    applyNumber("idleTimeoutSec");
    applyNumber("firstByteTimeoutSec");

    // An unknown value means "leave it unchanged", the same rule as the
    // numeric fields; letting it through made sanitize() reset it to default.
    if (typeof body.reasoningEffort === "string" && config.REASONING_EFFORTS.indexOf(body.reasoningEffort) >= 0)
    {
      patch.reasoningEffort = body.reasoningEffort;
    }
    // An unknown mode leaves the setting alone. autoApprove is the old name
    // and still maps onto the modes it meant.
    if (permissions.isMode(body.permissionMode))
    {
      patch.permissionMode = body.permissionMode;
    }
    else if (typeof body.autoApprove === "boolean" && body.permissionMode === undefined)
    {
      patch.permissionMode = body.autoApprove ? "auto" : "ask";
    }
    if (typeof body.showThinking === "boolean")
    {
      patch.showThinking = body.showThinking;
    }
    if (typeof body.codingRules === "string")
    {
      patch.codingRules = body.codingRules;
    }
    if (typeof body.systemPrompt === "string")
    {
      patch.systemPrompt = body.systemPrompt;
    }
    // An empty string clears the key; leaving the field out keeps it.
    if (typeof body.tavilyApiKey === "string")
    {
      patch.tavilyApiKey = body.tavilyApiKey;
    }

    const before = config.load().permissionMode;
    config.save(patch);
    if (config.load().permissionMode !== before)
    {
      releaseApprovals(config.load().permissionMode);
    }
    broadcast("config", publicConfig());
    sendJson(res, 200, { ok: true, config: publicConfig() });
    return;
  }

  if (route === "/api/workspace" && req.method === "POST")
  {
    const body = await readBody(req);
    const raw = String(body.path || "").trim().replace(/^["']|["']$/g, "");

    if (!raw)
    {
      sendJson(res, 400, { ok: false, error: "폴더 경로가 비어 있습니다." });
      return;
    }

    const resolved = path.resolve(raw);
    let stat = null;
    try
    {
      stat = fs.statSync(resolved);
    }
    catch (err)
    {
      sendJson(res, 400, { ok: false, error: "폴더를 찾을 수 없습니다: " + resolved });
      return;
    }
    if (!stat.isDirectory())
    {
      sendJson(res, 400, { ok: false, error: "폴더가 아닙니다: " + resolved });
      return;
    }

    const previous = currentSession();
    if (previous.busy)
    {
      previous.cancel("workspace changed");
    }
    await sessionStore.persist(previous);

    config.save({ workspace: resolved });
    config.pushRecentWorkspace(resolved);

    const session = sessionStore.get(resolved);
    broadcast("workspace", { workspace: workspaceInfo(), config: publicConfig(), transcript: session.transcript,
      busy: session.busy });
    sendJson(res, 200, { ok: true, workspace: workspaceInfo(), config: publicConfig(), transcript: session.transcript,
      busy: session.busy });
    return;
  }

  // Checks a key before it is relied on: the one typed into the form, or the
  // saved one when the form is empty. Costs one Tavily credit.
  if (route === "/api/websearch/test" && req.method === "POST")
  {
    const body = await readBody(req);
    const typed = typeof body.tavilyApiKey === "string" ? body.tavilyApiKey.trim() : "";
    const key = typed || config.load().tavilyApiKey;
    if (!key)
    {
      sendJson(res, 200, { ok: false, error: "Tavily API 키가 없습니다." });
      return;
    }
    const result = await websearch.verifyKey(key);
    sendJson(res, 200, result.ok
      ? { ok: true, keyHint: websearch.keyHint(key) }
      : { ok: false, error: result.error, status: result.status });
    return;
  }

  if (route === "/api/workspace/pick" && req.method === "POST")
  {
    const cfg = config.load();
    const result = await picker.pickFolder(cfg.workspace || process.cwd());
    sendJson(res, 200, result);
    return;
  }

  if (route === "/api/chat" && req.method === "POST")
  {
    const body = await readBody(req);
    const text = String(body.text || "").trim();

    if (!text)
    {
      sendJson(res, 400, { ok: false, error: "메시지가 비어 있습니다." });
      return;
    }

    const cfg = config.load();
    const session = sessionStore.get(cfg.workspace);

    if (session.busy)
    {
      sendJson(res, 409, { ok: false, error: "이미 응답을 생성하는 중입니다." });
      return;
    }

    sendJson(res, 202, { ok: true });

    agent.runTurn(
    {
      session: session,
      cfg: cfg,
      liveConfig: config.load,
      userText: text,
      emit: function (name, data)
      {
        broadcast(name, data, session.workspace);
      }
    }).catch(function (err)
    {
      // Scoped to the room like every other turn event, or a failure in one
      // folder's turn would show up in whatever room is open.
      broadcast("notice", { id: "err_" + Date.now(), kind: "notice", level: "error", text: "내부 오류: " + err.message },
        session.workspace);
      broadcast("turn_end", { stopReason: "error" }, session.workspace);
    });
    return;
  }

  if (route === "/api/approve" && req.method === "POST")
  {
    const body = await readBody(req);
    const session = currentSession();
    const entry = session.pending.get(String(body.id || ""));

    if (!entry)
    {
      sendJson(res, 404, { ok: false, error: "만료된 승인 요청입니다." });
      return;
    }

    entry.resolve({ approved: body.approved === true });
    broadcast("approval_resolved", { id: String(body.id), approved: body.approved === true },
      config.load().workspace);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (route === "/api/cancel" && req.method === "POST")
  {
    const session = currentSession();
    session.cancel("user cancelled");
    sendJson(res, 200, { ok: true });
    return;
  }

  // The exe has no console window to close, so this is the only orderly way to
  // stop the server. Same origin check as every other route, and localhost only.
  if (route === "/api/shutdown" && req.method === "POST")
  {
    sendJson(res, 200, { ok: true });
    shutdown("requested from the UI");
    return;
  }

  if (route === "/api/clear" && req.method === "POST")
  {
    const session = currentSession();
    session.reset();
    await sessionStore.persist(session);
    broadcast("cleared", {});
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "unknown endpoint: " + route });
}

function handleEvents(req, res)
{
  res.writeHead(200,
  {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 1500\n\n");
  res.write("event: hello\ndata: " + JSON.stringify({ ok: true }) + "\n\n");

  clients.add(res);

  const keepAlive = setInterval(function ()
  {
    try
    {
      res.write(": ping\n\n");
    }
    catch (err)
    {
      clearInterval(keepAlive);
    }
  }, 15000);

  req.on("close", function ()
  {
    clearInterval(keepAlive);
    clients.delete(res);
  });
}

// Only this machine's own names may address the server.
//
// The origin check below is not enough on its own. A page served from
// attacker.example whose hostname resolves to 127.0.0.1 is same-origin with
// this server as far as the browser is concerned, so it sends no Origin header
// at all and "if (origin && ...)" never sees the request. That is DNS
// rebinding, and it was wide open: a visited web page could read /api/state
// for the workspace path, post to /api/config, and post to /api/chat, which
// writes files and runs shell commands. The Host header is what gives such a
// request away, because the browser fills it in from the URL the page used.
//
// A missing Host is refused too. HTTP/1.1 requires it, every browser sends it,
// and nothing else is meant to be talking to this process.
function allowedHost(header)
{
  const raw = String(header === undefined || header === null ? "" : header).trim();
  if (!raw)
  {
    return false;
  }

  // Strip the port, and the brackets an IPv6 literal arrives in.
  let name = raw.toLowerCase();
  if (name[0] === "[")
  {
    const close = name.indexOf("]");
    name = close > 0 ? name.slice(1, close) : name.slice(1);
  }
  else
  {
    name = name.replace(/:\d+$/, "");
  }

  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

const server = http.createServer(function (req, res)
{
  if (!allowedHost(req.headers.host))
  {
    sendJson(res, 403, { error: "forbidden host" });
    return;
  }

  // "//evil" is a protocol-relative URL, so new URL() would read "evil" as the
  // authority and hand back "/" as the path. Collapsing the leading slashes
  // keeps the request target a path, which is all it is allowed to be.
  const target = "/" + String(req.url === undefined || req.url === null ? "/" : req.url).replace(/^\/+/, "");
  const url = new URL(target, "http://" + HOST);

  // Local-only guard: reject cross-site form posts from a browser page.
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin))
  {
    sendJson(res, 403, { error: "forbidden origin" });
    return;
  }

  if (url.pathname === "/api/events" && req.method === "GET")
  {
    handleEvents(req, res);
    return;
  }

  if (url.pathname.startsWith("/api/"))
  {
    handleApi(req, res, url).catch(function (err)
    {
      sendJson(res, err && err.status ? err.status : 500, { ok: false, error: err.message });
    });
    return;
  }

  serveStatic(req, res, url.pathname).catch(function (err)
  {
    sendJson(res, 500, { error: err.message });
  });
});

function openBrowser(target)
{
  try
  {
    let child = null;
    if (process.platform === "win32")
    {
      child = spawn("cmd.exe", ["/c", "start", "", target], { detached: true, stdio: "ignore", windowsHide: true });
    }
    else if (process.platform === "darwin")
    {
      child = spawn("open", [target], { detached: true, stdio: "ignore" });
    }
    else
    {
      child = spawn("xdg-open", [target], { detached: true, stdio: "ignore" });
    }
    if (child)
    {
      // spawn() reports a missing xdg-open asynchronously, outside this try.
      // The server must stay up; the URL is printed for headless machines.
      child.on("error", function () {});
      child.unref();
    }
  }
  catch (err)
  {
    // ignore, the URL is printed anyway
  }
}

function listen(port, attemptsLeft, opts)
{
  // Both listeners must be removed before retrying on the next port, otherwise
  // every attempt leaves a stale "listening" handler that later fires with the
  // wrong port and opens a second browser tab.
  function onListening()
  {
    server.removeListener("error", onError);

    const actual = server.address();
    const shown = (actual && actual.port) ? actual.port : port;
    const target = "http://" + HOST + ":" + shown + "/";
    const cfg = config.load();

    console.log("[oh-my-qwen] ready at " + target);
    console.log("[oh-my-qwen] LM Studio: " + cfg.baseUrl + "  model: " + (cfg.model || "(not selected)"));
    console.log("[oh-my-qwen] workspace: " + (cfg.workspace || "(not set)"));
    console.log("[oh-my-qwen] data: " + config.appDir() + (config.isPortable() ? "  (portable)" : ""));

    if (opts.open)
    {
      openBrowser(target);
    }
  }

  function onError(err)
  {
    server.removeListener("listening", onListening);

    if (err.code === "EADDRINUSE" && attemptsLeft > 0)
    {
      console.log("[oh-my-qwen] port " + port + " busy, trying " + (port + 1));
      listen(port + 1, attemptsLeft - 1, opts);
      return;
    }

    console.error("[oh-my-qwen] listen failed:", err.message);
    process.exit(1);
  }

  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port, HOST);
}

const options = parseArgs(process.argv);

// Before anything else: the exe has no console, so this is the only record of
// what happened. Also the only place a startup failure can be reported.
const logFile = logger.install();
console.log("[oh-my-qwen] log: " + logFile);

listen(options.port, 10, options);

let shuttingDown = false;

// Persist the conversation before leaving, but never hang on it: a stuck write
// would leave a windowless process alive with no way to reach it.
function shutdown(reason)
{
  if (shuttingDown)
  {
    return;
  }
  shuttingDown = true;
  console.log("[oh-my-qwen] shutting down (" + reason + ")");

  const done = function ()
  {
    process.exit(0);
  };
  const timer = setTimeout(done, 3000);

  sessionStore.persist(currentSession()).finally(function ()
  {
    clearTimeout(timer);
    done();
  });
}

process.on("SIGINT", function ()
{
  shutdown("SIGINT");
});

process.on("SIGTERM", function ()
{
  shutdown("SIGTERM");
});
