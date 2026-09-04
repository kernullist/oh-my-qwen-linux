"use strict";

// Detects the native Ubuntu build tools once per process. The result is used
// only for project defaults and prompt guidance; commands still run inside the
// registered workspace through /bin/bash.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function commandPath(name)
{
  const dirs = String(process.env.PATH || "").split(path.delimiter);
  for (let i = 0; i < dirs.length; i++)
  {
    if (!dirs[i])
    {
      continue;
    }
    const candidate = path.join(dirs[i], name);
    try
    {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0)
      {
        return candidate;
      }
    }
    catch (err)
    {
      // Keep looking through PATH.
    }
  }
  return null;
}

function firstLine(file, args)
{
  if (!file)
  {
    return "";
  }
  try
  {
    const res = spawnSync(file, args || ["--version"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
    const text = String(res.stdout || res.stderr || "").trim();
    return text.split(/\r?\n/)[0].slice(0, 200);
  }
  catch (err)
  {
    return "";
  }
}

let cache;

function detect()
{
  if (cache !== undefined)
  {
    return cache;
  }

  const gcc = commandPath("gcc");
  const gxx = commandPath("g++");
  const clang = commandPath("clang");
  const clangxx = commandPath("clang++");
  const cc = gcc || clang || commandPath("cc");
  const cxx = gxx || clangxx || commandPath("c++");

  cache =
  {
    cc: cc,
    cxx: cxx,
    compiler: cxx || cc,
    compilerVersion: firstLine(cxx || cc),
    cmake: commandPath("cmake"),
    ninja: commandPath("ninja"),
    make: commandPath("make")
  };
  return cache;
}

function promptLines()
{
  const found = detect();
  const lines = [];

  lines.push("Each run_command starts a fresh non-interactive Bash process. `cd`, aliases, shell variables and exports do not carry over to the next call; combine dependent setup and use with && in one command.");

  if (found.compiler)
  {
    lines.push("A native C/C++ compiler is available: " + (found.compilerVersion || found.compiler) + ".");
    lines.push("Prefer the project's CMake or Make build over compiling individual source files. For a source-only folder, the app uses " + (found.cxx || found.cc) + " with warnings enabled.");
  }
  else
  {
    lines.push("No C/C++ compiler was detected. If native compilation is required, ask the user to install build-essential (or clang) instead of guessing tool paths.");
  }

  const buildTools = [];
  if (found.cmake) { buildTools.push("cmake"); }
  if (found.ninja) { buildTools.push("ninja"); }
  if (found.make) { buildTools.push("make"); }
  if (buildTools.length > 0)
  {
    lines.push("Detected build tools: " + buildTools.join(", ") + ".");
  }

  return lines;
}

module.exports =
{
  detect: detect,
  commandPath: commandPath,
  promptLines: promptLines
};
