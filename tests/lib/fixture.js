"use strict";

// Fixture helpers for the scenario harness.
//
// Test projects are written to a scratch directory with deliberate encoding and
// line-ending variety, because that is where Windows tooling actually breaks.
// Everything here is dependency free and mirrors what src/tools.js has to cope
// with when the model reads or rewrites these files.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function mkdirp(dir)
{
  fs.mkdirSync(dir, { recursive: true });
}

function applyEol(text, eol)
{
  const lf = String(text).replace(/\r\n/g, "\n");
  if (eol === "crlf")
  {
    return lf.replace(/\n/g, "\r\n");
  }
  return lf;
}

// CP949 has no encoder in Node, so hand the bytes to Windows PowerShell 5.1,
// which still ships the full .NET Framework code page table.
function encodeLegacy(text, codepage)
{
  if (process.platform !== "win32")
  {
    const target = Number(codepage) === 949 ? "CP949" : ("CP" + codepage);
    const converted = spawnSync("iconv", ["-f", "UTF-8", "-t", target],
    {
      input: Buffer.from(text, "utf8"),
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    if (converted.status !== 0 || !converted.stdout)
    {
      throw new Error("legacy encode failed for cp" + codepage + ": " + String(converted.stderr || "").trim());
    }
    return Buffer.from(converted.stdout);
  }

  const b64 = Buffer.from(text, "utf8").toString("base64");
  const script =
    "$ErrorActionPreference='Stop';" +
    "$bytes=[Convert]::FromBase64String('" + b64 + "');" +
    "$text=[System.Text.Encoding]::UTF8.GetString($bytes);" +
    "$enc=[System.Text.Encoding]::GetEncoding(" + codepage + ");" +
    "[Convert]::ToBase64String($enc.GetBytes($text))";

  const res = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
  {
    encoding: "utf8",
    windowsHide: true
  });

  if (res.status !== 0 || !res.stdout)
  {
    throw new Error("legacy encode failed for cp" + codepage + ": " + String(res.stderr || "").trim());
  }
  return Buffer.from(res.stdout.trim(), "base64");
}

function encodeAs(text, encoding)
{
  if (encoding === "utf8bom")
  {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  }
  if (encoding === "utf16le")
  {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  }
  if (encoding === "utf16be")
  {
    const le = Buffer.from(text, "utf16le");
    const be = Buffer.alloc(le.length);
    for (let i = 0; i + 1 < le.length; i += 2)
    {
      be[i] = le[i + 1];
      be[i + 1] = le[i];
    }
    return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
  }
  if (encoding === "cp949")
  {
    return encodeLegacy(text, 949);
  }
  return Buffer.from(text, "utf8");
}

// write(root, "src/main.cpp", text, { eol: "crlf", encoding: "utf8bom" })
function write(root, rel, text, opts)
{
  const options = opts || {};
  const target = path.join(root, rel);
  mkdirp(path.dirname(target));
  const body = applyEol(text, options.eol || "lf");
  fs.writeFileSync(target, encodeAs(body, options.encoding || "utf8"));
  return target;
}

function writeBinary(root, rel, buf)
{
  const target = path.join(root, rel);
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, buf);
  return target;
}

function decode(buf)
{
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
  {
    return { text: buf.slice(3).toString("utf8"), encoding: "utf8bom" };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
  {
    return { text: buf.slice(2).toString("utf16le"), encoding: "utf16le" };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
  {
    const be = buf.slice(2);
    const le = Buffer.alloc(be.length);
    for (let i = 0; i + 1 < be.length; i += 2)
    {
      le[i] = be[i + 1];
      le[i + 1] = be[i];
    }
    return { text: le.toString("utf16le"), encoding: "utf16be" };
  }
  return { text: buf.toString("utf8"), encoding: "utf8" };
}

function read(root, rel)
{
  const target = path.isAbsolute(rel) ? rel : path.join(root, rel);
  return decode(fs.readFileSync(target)).text;
}

function readInfo(root, rel)
{
  const target = path.isAbsolute(rel) ? rel : path.join(root, rel);
  const buf = fs.readFileSync(target);
  const info = decode(buf);
  const crlf = (info.text.match(/\r\n/g) || []).length;
  const lf = (info.text.match(/(^|[^\r])\n/g) || []).length;
  return {
    text: info.text,
    encoding: info.encoding,
    bytes: buf.length,
    eol: crlf > 0 && lf === 0 ? "crlf" : (crlf === 0 ? "lf" : "mixed")
  };
}

function exists(root, rel)
{
  try
  {
    fs.statSync(path.join(root, rel));
    return true;
  }
  catch (err)
  {
    return false;
  }
}

function listAll(root)
{
  const out = [];
  const skip = new Set(["node_modules", ".git", "build", "bin", "obj", "target", "__pycache__", ".pytest_cache"]);

  const walk = function (dir, prefix)
  {
    let entries = [];
    try
    {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch (err)
    {
      return;
    }
    for (let i = 0; i < entries.length; i++)
    {
      const e = entries[i];
      const rel = prefix ? prefix + "/" + e.name : e.name;
      if (e.isDirectory())
      {
        if (!skip.has(e.name.toLowerCase()))
        {
          walk(path.join(dir, e.name), rel);
        }
        continue;
      }
      out.push(rel);
    }
  };

  walk(root, "");
  return out.sort();
}

function rmrf(dir)
{
  try
  {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  catch (err)
  {
    // A running test executable can hold a handle; leave the folder behind.
  }
}

// Exposed so a test can build a buffer that mixes code pages, the way one build
// can emit both an ANSI banner and UTF-8 compiler output.
function encodeLegacyText(text, codepage)
{
  return encodeLegacy(text, codepage || 949);
}

module.exports =
{
  mkdirp: mkdirp,
  encodeLegacyText: encodeLegacyText,
  write: write,
  writeBinary: writeBinary,
  read: read,
  readInfo: readInfo,
  decode: decode,
  exists: exists,
  listAll: listAll,
  rmrf: rmrf
};
