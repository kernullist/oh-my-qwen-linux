"use strict";

// Console progress and the markdown run report.

const fs = require("fs");
const path = require("path");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code, text)
{
  if (!COLOR)
  {
    return text;
  }
  return "[" + code + "m" + text + "[0m";
}

const c =
{
  dim: function (t) { return paint("90", t); },
  red: function (t) { return paint("31", t); },
  green: function (t) { return paint("32", t); },
  yellow: function (t) { return paint("33", t); },
  blue: function (t) { return paint("36", t); },
  bold: function (t) { return paint("1", t); }
};

function secs(ms)
{
  return (ms / 1000).toFixed(1) + "s";
}

function oneLine(text, limit)
{
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit)
  {
    return flat;
  }
  return flat.slice(0, limit - 3) + "...";
}

// Live event printer. Keeps one line per tool call so a long run stays readable.
function liveLogger(opts)
{
  const options = opts || {};
  const state = { reasoning: 0, content: 0, lastTurn: -1 };

  return function (scenario, turn, ev)
  {
    if (turn !== state.lastTurn)
    {
      state.lastTurn = turn;
      process.stdout.write(c.dim("    turn " + (turn + 1) + " start\n"));
    }

    if (ev.name === "reasoning_delta")
    {
      state.reasoning += ev.data.text.length;
      return;
    }
    if (ev.name === "content_delta")
    {
      state.content += ev.data.text.length;
      return;
    }
    if (ev.name === "tool_call")
    {
      process.stdout.write("    " + c.blue("-> " + ev.data.name) + " " + c.dim(oneLine(ev.data.label, 90)) + "\n");
      return;
    }
    if (ev.name === "tool_result")
    {
      const mark = ev.data.ok ? c.green("  ok") : c.red("fail");
      process.stdout.write("    " + mark + " " + c.dim(oneLine(ev.data.summary, 100)) + "\n");
      return;
    }
    if (ev.name === "approval_request")
    {
      process.stdout.write("    " + c.yellow("? approve") + " " + c.dim(oneLine(ev.data.name + " " + ev.data.label, 80)) + "\n");
      return;
    }
    if (ev.name === "notice")
    {
      const tint = ev.data.level === "error" ? c.red : (ev.data.level === "warn" ? c.yellow : c.dim);
      process.stdout.write("    " + tint("! " + oneLine(ev.data.text, 120)) + "\n");
      return;
    }
    if (ev.name === "assistant_end" && options.verbose)
    {
      process.stdout.write("    " + c.dim("say: " + oneLine(ev.data.text, 140)) + "\n");
      return;
    }
    if (ev.name === "turn_end")
    {
      process.stdout.write(c.dim("    turn end (" + ev.data.stopReason + ")\n"));
    }
  };
}

function printScenarioResult(result, passNumber)
{
  if (result.skipped)
  {
    process.stdout.write("  " + c.yellow("SKIP") + " " + result.name + " " + c.dim("(" + result.skipReason + ")") + "\n\n");
    return;
  }

  const passed = result.checks.filter(function (k) { return k.ok; }).length;
  const knownFails = result.checks.filter(function (k) { return !k.ok && k.known; }).length;
  const total = result.checks.length;
  const allOk = total > 0 && passed + knownFails === total && !result.error;
  const head = allOk ? (knownFails > 0 ? c.yellow("PASS") : c.green("PASS")) : c.red("FAIL");

  process.stdout.write("  " + head + " " + c.bold(result.name) +
    (passNumber ? c.dim(" #" + passNumber) : "") + " " +
    c.dim(passed + "/" + total + " checks" +
      (knownFails > 0 ? " (" + knownFails + " known limit)" : "") + ", " + secs(result.ms) +
      ", " + result.usage.completion + " out tok") + "\n");

  if (result.detected)
  {
    process.stdout.write("       " + c.dim("detected: " + result.detected.kind + " | build: " +
      (result.detected.build || "-") + " | test: " + (result.detected.test || "-")) + "\n");
  }
  else
  {
    process.stdout.write("       " + c.yellow("detected: (nothing)") + "\n");
  }

  for (let i = 0; i < result.checks.length; i++)
  {
    const k = result.checks[i];
    const mark = k.ok ? c.green("+") : (k.known ? c.dim("~") : c.red("-"));
    const detail = k.ok || !k.detail ? "" : c.dim("  " + oneLine(k.detail, 120));
    process.stdout.write("       " + mark + " " + k.label + detail + "\n");
  }

  if (result.error)
  {
    process.stdout.write("       " + c.red("error: " + result.error) + "\n");
  }

  if (result.friction.length > 0)
  {
    process.stdout.write("       " + c.yellow("friction: " + result.friction.length) + "\n");
    const shown = result.friction.slice(0, 6);
    for (let i = 0; i < shown.length; i++)
    {
      process.stdout.write("         " + c.dim("[" + shown[i].kind + "] " + (shown[i].tool ? shown[i].tool + ": " : "") +
        oneLine(shown[i].summary || shown[i].detail, 130)) + "\n");
    }
  }

  process.stdout.write("\n");
}

