"use strict";

// Scenario harness entry point.
//
//   node tests/run.js --list
//   node tests/run.js --only cpp
//   node tests/run.js --tags encoding,build --keep
//
// Each scenario builds a throwaway project, hands the real agent loop a request,
// and then inspects the folder itself. Config and chat history go to a scratch
// data directory so a run never touches the installed app's settings.

const path = require("path");
const os = require("os");
const fs = require("fs");

// Listing is often piped through head or a pager. Treat the reader closing the
// pipe as a normal early finish instead of crashing with an unhandled EPIPE.
process.stdout.on("error", function (err)
{
  if (err && err.code === "EPIPE")
  {
    process.exit(0);
  }
  throw err;
});

const HARNESS_DATA = path.join(os.tmpdir(), "omq-harness-data");
if (!process.env.OMQ_DATA_DIR)
{
  process.env.OMQ_DATA_DIR = HARNESS_DATA;
}

const lmstudio = require("../src/lmstudio");
const driver = require("./lib/driver");
const baseline = require("./lib/baseline");
const report = require("./lib/report");
const scenarios = require("./scenarios");

function parseArgs(argv)
{
  const out =
  {
    only: [],
    tags: [],
    list: false,
    model: "",
    baseUrl: "http://localhost:1234",
    rounds: 20,
    maxTokens: 3072,
    contextTokens: 0,
    turnTimeoutSec: 900,
    keep: false,
    verbose: false,
    out: path.join(process.cwd(), "tests", "reports", "last-run.md"),
    repeat: 1,
    saveBaseline: false,
    noBaseline: false
  };

  for (let i = 2; i < argv.length; i++)
  {
    const a = argv[i];
    const next = function ()
    {
      i++;
      return argv[i];
    };

    if (a === "--only")
    {
      out.only = out.only.concat(String(next() || "").split(","));
    }
    else if (a === "--tags")
    {
      out.tags = out.tags.concat(String(next() || "").split(","));
    }
    else if (a === "--list")
    {
      out.list = true;
    }
    else if (a === "--model")
    {
      out.model = next();
    }
    else if (a === "--base")
    {
      out.baseUrl = next();
    }
    else if (a === "--rounds")
    {
      out.rounds = parseInt(next(), 10);
    }
    else if (a === "--max-tokens")
    {
      out.maxTokens = parseInt(next(), 10);
    }
    else if (a === "--context")
    {
      out.contextTokens = parseInt(next(), 10);
    }
    else if (a === "--turn-timeout")
    {
      out.turnTimeoutSec = parseInt(next(), 10);
    }
    else if (a === "--save-baseline")
    {
      out.saveBaseline = true;
    }
    else if (a === "--no-baseline")
    {
      out.noBaseline = true;
    }
    else if (a === "--repeat")
    {
      out.repeat = Math.max(1, parseInt(next(), 10) || 1);
    }
    else if (a === "--keep")
    {
      out.keep = true;
    }
    else if (a === "--verbose")
    {
      out.verbose = true;
    }
    else if (a === "--out")
    {
      out.out = path.resolve(next());
    }
    else
    {
      process.stdout.write("unknown option: " + a + "\n");
      process.exit(2);
    }
  }

  out.only = out.only.map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  out.tags = out.tags.map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  return out;
}

function selectScenarios(all, opts)
{
  return all.filter(function (s)
  {
    if (opts.only.length > 0)
    {
      const hit = opts.only.some(function (frag)
      {
        return s.name.toLowerCase().indexOf(frag) >= 0;
      });
      if (!hit)
      {
        return false;
      }
    }
    if (opts.tags.length > 0)
    {
      const tags = (s.tags || []).map(function (t) { return String(t).toLowerCase(); });
      const hit = opts.tags.some(function (t)
      {
        return tags.indexOf(t) >= 0;
      });
      if (!hit)
      {
        return false;
      }
    }
    return true;
  });
}

async function pickModel(opts)
{
  let listing = null;
  try
  {
    listing = await lmstudio.listModels(opts.baseUrl);
  }
  catch (err)
  {
    process.stdout.write(report.c.red("LM Studio is not reachable at " + opts.baseUrl + ": " + err.message) + "\n");
    process.exit(1);
  }

  const models = listing.models;
  if (opts.model)
  {
    const found = models.filter(function (m) { return m.id === opts.model; })[0];
    return { id: opts.model, loadedContext: found ? found.loadedContext : 0, maxContext: found ? found.maxContext : 0 };
  }

  const tooled = models.filter(function (m)
  {
    return m.capabilities.indexOf("tool_use") >= 0;
  });
  const loaded = tooled.filter(function (m)
  {
    return m.state === "loaded";
  });
  const pick = loaded[0] || tooled[0] || models[0];

  if (!pick)
  {
    process.stdout.write(report.c.red("no models available from " + opts.baseUrl) + "\n");
    process.exit(1);
  }

  return { id: pick.id, loadedContext: pick.loadedContext, maxContext: pick.maxContext };
}

