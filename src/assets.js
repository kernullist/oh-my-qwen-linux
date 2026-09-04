"use strict";

// Static file access for the chat UI.
// In a normal checkout the files come from ./public. Inside a single-file build
// they are embedded as SEA assets, so the same reads go through node:sea.

const fs = require("fs/promises");
const path = require("path");

const sea = (function ()
{
  try
  {
    const mod = require("node:sea");
    return (mod && typeof mod.isSea === "function" && mod.isSea()) ? mod : null;
  }
  catch (err)
  {
    return null;
  }
})();

// Keys used when the UI is embedded; keep in sync with build.js.
const EMBEDDED =
[
  "index.html",
  "app.js",
  "styles.css"
];

function isEmbedded()
{
  return sea !== null;
}

// Normalizes a request path into a safe relative file name.
function normalizeRequest(urlPath)
{
  let rel = String(urlPath || "/");
  try
  {
    rel = decodeURIComponent(rel);
  }
  catch (err)
  {
    return null;
  }

  rel = rel.split("?")[0].split("#")[0];
  rel = rel.replace(/\\/g, "/");

  if (rel === "" || rel === "/")
  {
    rel = "/index.html";
  }

  const parts = rel.split("/").filter(function (p)
  {
    return p !== "" && p !== ".";
  });

  for (let i = 0; i < parts.length; i++)
  {
    if (parts[i] === "..")
    {
      return null;
    }
  }

  return parts.join("/");
}

// Resolves to a Buffer, or null when the file does not exist.
async function read(urlPath, publicDir)
{
  const rel = normalizeRequest(urlPath);
  if (rel === null)
  {
    return null;
  }

  if (sea)
  {
    if (EMBEDDED.indexOf(rel) < 0)
    {
      return null;
    }
    try
    {
      const raw = sea.getRawAsset(rel);
      return Buffer.from(raw);
    }
    catch (err)
    {
      return null;
    }
  }

  const root = path.resolve(publicDir);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep))
  {
    return null;
  }

  try
  {
    return await fs.readFile(full);
  }
  catch (err)
  {
    return null;
  }
}

module.exports =
{
  read: read,
  isEmbedded: isEmbedded,
  normalizeRequest: normalizeRequest,
  EMBEDDED: EMBEDDED
};
