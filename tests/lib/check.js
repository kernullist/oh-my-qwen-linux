"use strict";

// Small helpers shared by the scenario check functions.

const { spawnSync } = require("child_process");
const toolchain = require("../../src/toolchain");

function check(label, ok, detail)
{
  return { label: label, ok: !!ok, detail: detail === undefined ? "" : String(detail) };
}

// Same as check(), but a failure is a documented limit of this model rather than
// a bug in the app. Reported as "known", counted separately, and never turns the
// suite red. Passing is reported normally, so a limit that lifts is visible.
function known(label, ok, detail, why)
{
  const c = check(label, ok, detail);
  c.known = String(why || "known model limitation");
  return c;
}

const commandCache = new Map();

function hasCommand(name)
{
  if (commandCache.has(name))
  {
    return commandCache.get(name);
  }
  const res = spawnSync(process.platform === "win32" ? "where" : "which", [name],
  {
    encoding: "utf8",
    windowsHide: true
  });
  const found = res.status === 0;
  commandCache.set(name, found);
  return found;
}

// Returns a reason string when the scenario cannot run here, "" otherwise.
function needs(list)
{
  for (let i = 0; i < list.length; i++)
  {
    const name = list[i];
    if (name === "msvc")
    {
      const tc = toolchain.detect();
      if (!tc || !tc.vcvarsall)
      {
        return "MSVC not installed";
      }
      continue;
    }
    if (!hasCommand(name))
    {
      return name + " not on PATH";
    }
  }
  return "";
}

// True when the model's visible answer mentions any of the given fragments.
function saidAny(turns, fragments)
{
  const text = turns.map(function (t)
  {
    return t.texts.join("\n");
  }).join("\n").toLowerCase();

  return fragments.some(function (f)
  {
    return text.indexOf(String(f).toLowerCase()) >= 0;
  });
}

// True when any tool result body contains the fragment. Used to prove that a
// specific piece of tooling actually fired, not that the model guessed right.
function toolSaid(tools, fragments, name)
{
  return tools.some(function (call)
  {
    if (name && call.name !== name)
    {
      return false;
    }
    const body = String(call.text || "") + " " + String(call.summary || "");
    return fragments.some(function (f)
    {
      return body.toLowerCase().indexOf(String(f).toLowerCase()) >= 0;
    });
  });
}

function countTool(tools, name)
{
  return tools.filter(function (t)
  {
    return t.name === name;
  }).length;
}

module.exports =
{
  check: check,
  known: known,
  needs: needs,
  hasCommand: hasCommand,
  saidAny: saidAny,
  toolSaid: toolSaid,
  countTool: countTool
};
