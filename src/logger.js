"use strict";

// File logging for the windowless build.
//
// The single-file exe is a GUI subsystem binary, so a double-clicked instance
// has no console at all: every console.log goes nowhere and a crash leaves no
// trace. Everything the app prints is mirrored into a log file next to the
// settings, and an uncaught error is written there before the process dies.

const fs = require("fs");
const path = require("path");
const util = require("util");
const config = require("./config");

const MAX_BYTES = 2 * 1024 * 1024;
const LOG_NAME = "oh-my-qwen.log";

let stream = null;
let installed = false;

function logPath()
{
  return path.join(config.appDir(), LOG_NAME);
}

// Keeps one previous file. A long-running instance should not grow without
// bound, and two files is enough to see what happened before a restart.
function rotate(file)
{
  try
  {
    const stat = fs.statSync(file);
    if (stat.size < MAX_BYTES)
    {
      return;
    }
    fs.renameSync(file, file + ".1");
  }
  catch (err)
  {
    // No file yet, or it is locked by a viewer. Either way, keep appending.
  }
}

function stamp()
{
  const d = new Date();
  const pad = function (n, width)
  {
    return String(n).padStart(width || 2, "0");
  };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
    pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + pad(d.getMilliseconds(), 3);
}

function writeLine(level, text)
{
  if (!stream)
  {
    return;
  }
  try
  {
    stream.write(stamp() + " " + level + " " + text + "\n");
  }
  catch (err)
  {
    // A full disk must not take the server down with it.
  }
}

function format(args)
{
  const parts = [];
  for (let i = 0; i < args.length; i++)
  {
    const a = args[i];
    if (typeof a === "string")
    {
      parts.push(a);
    }
    else if (a instanceof Error)
    {
      parts.push(a.stack || a.message);
    }
    else
    {
      try
      {
        parts.push(JSON.stringify(a));
      }
      catch (err)
      {
        // A circular object throws in JSON.stringify, and String() on it gives
        // "[object Object]" - nothing at all, in the one file that explains why
        // a windowless build died. inspect() renders the cycle instead.
        parts.push(util.inspect(a, { depth: 3, breakLength: Infinity }));
      }
    }
  }
  return parts.join(" ");
}

// With no console attached, fd 1 and 2 are not writable. Node usually turns
// those into harmless no-ops, but an EBADF surfacing as an unhandled error
// event would kill the process, so swallow it explicitly.
function silenceDeadStdio()
{
  const guard = function (streamObj)
  {
    if (streamObj && typeof streamObj.on === "function")
    {
      streamObj.on("error", function ()
      {
        // nowhere to report this, and it must not be fatal
      });
    }
  };
  guard(process.stdout);
  guard(process.stderr);
}

function install()
{
  if (installed)
  {
    return logPath();
  }
  installed = true;

  silenceDeadStdio();

  const file = logPath();
  try
  {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotate(file);
    stream = fs.createWriteStream(file, { flags: "a" });
    stream.on("error", function ()
    {
      stream = null;
    });
  }
  catch (err)
  {
    stream = null;
  }

  const levels = [["log", "INFO "], ["warn", "WARN "], ["error", "ERROR"]];
  for (let i = 0; i < levels.length; i++)
  {
    const name = levels[i][0];
    const label = levels[i][1];
    const original = console[name].bind(console);

    console[name] = function ()
    {
      writeLine(label, format(arguments));
      try
      {
        original.apply(null, arguments);
      }
      catch (err)
      {
        // no console to print to
      }
    };
  }

  // A windowless process that dies silently is impossible to diagnose. Record
  // the reason, then exit the way an uncaught exception normally would.
  process.on("uncaughtException", function (err)
  {
    const detail = "uncaught exception: " + (err && err.stack ? err.stack : String(err));

    // Written synchronously: the stream's queued write would not survive the
    // process.exit below, and this is the one line that has to be there.
    try
    {
      fs.appendFileSync(file, stamp() + " FATAL " + detail + "\n");
    }
    catch (e)
    {
      // nothing left to try
    }

    // Node's default handler prints the stack; installing ours replaced that,
    // and a terminal or the portable launcher would show nothing at all.
    try
    {
      process.stderr.write(detail + "\n");
    }
    catch (e)
    {
      // no console attached, which is exactly what the log file is for
    }

    process.exit(1);
  });

  process.on("unhandledRejection", function (reason)
  {
    writeLine("ERROR", "unhandled rejection: " + (reason && reason.stack ? reason.stack : String(reason)));
  });

  return file;
}

module.exports =
{
  install: install,
  logPath: logPath
};