function frictionTally(results)
{
  const tally = new Map();
  for (let i = 0; i < results.length; i++)
  {
    const items = results[i].friction || [];
    for (let j = 0; j < items.length; j++)
    {
      const key = items[j].kind + " | " + (items[j].tool || "-") + " | " + oneLine(items[j].summary, 80);
      const cur = tally.get(key) || { count: 0, sample: items[j], scenarios: new Set() };
      cur.count++;
      cur.scenarios.add(results[i].name);
      tally.set(key, cur);
    }
  }
  return Array.from(tally.entries())
    .map(function (e)
    {
      return { key: e[0], count: e[1].count, sample: e[1].sample, scenarios: Array.from(e[1].scenarios) };
    })
    .sort(function (a, b)
    {
      return b.count - a.count;
    });
}

function printSummary(results, meta, verdict, base)
{
  const ran = results.filter(function (r) { return !r.skipped; });
  const passed = ran.filter(function (r)
  {
    return r.checks.length > 0 &&
      r.checks.every(function (k) { return k.ok || k.known; }) && !r.error;
  });

  process.stdout.write(c.bold("\n=== summary ===\n"));
  process.stdout.write("  model:     " + meta.model + "\n");
  process.stdout.write("  scenarios: " + passed.length + "/" + ran.length + " passed" +
    (results.length - ran.length > 0 ? ", " + (results.length - ran.length) + " skipped" : "") + "\n");

  // A bare total invites being read as a score. Saying what the baseline
  // expects next to it is what stops a normal run looking like a regression.
  if (verdict && base)
  {
    const runs = verdict.rows.length;
    process.stdout.write("  expected:  " + verdict.expectedTotal.toFixed(1) + "/" + runs +
      c.dim("  (from the recorded baseline; the spread is real, not a score)") + "\n");
  }
  else if (verdict)
  {
    process.stdout.write("  baseline:  " + c.yellow("none recorded") +
      c.dim("  - run: node tests/run.js --repeat 3 --save-baseline") + "\n");
  }

  process.stdout.write("  wall:      " + secs(results.reduce(function (a, r) { return a + r.ms; }, 0)) + "\n");

  if (verdict && base)
  {
    if (verdict.regressed.length > 0)
    {
      process.stdout.write(c.bold("\n  regressed, these have been reliable\n"));
      for (let i = 0; i < verdict.regressed.length; i++)
      {
        const r = verdict.regressed[i];
        process.stdout.write("    " + c.red("- ") + r.name +
          c.dim("  now " + r.pass + "/" + r.runs + ", baseline " + Math.round(r.was * 100) + "%") + "\n");
      }
    }

    if (verdict.recovered.length > 0)
    {
      process.stdout.write(c.bold("\n  passed for the first time\n"));
      for (let i = 0; i < verdict.recovered.length; i++)
      {
        const r = verdict.recovered[i];
        process.stdout.write("    " + c.green("+ ") + r.name +
          c.dim("  now " + r.pass + "/" + r.runs + ", baseline never passed") + "\n");
      }
    }

    const noisy = verdict.expected.filter(function (r) { return r.rate < 1; });
    if (noisy.length > 0)
    {
      process.stdout.write(c.bold("\n  failed within their usual rate, not news\n"));
      for (let i = 0; i < noisy.length; i++)
      {
        const r = noisy[i];
        process.stdout.write("    " + c.dim("~ " + r.name + "  now " + r.pass + "/" + r.runs +
          ", baseline " + Math.round(r.was * 100) + "%") + "\n");
      }
    }

    if (verdict.unknown.length > 0)
    {
      process.stdout.write(c.bold("\n  no baseline yet\n"));
      for (let i = 0; i < verdict.unknown.length; i++)
      {
        process.stdout.write("    " + c.dim("? " + verdict.unknown[i].name) + "\n");
      }
    }
  }

  const failedChecks = [];
  const knownChecks = [];
  const liftedChecks = [];
  for (let i = 0; i < ran.length; i++)
  {
    for (let j = 0; j < ran[i].checks.length; j++)
    {
      const k = ran[i].checks[j];
      const line = ran[i].name + ": " + k.label +
        (k.detail ? "  (" + oneLine(k.detail, 160) + ")" : "");
      if (!k.ok && k.known)
      {
        knownChecks.push(line + "  [" + k.known + "]");
      }
      else if (!k.ok)
      {
        failedChecks.push(line);
      }
      else if (k.known)
      {
        liftedChecks.push(ran[i].name + ": " + k.label);
      }
    }
  }

  if (failedChecks.length > 0)
  {
    process.stdout.write(c.bold("\n  failed checks\n"));
    for (let i = 0; i < failedChecks.length; i++)
    {
      process.stdout.write("    " + c.red("- ") + failedChecks[i] + "\n");
    }
  }

  if (knownChecks.length > 0)
  {
    process.stdout.write(c.bold("\n  known limits, not counted as failures\n"));
    for (let i = 0; i < knownChecks.length; i++)
    {
      process.stdout.write("    " + c.dim("~ ") + knownChecks[i] + "\n");
    }
  }

  // A limit that stops reproducing is worth saying out loud: it is either fixed
  // or it was never a limit.
  if (liftedChecks.length > 0)
  {
    process.stdout.write(c.bold("\n  known limits that passed this run\n"));
    for (let i = 0; i < liftedChecks.length; i++)
    {
      process.stdout.write("    " + c.green("+ ") + liftedChecks[i] + "\n");
    }
  }

  const tally = frictionTally(results);
  if (tally.length > 0)
  {
    process.stdout.write(c.bold("\n  friction, most frequent first\n"));
    for (let i = 0; i < Math.min(tally.length, 20); i++)
    {
      process.stdout.write("    " + c.yellow(String(tally[i].count).padStart(3)) + "x " +
        tally[i].key + c.dim("  [" + tally[i].scenarios.join(", ") + "]") + "\n");
    }
  }

  process.stdout.write("\n");
}

