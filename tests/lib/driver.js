"use strict";

// Headless driver for the agent loop.
//
// The point of this harness is to run the real src/agent.js turn against a real
// LM Studio model on a throwaway project, then check the project on disk rather
// than believing what the model said it did. Everything the turn emitted is kept
// so the report can separate "the model was wrong" from "our tooling failed it".

const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const agent = require("../../src/agent");
const sessionStore = require("../../src/session");
const config = require("../../src/config");
const project = require("../../src/project");
const fixture = require("./fixture");

const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;

function now()
{
  return Date.now();
}

// Runs a verification command outside the agent, so a scenario can prove the
// produced project really builds or really returns the exit code it claims.
function sh(dir, command, opts)
{
  const options = opts || {};

  if (options.msvc)
  {
    return { code: -1, out: "", err: "MSVC scenarios are not available on Ubuntu", skipped: true };
  }

  const res = spawnSync("/bin/bash",
    ["--noprofile", "--norc", "-o", "pipefail", "-c", command],
    {
      cwd: dir,
      encoding: "buffer",
      timeout: options.timeoutMs || 240000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    });

  const decode = function (buf)
  {
    if (!buf)
    {
      return "";
    }
    return Buffer.from(buf).toString("utf8");
  };

  return {
    code: typeof res.status === "number" ? res.status : -1,
    out: decode(res.stdout),
    err: decode(res.stderr),
    timedOut: !!res.error && res.error.code === "ETIMEDOUT"
  };
}

function summarizeUsage(events)
{
  let prompt = 0;
  let completion = 0;
  for (let i = 0; i < events.length; i++)
  {
    const ev = events[i];
    if (ev.name === "assistant_end" && ev.data && ev.data.usage)
    {
      prompt += ev.data.usage.prompt_tokens || 0;
      completion += ev.data.usage.completion_tokens || 0;
    }
  }
  return { prompt: prompt, completion: completion };
}

// Everything worth flagging as a possible app-level problem, as opposed to a
// model mistake. The report groups these so repeated friction is obvious.
function collectFriction(events)
{
  const out = [];

  for (let i = 0; i < events.length; i++)
  {
    const ev = events[i];

    if (ev.name === "tool_result" && ev.data && ev.data.ok === false)
    {
      out.push({
        kind: "tool_failed",
        tool: ev.data.name,
        label: ev.data.label || "",
        summary: ev.data.summary || "",
        detail: String(ev.data.text || "").slice(0, 400)
      });
    }
    if (ev.name === "notice" && ev.data && ev.data.level !== "info")
    {
      out.push({
        kind: "notice_" + (ev.data.level || "warn"),
        tool: "",
        label: "",
        summary: String(ev.data.text || "").split("\n")[0].slice(0, 200),
        detail: String(ev.data.text || "").slice(0, 400)
      });
    }
    if (ev.name === "error" && ev.data)
    {
      out.push({
        kind: "error",
        tool: "",
        label: "",
        summary: String(ev.data.message || "").slice(0, 200),
        detail: String(ev.data.message || "")
      });
    }
  }

  return out;
}

function toolLog(events)
{
  const calls = [];
  const byId = new Map();

  for (let i = 0; i < events.length; i++)
  {
    const ev = events[i];
    if (ev.name === "tool_call" && ev.data)
    {
      const entry =
      {
        name: ev.data.name,
        label: ev.data.label || "",
        args: ev.data.args || {},
        ok: null,
        summary: "",
        text: "",
        at: ev.at
      };
      calls.push(entry);
      byId.set(ev.data.callId, entry);
    }
    if (ev.name === "tool_result" && ev.data)
    {
      const entry = byId.get(ev.data.callId);
      if (entry)
      {
        entry.ok = ev.data.ok;
        entry.summary = ev.data.summary || "";
        entry.text = String(ev.data.text || "");
        entry.ms = ev.at - entry.at;
      }
      else
      {
        calls.push({
          name: ev.data.name,
          label: ev.data.label || "",
          args: {},
          ok: ev.data.ok,
          summary: ev.data.summary || "",
          text: String(ev.data.text || ""),
          at: ev.at
        });
      }
    }
  }

  return calls;
}

function assistantTexts(events)
{
  const out = [];
  for (let i = 0; i < events.length; i++)
  {
    if (events[i].name === "assistant_end" && events[i].data && String(events[i].data.text || "").trim())
    {
      out.push(String(events[i].data.text));
    }
  }
  return out;
}

async function withTimeout(promise, ms, onTimeout)
{
  let timer = null;
  let firedTimeout = false;

  const guard = new Promise(function (resolve)
  {
    timer = setTimeout(function ()
    {
      firedTimeout = true;
      try
      {
        onTimeout();
      }
      catch (err)
      {
        // best effort
      }
      // Give the loop a moment to unwind through its own abort path.
      setTimeout(resolve, 20000);
    }, ms);
  });

  await Promise.race([promise, guard]);
  clearTimeout(timer);
  return firedTimeout;
}

