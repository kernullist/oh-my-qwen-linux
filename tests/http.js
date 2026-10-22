"use strict";

// HTTP surface tests:
//
//   node tests/http.js
//
// The scenario harness calls agent.runTurn directly and the unit suite calls
// the tool layer directly, so until now nothing exercised server.js at all:
// every route, the SSE stream, the static file guard and the origin check were
// unverified. A broken handler passed 259 unit checks and 36 scenarios.
//
// server.js listens at module load, so it cannot be required. That is fine and
// arguably better: this spawns the real process, which also covers argument
// parsing, logger.install, port retry and the shutdown path.

const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(os.tmpdir(), "omq-http-data");
const WORK_DIR = path.join(os.tmpdir(), "omq-http-work");

const results = [];
let currentGroup = "";

function group(name)
{
  currentGroup = name;
}

function ok(label, condition, detail)
{
  results.push({
    group: currentGroup,
    label: label,
    ok: !!condition,
    detail: condition ? "" : String(detail === undefined ? "" : detail)
  });
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

function request(port, method, route, opts)
{
  const options = opts || {};
  const payload = options.body === undefined ? null
    : (typeof options.body === "string" ? options.body : JSON.stringify(options.body));

  return new Promise(function (resolve, reject)
  {
    const headers = Object.assign({}, options.headers || {});
    if (payload !== null && headers["Content-Type"] === undefined)
    {
      headers["Content-Type"] = "application/json";
    }

    const req = http.request(
      {
        host: "127.0.0.1",
        port: port,
        method: method,
        path: route,
        headers: headers,
        timeout: options.timeoutMs || 15000
      },
      function (res)
      {
        const chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function ()
        {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch (err) { json = null; }
          resolve({ code: res.statusCode, headers: res.headers, text: text, json: json });
        });
      });

    req.on("timeout", function () { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    if (payload !== null) { req.write(payload); }
    req.end();
  });
}

// Reads the SSE stream for a moment and hands back the raw frames.
function readEvents(port, ms)
{
  return new Promise(function (resolve, reject)
  {
    const req = http.request(
      { host: "127.0.0.1", port: port, method: "GET", path: "/api/events" },
      function (res)
      {
        let text = "";
        res.on("data", function (c) { text += c.toString("utf8"); });
        const timer = setTimeout(function ()
        {
          req.destroy();
          resolve({ code: res.statusCode, headers: res.headers, text: text });
        }, ms);
        res.on("end", function ()
        {
          clearTimeout(timer);
          resolve({ code: res.statusCode, headers: res.headers, text: text });
        });
      });
    req.on("error", function (err)
    {
      // destroy() after the read window is not a failure
      if (String(err.message).indexOf("socket hang up") >= 0) { return; }
      reject(err);
    });
    req.end();
  });
}

// Opens the stream, runs an action while it is open, and hands back the frames
// that arrived. The stream is the only way the UI learns anything, so a route
// that answers 200 while broadcasting nothing leaves the page silently stale.
function withEvents(port, action, ms)
{
  return new Promise(function (resolve, reject)
  {
    const req = http.request(
      { host: "127.0.0.1", port: port, method: "GET", path: "/api/events" },
      function (res)
      {
        let text = "";
        res.on("data", function (c) { text += c.toString("utf8"); });

        // Give the hello frame time to land before doing anything.
        setTimeout(function ()
        {
          Promise.resolve()
            .then(action)
            .then(function (actionResult)
            {
              setTimeout(function ()
              {
                req.destroy();
                resolve({ text: text, actionResult: actionResult });
              }, ms || 700);
            })
            .catch(function (err)
            {
              req.destroy();
              reject(err);
            });
        }, 250);
      });

    req.on("error", function (err)
    {
      if (String(err.message).indexOf("socket hang up") >= 0) { return; }
      reject(err);
    });
    req.end();
  });
}

function rmrf(dir)
{
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* gone already */ }
}

function startServer()
{
  rmrf(DATA_DIR);
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const env = Object.assign({}, process.env, { OMQ_DATA_DIR: DATA_DIR });
  const child = spawn(process.execPath, [path.join(ROOT, "server.js"), "--port", "18787", "--no-open"],
    { cwd: ROOT, env: env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  let out = "";
  let err = "";
  child.stdout.on("data", function (c) { out += c.toString("utf8"); });
  child.stderr.on("data", function (c) { err += c.toString("utf8"); });

  return new Promise(function (resolve, reject)
  {
    const timer = setTimeout(function ()
    {
      reject(new Error("server did not report ready in 20s\nstdout:\n" + out + "\nstderr:\n" + err));
    }, 20000);

    const poll = setInterval(function ()
    {
      const m = /ready at http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (m)
      {
        clearInterval(poll);
        clearTimeout(timer);
        resolve({
          child: child,
          port: Number(m[1]),
          stdout: function () { return out; },
          stderr: function () { return err; }
        });
      }
      if (child.exitCode !== null)
      {
        clearInterval(poll);
        clearTimeout(timer);
        reject(new Error("server exited with " + child.exitCode + "\nstdout:\n" + out + "\nstderr:\n" + err));
      }
    }, 120);
  });
}

// ---------------------------------------------------------------------------
// the tests
// ---------------------------------------------------------------------------

async function testStartup(server)
{
  group("startup");

  ok("the server reports a port it is actually listening on", server.port > 0, String(server.port));
  ok("startup names the log file", /\[oh-my-qwen\] log: /.test(server.stdout()), server.stdout().slice(0, 200));
  ok("startup names the data folder", /\[oh-my-qwen\] data: /.test(server.stdout()), server.stdout().slice(0, 300));
  ok("the data folder is the one we asked for",
    server.stdout().indexOf(DATA_DIR) >= 0,
    "expected " + DATA_DIR + " in:\n" + server.stdout().slice(0, 400));
  ok("nothing was written to stderr on a clean start", server.stderr().trim() === "", server.stderr().slice(0, 300));
}

async function testState(port)
{
  group("GET /api/state");

  const r = await request(port, "GET", "/api/state");
  ok("returns 200", r.code === 200, String(r.code) + " " + r.text.slice(0, 120));
  ok("carries the config", r.json && typeof r.json.config === "object", r.text.slice(0, 200));
  ok("carries the workspace block", r.json && r.json.workspace !== undefined, r.text.slice(0, 200));
  ok("carries the transcript", r.json && Array.isArray(r.json.transcript), r.text.slice(0, 200));
  ok("never leaks the log path outside config",
    r.json && r.json.config && typeof r.json.config.logPath === "string", JSON.stringify(r.json && r.json.config));

  // A GET-only route must not answer a POST as though it worked.
  const wrong = await request(port, "POST", "/api/state", { body: {} });
  ok("a POST to a GET route is not treated as the GET", wrong.code === 404,
    String(wrong.code) + " " + wrong.text.slice(0, 120));
}

async function testModels(port)
{
  group("GET /api/models");

  const r = await request(port, "GET", "/api/models", { timeoutMs: 20000 });
  // LM Studio may or may not be up; either way this must not be a 500.
  ok("answers 200 whether or not LM Studio is reachable", r.code === 200,
    String(r.code) + " " + r.text.slice(0, 200));
  ok("always returns a models array", r.json && Array.isArray(r.json.models), r.text.slice(0, 200));
  ok("says which it was", r.json && typeof r.json.ok === "boolean", r.text.slice(0, 200));
  if (r.json && r.json.ok === false)
  {
    ok("a failure carries a reason", typeof r.json.error === "string" && r.json.error.length > 0, r.text.slice(0, 200));
  }
}

async function testConfig(port)
{
  group("POST /api/config");

  const applied = await request(port, "POST", "/api/config", { body: { temperature: 0.42, maxToolRounds: 7 } });
  ok("a valid patch is accepted", applied.code === 200, String(applied.code) + " " + applied.text.slice(0, 150));
  ok("and echoed back", applied.json && applied.json.config && applied.json.config.temperature === 0.42,
    JSON.stringify(applied.json && applied.json.config));

  // Out of range values must be clamped rather than stored as given: a
  // temperature of 99 or a 10 token context makes every later turn nonsense.
  const wild = await request(port, "POST", "/api/config",
    { body: { temperature: 99, contextTokens: 1, maxTokens: -5, maxToolRounds: 9999 } });
  ok("out of range values do not error", wild.code === 200, String(wild.code) + " " + wild.text.slice(0, 150));
  const c = (wild.json && wild.json.config) || {};
  ok("temperature is clamped", c.temperature <= 2, "temperature = " + c.temperature);
  ok("context budget is clamped up to something usable", c.contextTokens >= 1000, "contextTokens = " + c.contextTokens);
  ok("max tokens stays positive", c.maxTokens > 0, "maxTokens = " + c.maxTokens);
  ok("tool rounds are capped", c.maxToolRounds <= 100, "maxToolRounds = " + c.maxToolRounds);

  const junk = await request(port, "POST", "/api/config", { body: { nonsenseKey: "x", temperature: "abc" } });
  ok("unknown keys are ignored rather than stored", junk.code === 200 &&
    !(junk.json && junk.json.config && "nonsenseKey" in junk.json.config),
    junk.text.slice(0, 200));

  const sampler = await request(port, "POST", "/api/config",
    { body: { topP: 0.8, topK: 40, presencePenalty: 1.2, reasoningEffort: "medium" } });
  const s = (sampler.json && sampler.json.config) || {};
  ok("sampler fields are accepted and echoed",
    s.topP === 0.8 && s.topK === 40 && s.presencePenalty === 1.2 && s.reasoningEffort === "medium",
    JSON.stringify(s).slice(0, 200));

  const badEffort = await request(port, "POST", "/api/config", { body: { reasoningEffort: "maximum" } });
  ok("an unknown reasoning effort is never stored",
    badEffort.code === 200 && badEffort.json &&
    badEffort.json.config.reasoningEffort === "medium",
    JSON.stringify(badEffort.json && badEffort.json.config).slice(0, 200));

  // The Tavily key is a secret: it is stored, it switches the web tools on,
  // and it never comes back out of the API.
  const SECRET = "tvly-dev-SECRETVALUE9876";
  const keyed = await request(port, "POST", "/api/config", { body: { tavilyApiKey: SECRET } });
  ok("a Tavily key is accepted and reported as configured",
    keyed.code === 200 && keyed.json && keyed.json.config.webSearch && keyed.json.config.webSearch.configured === true &&
      keyed.json.config.webSearch.keyHint === "tvly-dev-…9876",
    JSON.stringify(keyed.json && keyed.json.config.webSearch));
  const stateAfterKey = await request(port, "GET", "/api/state");
  ok("the key itself never leaves the server",
    keyed.text.indexOf("SECRETVALUE") < 0 && stateAfterKey.text.indexOf("SECRETVALUE") < 0, "key leaked");
  const cfgFile = path.join(DATA_DIR, "config.json");
  const mode = fs.statSync(cfgFile).mode & 0o777;
  ok("the config file holding it is private to the owner", mode === 0o600, mode.toString(8));
  const kept = await request(port, "POST", "/api/config", { body: { showThinking: true } });
  ok("saving other settings keeps the key", kept.json && kept.json.config.webSearch.configured === true,
    JSON.stringify(kept.json && kept.json.config.webSearch));
  const keyCleared = await request(port, "POST", "/api/config", { body: { tavilyApiKey: "" } });
  ok("an empty key clears it", keyCleared.json && keyCleared.json.config.webSearch.configured === false,
    JSON.stringify(keyCleared.json && keyCleared.json.config.webSearch));
  const noKeyTest = await request(port, "POST", "/api/websearch/test", { body: {} });
  ok("testing without a key says so instead of calling out", noKeyTest.code === 200 && noKeyTest.json &&
    noKeyTest.json.ok === false && /키/.test(noKeyTest.json.error), noKeyTest.text.slice(0, 200));

  // "none" is the value that actually switches Qwen3.8's thinking off in LM
  // Studio, so the settings screen has to be able to store it.
  const offEffort = await request(port, "POST", "/api/config", { body: { reasoningEffort: "none" } });
  ok("reasoning can be switched off",
    offEffort.code === 200 && offEffort.json && offEffort.json.config.reasoningEffort === "none",
    JSON.stringify(offEffort.json && offEffort.json.config).slice(0, 200));

  // JSON.stringify turns NaN into null, so a cleared field used to arrive as
  // null and Number(null) === 0 rewrote it to the bottom of its clamp range.
  const before = (badEffort.json && badEffort.json.config) || {};
  const cleared = await request(port, "POST", "/api/config", { body: { temperature: null, topP: "abc" } });
  const after = (cleared.json && cleared.json.config) || {};
  ok("null and non-numeric values leave fields unchanged",
    cleared.code === 200 && after.temperature === before.temperature &&
    after.topP === before.topP && after.topK === before.topK &&
    after.presencePenalty === before.presencePenalty,
    "before " + JSON.stringify([before.temperature, before.topP, before.topK, before.presencePenalty]) +
    " after " + JSON.stringify([after.temperature, after.topP, after.topK, after.presencePenalty]));

  const notObject = await request(port, "POST", "/api/config", { body: "[1,2,3]" });
  ok("a non-object body does not crash the route", notObject.code === 200 || notObject.code === 400,
    String(notObject.code) + " " + notObject.text.slice(0, 150));

  // Restore something sane for the turns below.
  await request(port, "POST", "/api/config",
    { body: { temperature: 0.2, maxToolRounds: 8, reasoningEffort: "default" } });
}

async function testWorkspace(port)
{
  group("POST /api/workspace");

  rmrf(WORK_DIR);
  fs.mkdirSync(path.join(WORK_DIR, "src"), { recursive: true });
  fs.writeFileSync(path.join(WORK_DIR, "src", "main.c"), "int main(void){return 0;}\n");
  const filePath = path.join(WORK_DIR, "src", "main.c");

  const empty = await request(port, "POST", "/api/workspace", { body: { path: "" } });
  ok("an empty path is rejected", empty.code === 400, String(empty.code) + " " + empty.text.slice(0, 150));
  ok("and says why in a readable way", empty.json && typeof empty.json.error === "string" && empty.json.error.length > 0,
    empty.text.slice(0, 150));

  const missing = await request(port, "POST", "/api/workspace",
    { body: { path: path.join(WORK_DIR, "no-such-folder") } });
  ok("a missing folder is rejected", missing.code === 400, String(missing.code) + " " + missing.text.slice(0, 150));

  const aFile = await request(port, "POST", "/api/workspace", { body: { path: filePath } });
  ok("a file is rejected, not accepted as a folder", aFile.code === 400,
    String(aFile.code) + " " + aFile.text.slice(0, 150));

  const good = await request(port, "POST", "/api/workspace", { body: { path: WORK_DIR } });
  ok("a real folder is accepted", good.code === 200, String(good.code) + " " + good.text.slice(0, 200));
  ok("the answer describes the folder", good.json && good.json.workspace && good.json.workspace.path,
    JSON.stringify(good.json && good.json.workspace).slice(0, 200));
  ok("the risk assessment is included", good.json && good.json.workspace &&
    good.json.workspace.risk !== undefined,
    JSON.stringify(good.json && good.json.workspace).slice(0, 200));
  ok("switching folders hands back that folder's transcript",
    good.json && Array.isArray(good.json.transcript), good.text.slice(0, 150));

  // /api/workspace/pick is deliberately not called: it opens a real folder
  // dialog and would hang the run behind a window nobody is there to close.
}

async function testChat(port)
{
  group("POST /api/chat");

  const empty = await request(port, "POST", "/api/chat", { body: { message: "   " } });
  ok("an empty message is rejected", empty.code === 400, String(empty.code) + " " + empty.text.slice(0, 150));

  const approve = await request(port, "POST", "/api/approve", { body: { id: "no-such-approval", approved: true } });
  ok("an unknown approval id is a 404, not a crash", approve.code === 404,
    String(approve.code) + " " + approve.text.slice(0, 150));

  const cancel = await request(port, "POST", "/api/cancel", { body: {} });
  ok("cancel with nothing running still answers", cancel.code === 200,
    String(cancel.code) + " " + cancel.text.slice(0, 150));

  const clear = await request(port, "POST", "/api/clear", { body: {} });
  ok("clear answers", clear.code === 200, String(clear.code) + " " + clear.text.slice(0, 150));

  const state = await request(port, "GET", "/api/state");
  ok("clear actually emptied the transcript",
    state.json && Array.isArray(state.json.transcript) && state.json.transcript.length === 0,
    "transcript length " + ((state.json && state.json.transcript) || []).length);
}

async function testEvents(port)
{
  group("GET /api/events");

  const r = await readEvents(port, 900);
  ok("the stream opens with 200", r.code === 200, String(r.code));
  ok("it is announced as an event stream",
    /text\/event-stream/.test(String(r.headers["content-type"] || "")),
    String(r.headers["content-type"]));
  ok("proxy buffering is turned off", String(r.headers["x-accel-buffering"] || "") === "no",
    String(r.headers["x-accel-buffering"]));
  ok("a reconnect delay is sent", /retry:\s*\d+/.test(r.text), JSON.stringify(r.text.slice(0, 120)));
  ok("a hello frame arrives immediately", /event: hello/.test(r.text), JSON.stringify(r.text.slice(0, 200)));
}

async function testStatic(port)
{
  group("static files");

  const index = await request(port, "GET", "/");
  ok("/ serves the page", index.code === 200, String(index.code));
  ok("as html", /text\/html/.test(String(index.headers["content-type"] || "")),
    String(index.headers["content-type"]));
  ok("with a real body", index.text.length > 500, "length " + index.text.length);

  const js = await request(port, "GET", "/app.js");
  ok("/app.js serves", js.code === 200, String(js.code));
  ok("with a javascript type", /javascript/.test(String(js.headers["content-type"] || "")),
    String(js.headers["content-type"]));

  const css = await request(port, "GET", "/styles.css");
  ok("/styles.css serves", css.code === 200, String(css.code));
  ok("with a css type", /text\/css/.test(String(css.headers["content-type"] || "")),
    String(css.headers["content-type"]));

  const nope = await request(port, "GET", "/definitely-not-here.txt");
  ok("an unknown file is a 404", nope.code === 404, String(nope.code) + " " + nope.text.slice(0, 80));

  // The static handler is the one place a browser picks the path, so it is the
  // one place traversal has to be refused. server.js is one level above the
  // public folder and is the obvious thing to try to read.
  const traversals = ["/../server.js", "/..%2Fserver.js", "/%2e%2e/server.js",
    "/public/../server.js", "//server.js", "/....//server.js"];
  for (let i = 0; i < traversals.length; i++)
  {
    const t = await request(port, "GET", traversals[i]);
    const leaked = /createServer|require\("http"\)/.test(t.text);
    ok("traversal refused: " + traversals[i], !leaked && t.code !== 200,
      String(t.code) + " leaked=" + leaked + " " + t.text.slice(0, 80));
  }
}

async function testErrorPaths(port)
{
  group("error paths");

  const unknown = await request(port, "GET", "/api/nope");
  ok("an unknown api route is a 404", unknown.code === 404, String(unknown.code) + " " + unknown.text.slice(0, 120));
  ok("and names the route it could not find", /nope/.test(unknown.text), unknown.text.slice(0, 120));

  // A body the client got wrong is a client error. Reporting it as a 500 tells
  // the caller the server broke, which sends anyone debugging to the wrong side.
  const badJson = await request(port, "POST", "/api/config", { body: "{ this is not json" });
  ok("a malformed JSON body is a 4xx, not a 5xx",
    badJson.code >= 400 && badJson.code < 500,
    String(badJson.code) + " " + badJson.text.slice(0, 150));
  ok("and explains that the body was the problem",
    /json/i.test(badJson.text), badJson.text.slice(0, 150));

  const emptyBody = await request(port, "POST", "/api/cancel", { body: "" });
  ok("an empty body on a POST route is tolerated", emptyBody.code === 200,
    String(emptyBody.code) + " " + emptyBody.text.slice(0, 120));
}

async function testOriginGuard(port)
{
  group("origin and host guard");

  const evil = await request(port, "POST", "/api/config",
    { body: { temperature: 0.3 }, headers: { Origin: "http://evil.example" } });
  ok("a cross-site origin is refused", evil.code === 403, String(evil.code) + " " + evil.text.slice(0, 120));

  const https = await request(port, "GET", "/api/state",
    { headers: { Origin: "https://127.0.0.1" } });
  ok("https on the loopback origin is still not this app", https.code === 403,
    String(https.code) + " " + https.text.slice(0, 120));

  const local = await request(port, "GET", "/api/state",
    { headers: { Origin: "http://127.0.0.1:" + port } });
  ok("the app's own origin is allowed", local.code === 200, String(local.code));

  const localhost = await request(port, "GET", "/api/state",
    { headers: { Origin: "http://localhost:" + port } });
  ok("localhost is allowed too", localhost.code === 200, String(localhost.code));

  // DNS rebinding: a page served from attacker.example whose hostname resolves
  // to 127.0.0.1 is same-origin with this server as far as the browser is
  // concerned, so it sends no Origin header at all. The Origin check cannot see
  // that request. The Host header is what gives it away, and the request below
  // is exactly what such a page produces.
  const rebound = await request(port, "POST", "/api/config",
    { body: { temperature: 0.3 }, headers: { Host: "attacker.example" } });
  ok("a request for someone else's hostname is refused",
    rebound.code === 403,
    "Host: attacker.example answered " + rebound.code + " " + rebound.text.slice(0, 120));

  const reboundGet = await request(port, "GET", "/api/state", { headers: { Host: "attacker.example" } });
  ok("and cannot read state either", reboundGet.code === 403,
    "Host: attacker.example answered " + reboundGet.code + " " + reboundGet.text.slice(0, 120));

  const goodHost = await request(port, "GET", "/api/state", { headers: { Host: "127.0.0.1:" + port } });
  ok("the real host still works", goodHost.code === 200, String(goodHost.code));

  const localhostHost = await request(port, "GET", "/api/state", { headers: { Host: "localhost:" + port } });
  ok("so does localhost", localhostHost.code === 200, String(localhostHost.code));
}

async function testBroadcast(port)
{
  group("live updates");

  const seen = await withEvents(port, function ()
  {
    return request(port, "POST", "/api/workspace", { body: { path: WORK_DIR } });
  });

  ok("switching folders reaches a connected client", /event: workspace/.test(seen.text),
    JSON.stringify(seen.text.slice(0, 300)));
  ok("the frame carries the folder it belongs to",
    /"workspace"\s*:/.test(seen.text), JSON.stringify(seen.text.slice(0, 400)));
  ok("and the transcript for that folder", /"transcript"/.test(seen.text),
    JSON.stringify(seen.text.slice(0, 400)));

  const cleared = await withEvents(port, function ()
  {
    return request(port, "POST", "/api/clear", { body: {} });
  });
  ok("clearing the room is announced too", /event: /.test(cleared.text),
    JSON.stringify(cleared.text.slice(0, 300)));
}

async function testHostileBodies(port)
{
  group("hostile bodies");

  // 5 MB against a 4 MB cap. The cap already existed; what it answered did not
  // say so, and a caller cannot tell "too big" from "the server fell over".
  const big = "x".repeat(5 * 1024 * 1024);
  let oversize = null;
  try
  {
    oversize = await request(port, "POST", "/api/config",
      { body: JSON.stringify({ systemPrompt: big }), timeoutMs: 30000 });
  }
  catch (err)
  {
    oversize = { code: 0, text: "connection error: " + err.message, json: null };
  }
  ok("an oversized body is refused with 413, not a reset",
    oversize.code === 413, String(oversize.code) + " " + String(oversize.text).slice(0, 150));
  ok("and says the body was too large", /too large/i.test(String(oversize.text)),
    String(oversize.text).slice(0, 150));

  const alive = await request(port, "GET", "/api/state");
  ok("the server is still serving afterwards", alive.code === 200, String(alive.code));

  // A chat with no model configured must fail like a normal failure, not take
  // the process with it. This is the one route that starts real work.
  await request(port, "POST", "/api/config", { body: { model: "", baseUrl: "http://127.0.0.1:9" } });
  const chat = await request(port, "POST", "/api/chat", { body: { message: "hello" }, timeoutMs: 20000 });
  ok("a chat with nowhere to go still answers the caller",
    chat.code === 202 || (chat.code >= 400 && chat.code < 500),
    String(chat.code) + " " + chat.text.slice(0, 150));

  await new Promise(function (r) { setTimeout(r, 1500); });
  const stillAlive = await request(port, "GET", "/api/state");
  ok("and the process survives it", stillAlive.code === 200, String(stillAlive.code));
}

async function testShutdown(server)
{
  group("POST /api/shutdown");

  const r = await request(server.port, "POST", "/api/shutdown", { body: {} });
  ok("shutdown answers before it goes", r.code === 200, String(r.code) + " " + r.text.slice(0, 120));

  const exited = await new Promise(function (resolve)
  {
    const timer = setTimeout(function () { resolve(false); }, 8000);
    server.child.on("exit", function () { clearTimeout(timer); resolve(true); });
    if (server.child.exitCode !== null) { clearTimeout(timer); resolve(true); }
  });

  ok("and the process actually exits", exited, "still running after 8s");
  ok("the log records the reason", /shutting down \(/.test(server.stdout()),
    server.stdout().slice(-300));

  if (!exited)
  {
    try { server.child.kill(); } catch (err) { /* nothing else to try */ }
  }
}

// ---------------------------------------------------------------------------

async function main()
{
  let server = null;

  try
  {
    server = await startServer();
  }
  catch (err)
  {
    process.stdout.write("could not start the server: " + err.message + "\n");
    process.exit(2);
  }

  try
  {
    await testStartup(server);
    await testState(server.port);
    await testModels(server.port);
    await testConfig(server.port);
    await testWorkspace(server.port);
    await testChat(server.port);
    await testEvents(server.port);
    await testStatic(server.port);
    await testErrorPaths(server.port);
    await testOriginGuard(server.port);
    await testBroadcast(server.port);
    await testHostileBodies(server.port);
    await testShutdown(server);
  }
  catch (err)
  {
    process.stdout.write("suite threw: " + (err && err.stack ? err.stack : err) + "\n");
    try { server.child.kill(); } catch (e) { /* already gone */ }
  }

  rmrf(WORK_DIR);
  rmrf(DATA_DIR);

  let lastGroup = "";
  let failed = 0;

  for (let i = 0; i < results.length; i++)
  {
    const r = results[i];
    if (r.group !== lastGroup)
    {
      lastGroup = r.group;
      process.stdout.write("\n" + r.group + "\n");
    }
    if (!r.ok) { failed++; }
    process.stdout.write("  " + (r.ok ? "ok  " : "FAIL") + " " + r.label +
      (r.ok ? "" : "\n       " + String(r.detail).split("\n").slice(0, 4).join("\n       ")) + "\n");
  }

  process.stdout.write("\n" + (results.length - failed) + "/" + results.length + " checks passed\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (err)
{
  process.stdout.write("http suite crashed: " + (err && err.stack ? err.stack : err) + "\n");
  process.exit(2);
});
