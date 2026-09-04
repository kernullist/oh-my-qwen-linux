"use strict";

// Native Ubuntu folder chooser. GNOME installs commonly provide zenity and
// KDE installs commonly provide kdialog. Headless systems can still type the
// path in the browser UI.

const { spawn } = require("child_process");
const toolchain = require("./toolchain");

let backendCache;
let pending = null;

function resolveBackend()
{
  if (backendCache !== undefined)
  {
    return backendCache;
  }

  backendCache = null;
  if (process.platform !== "linux" || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY))
  {
    return backendCache;
  }

  const zenity = toolchain.commandPath("zenity");
  if (zenity)
  {
    backendCache = { name: "zenity", file: zenity };
    return backendCache;
  }

  const kdialog = toolchain.commandPath("kdialog");
  if (kdialog)
  {
    backendCache = { name: "kdialog", file: kdialog };
  }
  return backendCache;
}

function buildArgs(name, startDir)
{
  if (name === "zenity")
  {
    const args = ["--file-selection", "--directory", "--title=oh-my-qwen: select the working folder"];
    if (startDir)
    {
      args.push("--filename=" + String(startDir).replace(/\/+$/, "") + "/");
    }
    return args;
  }

  const args = ["--getexistingdirectory", startDir || process.cwd(), "--title", "oh-my-qwen: select the working folder"];
  return args;
}

function interpretDialogOutput(out, errOut, code, backend)
{
  const picked = String(out || "").split(/\r?\n/).map(function (line)
  {
    return line.trim();
  }).filter(Boolean).pop();
  const message = String(errOut || "").trim();

  if (code === 0 && picked)
  {
    return { ok: true, path: picked, backend: backend };
  }
  if ((code === 0 || code === 1) && !picked && !message)
  {
    return { ok: false, reason: "cancelled", message: "", backend: backend };
  }
  return {
    ok: false,
    reason: "dialog_failed",
    message: (message || ("exit code " + code)).slice(0, 300),
    backend: backend
  };
}

function runDialog(backend, startDir)
{
  return new Promise(function (resolve)
  {
    let child;
    try
    {
      child = spawn(backend.file, buildArgs(backend.name, startDir),
        { stdio: ["ignore", "pipe", "pipe"] });
    }
    catch (err)
    {
      resolve({ ok: false, reason: "spawn_failed", message: err.message, backend: backend.name });
      return;
    }

    let out = "";
    let errOut = "";
    let settled = false;
    const settle = function (result)
    {
      if (!settled)
      {
        settled = true;
        resolve(result);
      }
    };

    child.stdout.on("data", function (data) { out += data.toString("utf8"); });
    child.stderr.on("data", function (data) { errOut += data.toString("utf8"); });
    child.on("error", function (err)
    {
      settle({ ok: false, reason: "spawn_failed", message: err.message, backend: backend.name });
    });
    child.on("close", function (code)
    {
      settle(interpretDialogOutput(out, errOut, code, backend.name));
    });
  });
}

function pickFolder(startDir)
{
  if (pending)
  {
    return Promise.resolve({
      ok: false,
      reason: "already_open",
      message: "폴더 선택 창이 이미 열려 있습니다. 그 창에서 선택하거나 취소해 주세요."
    });
  }

  const backend = resolveBackend();
  if (!backend)
  {
    return Promise.resolve({
      ok: false,
      reason: "unavailable",
      message: "GUI 폴더 선택기를 찾을 수 없습니다. zenity 또는 kdialog를 설치하거나 경로를 직접 입력해 주세요."
    });
  }

  pending = runDialog(backend, startDir);
  return pending.finally(function ()
  {
    pending = null;
  });
}

module.exports =
{
  pickFolder: pickFolder,
  resolveBackend: resolveBackend,
  buildArgs: buildArgs,
  interpretDialogOutput: interpretDialogOutput
};