async function runScenario(scenario, opts)
{
  const options = opts || {};
  const baseDir = options.baseDir || path.join(os.tmpdir(), "omq-harness");
  const dir = path.join(baseDir, scenario.name);

  fixture.rmrf(dir);
  fixture.mkdirp(dir);

  const startedAt = now();
  const result =
  {
    name: scenario.name,
    title: scenario.title || scenario.name,
    dir: dir,
    skipped: false,
    skipReason: "",
    turns: [],
    checks: [],
    friction: [],
    detected: null,
    ms: 0,
    usage: { prompt: 0, completion: 0 },
    error: ""
  };

  if (typeof scenario.requires === "function")
  {
    const why = scenario.requires();
    if (why)
    {
      result.skipped = true;
      result.skipReason = why;
      return result;
    }
  }

  try
  {
    await scenario.setup(dir, fixture);
  }
  catch (err)
  {
    result.error = "setup failed: " + err.message;
    return result;
  }

  // What the app itself thinks this project is. Wrong detection is an app bug
  // even when the model manages to work around it.
  try
  {
    const info = project.detect(dir);
    result.detected = info
      ? {
          kind: info.kind,
          label: info.label,
          build: info.tasks.build && info.tasks.build.command,
          test: info.tasks.test && info.tasks.test.command,
          run: info.tasks.run && info.tasks.run.command
        }
      : null;
  }
  catch (err)
  {
    result.detected = null;
    result.error = "detect threw: " + err.message;
  }

  const cfg = Object.assign({}, config.DEFAULTS,
  {
    workspace: dir,
    model: options.model,
    baseUrl: options.baseUrl,
    // Track the app default, not a private number: a harness that samples
    // differently from production measures a different agent than it ships.
    temperature: options.temperature !== undefined ? options.temperature : config.DEFAULTS.temperature,
    maxTokens: options.maxTokens || 3072,
    contextTokens: options.contextTokens || 12000,
    maxToolRounds: options.rounds || 20,
    idleTimeoutSec: options.idleTimeoutSec || 120,
    firstByteTimeoutSec: options.firstByteTimeoutSec || 300,
    autoApprove: false
  }, scenario.config || {});

  const session = new sessionStore.Session(dir);
  const allEvents = [];

  const prompts = Array.isArray(scenario.prompts) ? scenario.prompts : [scenario.prompt];

  for (let t = 0; t < prompts.length; t++)
  {
    const turnEvents = [];
    const turnStart = now();

    const emit = function (name, data)
    {
      const ev = { name: name, data: data, at: now() };
      turnEvents.push(ev);
      allEvents.push(ev);

      if (name === "approval_request" && data)
      {
        const verdict = typeof scenario.approve === "function"
          ? scenario.approve(data, { turn: t, dir: dir })
          : true;

        setImmediate(function ()
        {
          const pending = session.pending.get(data.id);
          if (pending)
          {
            pending.resolve({ approved: !!verdict });
          }
        });
      }

      if (typeof options.onEvent === "function")
      {
        options.onEvent(scenario, t, ev);
      }
    };

    const timedOut = await withTimeout(
      agent.runTurn({ session: session, cfg: cfg, userText: prompts[t], emit: emit }),
      options.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS,
      function ()
      {
        session.cancel("harness timeout");
      });

    const stopEvent = turnEvents.filter(function (e)
    {
      return e.name === "turn_end";
    }).pop();

    result.turns.push({
      prompt: prompts[t],
      ms: now() - turnStart,
      timedOut: timedOut,
      stopReason: stopEvent && stopEvent.data ? stopEvent.data.stopReason : "unknown",
      tools: toolLog(turnEvents),
      texts: assistantTexts(turnEvents),
      usage: summarizeUsage(turnEvents)
    });

    if (timedOut)
    {
      break;
    }
  }

  result.usage = summarizeUsage(allEvents);
  result.friction = collectFriction(allEvents);
  result.ms = now() - startedAt;

  const ctx =
  {
    dir: dir,
    fixture: fixture,
    events: allEvents,
    turns: result.turns,
    tools: toolLog(allEvents),
    detected: result.detected,
    sh: function (command, o)
    {
      return sh(dir, command, o);
    },
    read: function (rel)
    {
      return fixture.read(dir, rel);
    },
    readInfo: function (rel)
    {
      return fixture.readInfo(dir, rel);
    },
    exists: function (rel)
    {
      return fixture.exists(dir, rel);
    },
    files: function ()
    {
      return fixture.listAll(dir);
    },
    usedTool: function (name)
    {
      return toolLog(allEvents).some(function (c)
      {
        return c.name === name;
      });
    },
    approvals: function ()
    {
      return allEvents.filter(function (e)
      {
        return e.name === "approval_request";
      }).map(function (e)
      {
        return e.data;
      });
    }
  };

  try
  {
    const checks = await scenario.check(ctx);
    result.checks = Array.isArray(checks) ? checks : [];
  }
  catch (err)
  {
    result.error = "check threw: " + err.message + "\n" + String(err.stack || "").split("\n").slice(1, 4).join("\n");
  }

  if (!options.keep)
  {
    fixture.rmrf(dir);
  }

  return result;
}

module.exports =
{
  runScenario: runScenario,
  sh: sh
};