async function main()
{
  const opts = parseArgs(process.argv);
  const all = scenarios.all();

  if (opts.list)
  {
    process.stdout.write("scenarios (" + all.length + ")\n\n");
    for (let i = 0; i < all.length; i++)
    {
      process.stdout.write("  " + all[i].name.padEnd(26) + " [" + (all[i].tags || []).join(",") + "]  " +
        (all[i].title || "") + "\n");
    }
    process.stdout.write("\n");
    return;
  }

  const chosen = selectScenarios(all, opts);
  if (chosen.length === 0)
  {
    process.stdout.write("no scenario matched\n");
    process.exit(2);
  }

  const model = await pickModel(opts);

  // Asking for a bigger history than the model actually has loaded makes LM
  // Studio silently drop the front of the conversation, which looks like the
  // model forgetting instructions. Stay under it.
  let contextTokens = opts.contextTokens;
  if (!contextTokens)
  {
    // 0.62 was chosen while the tool schema was not counted in the budget, so
    // the app was quietly spending about 2,800 tokens more than this number
    // said. Counting it made the same figure strictly tighter, and the one
    // scenario that carries a conversation across three turns went from passing
    // every run to passing one in three. Raised to leave the app roughly the
    // room it actually had before, with headroom for the estimate being rough.
    contextTokens = model.loadedContext > 0 ? Math.max(4000, Math.floor(model.loadedContext * 0.70)) : 12000;
  }

  const meta =
  {
    model: model.id,
    baseUrl: opts.baseUrl,
    startedAt: new Date().toISOString(),
    rounds: opts.rounds,
    maxTokens: opts.maxTokens,
    contextTokens: contextTokens
  };

  process.stdout.write(report.c.bold("oh-my-qwen scenario harness") + "\n");
  process.stdout.write("  model:   " + model.id +
    (model.loadedContext ? "  (loaded context " + model.loadedContext + ")" : "  (not loaded)") + "\n");
  process.stdout.write("  budget:  context " + contextTokens + ", max tokens " + opts.maxTokens +
    ", rounds " + opts.rounds + "\n");
  process.stdout.write("  data:    " + process.env.OMQ_DATA_DIR + "\n");
  process.stdout.write("  running: " + chosen.length + " scenario(s)" +
    (opts.repeat > 1 ? " x" + opts.repeat : "") + "\n\n");

  const results = [];

  for (let pass = 0; pass < opts.repeat; pass++)
  {
    for (let i = 0; i < chosen.length; i++)
    {
      const scenario = chosen[i];
      const label = scenario.name + (opts.repeat > 1 ? "#" + (pass + 1) : "");
      process.stdout.write(report.c.bold("[" + (i + 1) + "/" + chosen.length + "] " + label) + " " +
        report.c.dim(scenario.title || "") + "\n");

      // The name stays the scenario's own; the pass number lives beside it so
      // repeats can be collapsed into one rate instead of counted as N
      // separate scenarios that happen to share a fixture.
      const runnable = scenario;

      const result = await driver.runScenario(runnable,
      {
        model: model.id,
        baseUrl: opts.baseUrl,
        rounds: opts.rounds,
        maxTokens: opts.maxTokens,
        contextTokens: contextTokens,
        turnTimeoutMs: opts.turnTimeoutSec * 1000,
        keep: opts.keep,
        onEvent: report.liveLogger({ verbose: opts.verbose })
      });

      result.pass = pass + 1;
      results.push(result);
      report.printScenarioResult(result, opts.repeat > 1 ? (pass + 1) : 0);
    }
  }

  const rates = baseline.rates(results);
  const base = opts.noBaseline ? null : baseline.load();
  const verdict = baseline.compare(rates, base);

  report.printSummary(results, meta, verdict, base);

  if (opts.saveBaseline)
  {
    const written = baseline.save(rates, { model: model.id, runs: opts.repeat });
    process.stdout.write("\nbaseline written: " + written + "  (" +
      Object.keys(rates).length + " scenario(s) x " + opts.repeat + " run(s))\n");
  }

  const file = report.writeMarkdown(opts.out, results, meta);
  process.stdout.write("report: " + file + "\n");

  fs.writeFileSync(opts.out.replace(/\.md$/, "") + ".json", JSON.stringify(results, null, 2), "utf8");

  // With a baseline, red means "something that was reliable broke", not "a
  // scenario that fails a third of the time failed again". Without one, every
  // failure counts, which is the old behaviour.
  if (base)
  {
    process.exit(verdict.regressed.length > 0 ? 1 : 0);
  }

  const ran = results.filter(function (r) { return !r.skipped; });
  const failed = ran.filter(function (r)
  {
    return r.error || r.checks.length === 0 ||
      r.checks.some(function (k) { return !k.ok && !k.known; });
  });
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(function (err)
{
  process.stdout.write(report.c.red("harness crashed: " + (err && err.stack ? err.stack : err)) + "\n");
  process.exit(3);
});
