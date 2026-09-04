"use strict";

// Per-scenario pass rates, and what a single run is allowed to mean.
//
// The suite reported one pass/fail per scenario per run, but for a good number
// of them the underlying quantity is a probability, not a fact. Measured over
// six stored full-suite runs: 22 scenarios always passed, 11 landed anywhere
// between 33% and 83%, and the expected total on any single run was 29.2 of 36.
// So a run coming back 28 and a run coming back 31 are the same run, and twice
// in one session that band was read as a regression and chased.
//
// A baseline turns the total back into an instrument: a scenario that has never
// failed and fails now is worth looking at, and a scenario that passes a third
// of the time failing again is not news.

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "reports", "baseline.json");

// Below this, a single failure says nothing: the scenario fails on its own
// often enough that one more instance carries no information.
const RELIABLE = 0.9;

function load(file)
{
  const target = file || FILE;
  try
  {
    const raw = JSON.parse(fs.readFileSync(target, "utf8"));
    return raw && raw.scenarios ? raw : null;
  }
  catch (err)
  {
    return null;
  }
}

function save(rates, meta, file)
{
  const target = file || FILE;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(
    {
      model: (meta && meta.model) || "",
      recordedRuns: (meta && meta.runs) || 0,
      note: "Written by: node tests/run.js --repeat N --save-baseline",
      scenarios: rates
    }, null, 2), "utf8");
  return target;
}

// Collapses repeats of the same scenario into one row.
function rates(results)
{
  const out = {};

  for (let i = 0; i < results.length; i++)
  {
    const r = results[i];
    if (!r || r.skipped)
    {
      continue;
    }

    const name = baseName(r.name);
    if (!out[name])
    {
      out[name] = { pass: 0, runs: 0, checks: 0, checksPassed: 0 };
    }

    const row = out[name];
    row.runs++;
    if (scenarioPassed(r))
    {
      row.pass++;
    }
    row.checks += (r.checks || []).length;
    row.checksPassed += (r.checks || []).filter(function (k) { return k.ok; }).length;
  }

  const names = Object.keys(out);
  for (let i = 0; i < names.length; i++)
  {
    const row = out[names[i]];
    row.rate = row.runs > 0 ? row.pass / row.runs : 0;
  }

  return out;
}

// "cmake-fix-and-test#3" and "cmake-fix-and-test" are the same scenario.
function baseName(name)
{
  return String(name || "").replace(/#\d+$/, "");
}

function scenarioPassed(result)
{
  if (!result || result.error || !Array.isArray(result.checks) || result.checks.length === 0)
  {
    return false;
  }
  return result.checks.every(function (k) { return k.ok || k.known; });
}

// What this run says, given what the baseline knows.
//
//   regressed  a scenario that has been reliable failed
//   recovered  a scenario that has never passed did
//   expected   a flaky scenario doing what flaky scenarios do
//   unknown    no baseline entry, so nothing can be said yet
function compare(current, base)
{
  const known = (base && base.scenarios) || {};
  const out = { regressed: [], recovered: [], expected: [], unknown: [], expectedTotal: 0, rows: [] };

  const names = Object.keys(current).sort();
  for (let i = 0; i < names.length; i++)
  {
    const name = names[i];
    const now = current[name];
    const was = known[name];

    const row = { name: name, rate: now.rate, pass: now.pass, runs: now.runs, was: was ? was.rate : null };
    out.rows.push(row);

    if (!was)
    {
      out.unknown.push(row);
      out.expectedTotal += now.rate;
      continue;
    }

    out.expectedTotal += was.rate;

    if (was.rate >= RELIABLE && now.rate < 1)
    {
      out.regressed.push(row);
      continue;
    }
    if (was.rate === 0 && now.rate > 0)
    {
      out.recovered.push(row);
      continue;
    }
    out.expected.push(row);
  }

  return out;
}

module.exports =
{
  FILE: FILE,
  RELIABLE: RELIABLE,
  load: load,
  save: save,
  rates: rates,
  compare: compare,
  baseName: baseName,
  scenarioPassed: scenarioPassed
};