function markdown(results, meta)
{
  const lines = [];
  lines.push("# oh-my-qwen scenario run");
  lines.push("");
  lines.push("- model: `" + meta.model + "`");
  lines.push("- base: `" + meta.baseUrl + "`");
  lines.push("- started: " + meta.startedAt);
  lines.push("- rounds/turn: " + meta.rounds + ", max tokens: " + meta.maxTokens + ", context budget: " + meta.contextTokens);
  lines.push("");
  lines.push("| scenario | checks | detected | tools | out tok | time |");
  lines.push("| --- | --- | --- | --- | --- | --- |");

  for (let i = 0; i < results.length; i++)
  {
    const r = results[i];
    if (r.skipped)
    {
      lines.push("| " + r.name + " | skipped | - | - | - | " + r.skipReason + " |");
      continue;
    }
    const passed = r.checks.filter(function (k) { return k.ok; }).length;
    const knownFails = r.checks.filter(function (k) { return !k.ok && k.known; }).length;
    const toolCount = r.turns.reduce(function (a, t) { return a + t.tools.length; }, 0);
    lines.push("| " + r.name + " | " + passed + "/" + r.checks.length +
      (knownFails > 0 ? " (+" + knownFails + " known)" : "") + " | " +
      (r.detected ? r.detected.kind : "(none)") + " | " + toolCount + " | " +
      r.usage.completion + " | " + secs(r.ms) + " |");
  }

  lines.push("");
  lines.push("## details");

  for (let i = 0; i < results.length; i++)
  {
    const r = results[i];
    lines.push("");
    lines.push("### " + r.name + " - " + r.title);
    if (r.skipped)
    {
      lines.push("");
      lines.push("skipped: " + r.skipReason);
      continue;
    }
    lines.push("");
    lines.push("detected: `" + (r.detected ? JSON.stringify(r.detected) : "null") + "`");
    lines.push("");

    for (let t = 0; t < r.turns.length; t++)
    {
      const turn = r.turns[t];
      lines.push("**turn " + (t + 1) + "** (" + turn.stopReason + (turn.timedOut ? ", harness timeout" : "") +
        ", " + secs(turn.ms) + ")  ");
      lines.push("prompt: " + JSON.stringify(turn.prompt));
      lines.push("");
      for (let j = 0; j < turn.tools.length; j++)
      {
        const call = turn.tools[j];
        lines.push("- `" + call.name + "` " + oneLine(call.label, 100) + " -> " +
          (call.ok === false ? "**FAIL** " : "") + oneLine(call.summary, 120));
      }
      if (turn.texts.length > 0)
      {
        lines.push("");
        lines.push("> " + oneLine(turn.texts[turn.texts.length - 1], 600));
      }
      lines.push("");
    }

    lines.push("checks:");
    for (let j = 0; j < r.checks.length; j++)
    {
      lines.push("- " + (r.checks[j].ok ? "PASS" : (r.checks[j].known ? "KNOWN" : "**FAIL**")) + " " + r.checks[j].label +
        (r.checks[j].detail ? " - " + oneLine(r.checks[j].detail, 300) : ""));
    }
    if (r.error)
    {
      lines.push("");
      lines.push("error: `" + r.error + "`");
    }
    if (r.friction.length > 0)
    {
      lines.push("");
      lines.push("friction:");
      for (let j = 0; j < r.friction.length; j++)
      {
        lines.push("- [" + r.friction[j].kind + "] " + (r.friction[j].tool ? "`" + r.friction[j].tool + "` " : "") +
          oneLine(r.friction[j].summary || r.friction[j].detail, 300));
      }
    }
  }

  const tally = frictionTally(results);
  if (tally.length > 0)
  {
    lines.push("");
    lines.push("## friction tally");
    lines.push("");
    for (let i = 0; i < tally.length; i++)
    {
      lines.push("- " + tally[i].count + "x " + tally[i].key + "  [" + tally[i].scenarios.join(", ") + "]");
    }
  }

  return lines.join("\n") + "\n";
}

function writeMarkdown(file, results, meta)
{
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown(results, meta), "utf8");
  return file;
}

module.exports =
{
  c: c,
  liveLogger: liveLogger,
  printScenarioResult: printScenarioResult,
  printSummary: printSummary,
  writeMarkdown: writeMarkdown,
  frictionTally: frictionTally
};
