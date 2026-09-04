"use strict";

// Workspace tools exposed to the model. Every path argument is resolved and
// verified to stay inside the registered working folder, so a hallucinated
// absolute path cannot touch the rest of the disk.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const toolchain = require("./toolchain");
const project = require("./project");

// read_file loads the whole file to count lines accurately, so cap the size and
// cap how many lines a single call returns.
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LINES_PER_READ = 4000;
const MAX_LINE_CHARS = 2000;
const MAX_RESULT_CHARS = 48000;

// How big a file may be before a text scan gives up on it. Logs and generated
// sources cross the old 2 MB line constantly, and the skip used to be silent,
// which turned "I never opened it" into "the text is not there".
const SEARCH_MAX_BYTES = 16 * 1024 * 1024;
const REPLACE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 32000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120000;

const SKIP_DIRS = new Set(
[
  ".git", "node_modules", ".vs", ".vscode", "bin", "obj", "dist", "build",
  "out", "__pycache__", ".next", ".cache", "Intermediate", "Binaries",
  "DerivedDataCache", "Saved", ".idea", "target", "vendor", ".venv", "venv"
]);

const BINARY_EXT = new Set(
[
  ".exe", ".dll", ".sys", ".pdb", ".lib", ".obj", ".bin", ".dat", ".png",
  ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".pdf", ".zip", ".7z", ".rar",
  ".gz", ".tar", ".mp3", ".mp4", ".avi", ".mkv", ".wav", ".ttf", ".otf",
  ".woff", ".woff2", ".pak", ".uasset", ".umap", ".gguf", ".safetensors",
  ".db", ".sqlite", ".sqlite3", ".mdb", ".accdb", ".pdb", ".idb", ".ilk",
  ".res", ".tlb", ".cab", ".msi", ".iso", ".vhd", ".vhdx", ".etl", ".dmp"
]);

// Tools that mutate the machine and therefore need explicit approval.
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "replace_in_files", "create_dir", "delete_path",
  "run_command", "build_project", "run_project", "test_project"]);

function isMutating(name)
{
  return MUTATING_TOOLS.has(name);
}

function toPosix(p)
{
  return String(p).split(path.sep).join("/");
}

// True when `rel` points outside `base` after both are already resolved.
function leavesBase(base, target)
{
  const rel = path.relative(base, target);
  if (rel === "")
  {
    return false;
  }
  return rel === ".." || rel.startsWith(".." + path.sep) || rel.startsWith("../") || path.isAbsolute(rel);
}

// Resolves symlinks and directory junctions. For a path that does not exist yet
// the nearest existing ancestor is resolved and the remainder appended, so a new
// file inside a junctioned directory is still judged by its real location.
function realpathSafe(p)
{
  let current = path.resolve(p);
  const tail = [];

  for (;;)
  {
    try
    {
      const real = fs.realpathSync(current);
      if (tail.length === 0)
      {
        return real;
      }
      return path.join(real, tail.slice().reverse().join(path.sep));
    }
    catch (err)
    {
      const parent = path.dirname(current);
      if (parent === current)
      {
        return path.resolve(p);
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

// Resolves a model-supplied path against the workspace root and refuses escapes.
function resolveInside(root, rel)
{
  const rootResolved = path.resolve(root);
  let candidate = String(rel === undefined || rel === null ? "." : rel).trim();

  candidate = candidate.replace(/^["']|["']$/g, "");
  if (candidate === "" || candidate === "." || candidate === "./")
  {
    return rootResolved;
  }

  // Strip a leading workspace name or drive-absolute prefix when it matches root.
  const full = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(rootResolved, candidate);

  if (leavesBase(rootResolved, full))
  {
    throw new Error("path escapes the working folder: " + candidate);
  }

  // A junction or symlink inside the workspace can point anywhere on disk, and
  // a purely textual check would happily follow it. mklink /J needs no admin
  // rights, so this is a real escape and not a theoretical one.
  if (leavesBase(realpathSafe(rootResolved), realpathSafe(full)))
  {
    throw new Error("path leaves the working folder through a symlink or junction: " + candidate);
  }

  return full;
}

function relFromRoot(root, full)
{
  const r = path.relative(path.resolve(root), full);
  return r === "" ? "." : toPosix(r);
}

// Roots the app itself points the model at. The system prompt hands out the
// absolute vcvarsall path, so flagging the toolchain would warn on every build.
function trustedOutsideRoots()
{
  const roots = [];
  const chain = toolchain.detect();

  if (chain && chain.vcvarsall)
  {
    // ...\VC\Auxiliary\Build\vcvarsall.bat -> the Visual Studio install root.
    roots.push(path.resolve(path.dirname(chain.vcvarsall), "..", "..", ".."));
  }

  if (process.platform !== "win32")
  {
    return roots;
  }

  const extra = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]];
  for (let i = 0; i < extra.length; i++)
  {
    if (extra[i])
    {
      roots.push(path.join(path.resolve(extra[i]), "Windows Kits"));
      roots.push(path.join(path.resolve(extra[i]), "Microsoft Visual Studio"));
    }
  }

  return roots;
}

function isDirectory(p)
{
  try
  {
    return fs.statSync(p).isDirectory();
  }
  catch (err)
  {
    return false;
  }
}

// Compiled binaries only. Scripts are deliberately excluded: a .ps1 or .cmd
// outside the folder is code or data to be read, and "Get-Content
// C:\Users\me\deploy.ps1" must not be waved through as a tool launch.
const PROGRAM_EXT = new Set([".exe", ".com"]);

let programRootsCache = null;

function programRoots()
{
  if (programRootsCache)
  {
    return programRootsCache;
  }

  if (process.platform !== "win32")
  {
    programRootsCache = ["/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin", "/bin", "/sbin", "/snap/bin"]
      .filter(function (p) { return isDirectory(p); })
      .map(function (p) { return path.resolve(p); });
    return programRootsCache;
  }

  const names = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "SystemRoot"];
  programRootsCache = [];

  for (let i = 0; i < names.length; i++)
  {
    const value = process.env[names[i]];
    if (value)
    {
      programRootsCache.push(path.resolve(value));
    }
  }

  return programRootsCache;
}

// Launching an installed tool by its full path is the normal case and says
// nothing about data leaving the folder. Reading a file outside does. Being an
// executable is not enough on its own: it also has to live where programs are
// installed, so an .exe dropped in a user folder is still reported.
function isInstalledProgram(full)
{
  if (process.platform === "win32" && !PROGRAM_EXT.has(path.extname(full).toLowerCase()))
  {
    return false;
  }

  const roots = programRoots();
  const installed = roots.some(function (root)
  {
    return !leavesBase(root, full);
  });

  if (!installed)
  {
    return false;
  }

  try
  {
    const stat = fs.statSync(full);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  }
  catch (err)
  {
    return false;
  }
}

// Absolute, UNC and ..-traversal paths a shell command reaches for. run_command
// is the one tool that can step outside the working folder, so the approval card
// has to say so instead of showing a wall of PowerShell and hoping it is read.
const PATH_SHAPES =
[
  /"([A-Za-z]:[\\/][^"]*)"/g,
  /'([A-Za-z]:[\\/][^']*)'/g,
  /(^|[\s;,(=&|])([A-Za-z]:[\\/][^\s;,)"'|&]*)/g,
  /"(\\\\[^"]+)"/g,
  /(^|[\s;,(=&|])(\\\\[A-Za-z0-9._-]+\\[^\s;,)"'|&]*)/g,
  /(^|[\s;,(=&|"'])((?:\.\.[\\/])+[^\s;,)"'|&]*)/g,
  /"(\/[^"\r\n]*)"/g,
  /'(\/[^'\r\n]*)'/g,
  /(^|[\s;,(=&|<>])(\/[^\s;,)"'|&]*)/g
];

// $env:USERPROFILE\.ssh and %APPDATA%\... reach out of the folder just as
// surely as a literal C:\ path, and are the more natural way to write it.
const ENV_SHAPES =
[
  /\$env:([A-Za-z_][A-Za-z0-9_]*)((?:[\\/][^\s;,)"'|&]*)?)/g,
  /%([A-Za-z_][A-Za-z0-9_()]*)%((?:[\\/][^\s;,)"'|&]*)?)/g,
  /(^|[\s;,(=&|"'])(~[\\/][^\s;,)"'|&]*)/g,
  /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))((?:\/[^\s;,)"'|&]*)?)/g
];

function envReferences(rootResolved, text)
{
  const out = [];

  for (let i = 0; i < ENV_SHAPES.length; i++)
  {
    const re = new RegExp(ENV_SHAPES[i].source, "g");
    let m = re.exec(text);

    while (m)
    {
      let base = "";
      let shown = "";
      let rest = "";

      if (ENV_SHAPES[i].source.indexOf("~") >= 0)
      {
        base = process.env.USERPROFILE || process.env.HOME || "";
        shown = m[2];
        // m[2] is "~\sub\file"; the tilde IS the base, so drop it. Keeping it
        // added a phantom ".~" directory and could flag a path that really was
        // inside the working folder.
        rest = m[2].slice(1);
      }
      else if (i === ENV_SHAPES.length - 1)
      {
        const name = m[1] || m[2];
        base = name === "PWD" ? rootResolved : (process.env[name] || "");
        shown = m[0];
        rest = m[3] || "";
      }
      else
      {
        base = process.env[m[1]] || "";
        shown = m[0];
        rest = m[2] || "";
      }

      // Only variables that actually name a directory. PATH expands to a
      // semicolon-joined list and is not a path reference at all.
      if (base && isDirectory(base))
      {
        const full = path.resolve(base, "." + rest);
        if (leavesBase(rootResolved, full))
        {
          out.push(shown);
        }
      }

      m = re.exec(text);
    }
  }

  return out;
}

// Every protection in this file is relative to the working folder, so choosing
// the filesystem root, a system tree, or the whole home directory weakens the
// boundary. Keep that choice visible instead of silently treating it as a
// normal project folder.
function workspaceRisk(dir)
{
  if (!dir)
  {
    return null;
  }

  const resolved = path.resolve(dir);
  const parsed = path.parse(resolved);
  const same = function (other)
  {
    if (!other)
    {
      return false;
    }
    const candidate = path.resolve(other);
    return process.platform === "win32"
      ? candidate.toLowerCase() === resolved.toLowerCase()
      : candidate === resolved;
  };

  if (resolved.toLowerCase() === parsed.root.toLowerCase())
  {
    return {
      code: "filesystem-root",
      message: "파일시스템 루트(" + resolved + ")를 작업 폴더로 등록했습니다. 이 경우 폴더 경계가 사실상 사라집니다 - " +
        "시스템 파일도 '폴더 안'으로 취급되고, 폴더 밖 경로 경고도 뜨지 않습니다. 자동 승인까지 켜져 있으면 " +
        "확인 없이 시스템 전체를 읽고 쓸 수 있습니다. 프로젝트 폴더를 직접 지정하는 것을 권합니다."
    };
  }

  const systemRoots = ["/etc", "/usr", "/var", "/boot", "/opt", "/root"];

  for (let i = 0; i < systemRoots.length; i++)
  {
    if (same(systemRoots[i]))
    {
      return {
        code: "system-root",
        message: "시스템 디렉터리(" + resolved + ")를 작업 폴더로 등록했습니다. 이 안의 파일을 " +
          "고치거나 지우면 Ubuntu 동작에 영향을 줄 수 있고, 폴더 밖 경로 경고도 이 안에서는 뜨지 않습니다."
      };
    }
  }

  const profileRoots = [process.env.HOME, process.env.XDG_CONFIG_HOME];

  for (let i = 0; i < profileRoots.length; i++)
  {
    if (same(profileRoots[i]))
    {
      return {
        code: "profile-root",
        message: "사용자 프로필 루트(" + resolved + ")를 작업 폴더로 등록했습니다. " +
          ".ssh 키, 브라우저 프로필, 저장된 자격 정보가 모두 '폴더 안'이 되어 경고 없이 읽힐 수 있습니다. " +
          "작업할 프로젝트 폴더를 직접 지정하는 것을 권합니다."
      };
    }
  }

  return null;
}

// Directories inside the working folder that are really links to somewhere
// else. resolveInside already refuses these for path arguments, but a shell
// command naming one is textually "inside" and used to raise no warning at all,
// so `Get-Content .\linked\secret.txt` walked straight out of the sandbox.
function reparseNamesUnder(root)
{
  const names = [];

  const scan = function (dir, depth)
  {
    if (depth > 2)
    {
      return;
    }

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
      const full = path.join(dir, entries[i].name);
      let link = false;
      try
      {
        link = fs.lstatSync(full).isSymbolicLink();
      }
      catch (err)
      {
        link = false;
      }

      if (link)
      {
        if (leavesBase(realpathSafe(path.resolve(root)), realpathSafe(full)))
        {
          names.push(relFromRoot(root, full));
        }
        continue;
      }

      if (entries[i].isDirectory() && !SKIP_DIRS.has(entries[i].name))
      {
        scan(full, depth + 1);
      }
    }
  };

  scan(path.resolve(root), 0);
  return names;
}

// Commands that put bytes into a file rather than read them out. Deletion is
// deliberately absent: losing a file is loud and obvious, while a bad byte-level
// rewrite looks like success. Not exhaustive either - the job is to raise the
// approval card, not to be a boundary a shell could be written to dodge.
const SHELL_WRITE_SHAPES =
  /(\bdd\b|\bcp\b|\bmv\b|\binstall\b|\btee\b|\btruncate\b|\bWriteAllBytes\b|\bWriteAllText\b|\bWriteAllLines\b|\bAppendAllText\b|\bSet-Content\b|\bAdd-Content\b|\bClear-Content\b|\bOut-File\b|\bExport-Csv\b|\bCopy-Item\b|\bMove-Item\b|>>?)/i;

// Anything shaped like a filename. Only the extension decides whether it
// matters here, so this does not need to parse paths correctly - PATH_SHAPES
// cannot help because it only looks for paths that leave the folder, and a
// binary being overwritten in place never does.
const FILE_TOKEN = /[^\s"'(),;|&=]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;

// Binary files inside the working folder that a shell command looks set to
// write. Reported next to the out-of-folder paths on the approval card, and
// enough on its own to raise a card while auto-approve is on: auto-approve
// means "I trust you inside my folder", and rewriting a binary by hand is the
// one in-folder edit the file tools already refuse to make.
function binaryWrites(root, command)
{
  const text = String(command || "");
  if (!SHELL_WRITE_SHAPES.test(text))
  {
    return [];
  }

  const rootResolved = path.resolve(root);
  const found = [];
  const seen = new Set();

  const re = new RegExp(FILE_TOKEN.source, "g");
  let m = re.exec(text);

  while (m)
  {
    const candidate = m[0];

    if (looksBinaryName(candidate))
    {
      let full = null;
      try
      {
        full = path.isAbsolute(candidate) || /^\\\\/.test(candidate)
          ? path.resolve(candidate)
          : path.resolve(rootResolved, candidate);
      }
      catch (err)
      {
        full = null;
      }

      // Anything outside the folder is already named by outsidePaths, and
      // saying it a second way adds noise rather than information.
      if (full && !leavesBase(rootResolved, full))
      {
        const key = full.toLowerCase();
        if (!seen.has(key))
        {
          seen.add(key);
          found.push(candidate);
        }
      }
    }

    m = re.exec(text);
  }

  return found;
}

function outsidePaths(root, command)
{
  const text = String(command || "");
  const rootResolved = path.resolve(root);
  const trusted = trustedOutsideRoots();
  const found = [];
  const seen = new Set();

  // A link inside the folder that points out of it.
  const links = reparseNamesUnder(rootResolved);
  for (let i = 0; i < links.length; i++)
  {
    const leaf = links[i].split("/").pop();
    if (leaf && new RegExp("(^|[\\s\"'\\\\/=(])" + leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "([\\s\"'\\\\/)]|$)", "i").test(text))
    {
      const label = links[i] + " (link out of the folder)";
      if (!seen.has(label.toLowerCase()))
      {
        seen.add(label.toLowerCase());
        found.push(label);
      }
    }
  }

  const viaEnv = envReferences(rootResolved, text);
  for (let i = 0; i < viaEnv.length; i++)
  {
    const key = viaEnv[i].toLowerCase();
    if (!seen.has(key))
    {
      seen.add(key);
      found.push(viaEnv[i]);
    }
  }

  for (let i = 0; i < PATH_SHAPES.length; i++)
  {
    const re = new RegExp(PATH_SHAPES[i].source, "g");
    let m = re.exec(text);

    while (m)
    {
      const raw = (m[2] !== undefined ? m[2] : m[1]) || "";
      const candidate = raw.trim().replace(/[.,;:]+$/, "");

      if (candidate)
      {
        let full = null;
        try
        {
          full = path.isAbsolute(candidate) || /^\\\\/.test(candidate)
            ? path.resolve(candidate)
            : path.resolve(rootResolved, candidate);
        }
        catch (err)
        {
          full = null;
        }

        // Textually inside is not the same as actually inside: a junction in
        // the working folder resolves somewhere else entirely, which is why the
        // real path is checked too.
        const escapes = full && full !== "/dev/null" && (leavesBase(rootResolved, full) ||
          leavesBase(realpathSafe(rootResolved), realpathSafe(full)));

        if (escapes)
        {
          const isTrusted = trusted.some(function (r)
          {
            return !leavesBase(r, full);
          }) || isInstalledProgram(full);
          const key = full.toLowerCase();

          if (!isTrusted && !seen.has(key))
          {
            seen.add(key);
            found.push(candidate);
          }
        }
      }

      m = re.exec(text);
    }
  }

  return found;
}

// A positive glob cannot express "everywhere except here". Without this, a
// request that named a folder as off limits could only be carried out by
// replacing across it and undoing the damage afterwards, which is one round
// away from leaving the tree quietly wrong.
//
// Accepts a comma separated list. A bare name is a file or folder name
// anywhere in the tree, so exclude="third_party" covers the whole subtree.
function excludeMatcher(spec)
{
  const parts = String(spec === undefined || spec === null ? "" : spec)
    .split(",")
    .map(function (part)
    {
      return part.trim().split("\\").join("/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    })
    .filter(Boolean);

  if (parts.length === 0)
  {
    return null;
  }

  const res = [];
  for (let i = 0; i < parts.length; i++)
  {
    const pat = parts[i];
    const wild = pat.indexOf("*") >= 0 || pat.indexOf("?") >= 0;

    if (pat.indexOf("/") >= 0)
    {
      res.push(globToRegExp(pat));
      if (!wild)
      {
        res.push(globToRegExp(pat + "/**"));
      }
      continue;
    }

    res.push(globToRegExp("**/" + pat));
    if (!wild)
    {
      res.push(globToRegExp("**/" + pat + "/**"));
    }
  }

  return function (rel)
  {
    const base = path.posix.basename(rel);
    for (let i = 0; i < res.length; i++)
    {
      if (res[i].test(rel) || res[i].test(base))
      {
        return true;
      }
    }
    return false;
  };
}

// Never let an exclusion be invisible. A caller who over-excludes and is told
// nothing reads an empty result as "there was nothing there".
function excludeNote(spec, list, verb)
{
  if (!list || list.length === 0)
  {
    return "";
  }
  return "\n\n" + list.length + " file(s) were not " + verb + " because exclude=" +
    JSON.stringify(String(spec)) + " matched them: " + list.slice(0, 6).join(", ") +
    (list.length > 6 ? (" ... and " + (list.length - 6) + " more") : "");
}

function globToRegExp(glob)
{
  let out = "";
  const g = String(glob || "*");
  for (let i = 0; i < g.length; i++)
  {
    const c = g[i];
    if (c === "*")
    {
      if (g[i + 1] === "*")
      {
        out += "[\\s\\S]*";
        i++;
        if (g[i + 1] === "/")
        {
          i++;
        }
      }
      else
      {
        out += "[^/]*";
      }
    }
    else if (c === "?")
    {
      out += "[^/]";
    }
    else if (c === "{" && g.indexOf("}", i) > i)
    {
      // Brace alternation. Without it "*.{cpp,h}" matched nothing and the tools
      // reported a confident zero results, which reads as "there is no such
      // file" rather than "that pattern was not understood".
      const close = g.indexOf("}", i);
      const options = g.slice(i + 1, close).split(",").map(function (part)
      {
        return part.trim().replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
      });
      out += "(?:" + options.join("|") + ")";
      i = close;
    }
    else if ("\\^$.|+()[]{}".indexOf(c) >= 0)
    {
      out += "\\" + c;
    }
    else
    {
      out += c;
    }
  }
  return new RegExp("^" + out + "$", "i");
}

function looksBinaryName(name)
{
  return BINARY_EXT.has(path.extname(name).toLowerCase());
}

function looksBinaryContent(buf)
{
  const limit = Math.min(buf.length, 4096);
  for (let i = 0; i < limit; i++)
  {
    if (buf[i] === 0)
    {
      return true;
    }
  }
  return false;
}

function clip(text, limit)
{
  const max = limit || MAX_RESULT_CHARS;
  const s = String(text);
  if (s.length <= max)
  {
    return s;
  }
  return s.slice(0, max) + "\n... [truncated " + (s.length - max) + " more chars]";
}

// Command output is not like a file: the interesting part is usually the last
// few lines. Clipping only the head would throw away the very summary the
// caller needs, so keep both ends.
function clipEnds(text, limit)
{
  const s = String(text);
  const max = limit || MAX_COMMAND_OUTPUT;
  if (s.length <= max)
  {
    return s;
  }

  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return s.slice(0, head) +
    "\n... [" + (s.length - max) + " chars cut from the middle] ...\n" +
    s.slice(s.length - tail);
}

// Collects the files a scan should look at. A caller that narrows to one file
// means exactly that: walking a file used to yield nothing and the tool reported
// "scanned 0 text files", which reads as "the text is not there".
async function collectScanTargets(root, startPath, opts)
{
  const out = { files: [], truncated: false };
  const stat = await fsp.stat(startPath).catch(function ()
  {
    return null;
  });

  if (!stat)
  {
    // Zero results for a path that does not exist reads as "the text is not in
    // this project", which is a different and much worse answer.
    out.missing = true;
    return out;
  }

  if (stat.isFile())
  {
    out.files.push(relFromRoot(root, startPath));
    out.single = true;
    return out;
  }

  await walk(root, startPath, opts, out);
  return out;
}

function missingScanPath(args)
{
  return {
    ok: false,
    text: "path not found: " + toPosix(args.path === undefined ? "." : args.path) +
      ". Check the location with list_dir or find_files first; searching a path that does not exist " +
      "returns no matches for the wrong reason."
  };
}

async function walk(root, dir, opts, out)
{
  let entries = [];
  try
  {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  }
  catch (err)
  {
    return;
  }

  entries.sort(function (a, b)
  {
    if (a.isDirectory() !== b.isDirectory())
    {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  for (let i = 0; i < entries.length; i++)
  {
    if (out.files.length >= opts.limit)
    {
      out.truncated = true;
      return;
    }

    const ent = entries[i];
    const full = path.join(dir, ent.name);

    // Never traverse links: a junction could pull the whole scan outside the
    // workspace, and following it could also loop forever.
    if (ent.isSymbolicLink())
    {
      continue;
    }

    if (ent.isDirectory())
    {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith("."))
      {
        continue;
      }
      await walk(root, full, opts, out);
    }
    else if (ent.isFile())
    {
      out.files.push(relFromRoot(root, full));
    }
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolListDir(root, args)
{
  const target = resolveInside(root, args.path);
  const depth = Math.min(4, Math.max(1, Number(args.depth) || 1));

  const stat = await fsp.stat(target).catch(function ()
  {
    return null;
  });
  if (!stat)
  {
    return { ok: false, text: "not found: " + toPosix(args.path || ".") };
  }
  if (!stat.isDirectory())
  {
    return { ok: false, text: "not a directory: " + toPosix(args.path || ".") };
  }

  const lines = [];
  let count = 0;

  async function render(dir, level, prefix)
  {
    let entries = [];
    try
    {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    }
    catch (err)
    {
      lines.push(prefix + "[unreadable]");
      return;
    }

    entries.sort(function (a, b)
    {
      if (a.isDirectory() !== b.isDirectory())
      {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < entries.length; i++)
    {
      if (count >= 500)
      {
        lines.push(prefix + "... [more entries omitted]");
        return;
      }

      const ent = entries[i];
      const full = path.join(dir, ent.name);

      if (ent.isSymbolicLink())
      {
        count++;
        lines.push(prefix + ent.name + "  [link, not followed]");
        continue;
      }

      if (ent.isDirectory())
      {
        count++;
        lines.push(prefix + ent.name + "/");
        const skip = SKIP_DIRS.has(ent.name);
        if (level < depth && !skip)
        {
          await render(full, level + 1, prefix + "  ");
        }
        else if (skip)
        {
          lines.push(prefix + "  ... [skipped]");
        }
      }
      else if (ent.isFile())
      {
        count++;
        let size = 0;
        try
        {
          size = (await fsp.stat(full)).size;
        }
        catch (err)
        {
          size = 0;
        }
        lines.push(prefix + ent.name + "  (" + size + "B)");
      }
    }
  }

  await render(target, 1, "");

  const header = relFromRoot(root, target);
  return {
    ok: true,
    summary: header + " (" + count + " entries)",
    text: header + "\n" + (lines.length > 0 ? lines.join("\n") : "[empty directory]")
  };
}

const MAX_HEX_BYTES = 4096;

// Header fields live at fixed offsets, so a dump has to show the real file
// offset of every row and the bytes exactly as they sit on disk.
function hexDump(buf, base)
{
  // Without a column ruler the reader has to count bytes across the row to turn
  // a column into a file offset, which is exactly where header parsing goes
  // wrong. Row base + column label reads the offset off directly.
  const ruler = [];
  for (let j = 0; j < 16; j++)
  {
    ruler.push(j.toString(16).padStart(2, "0"));
    if (j === 7)
    {
      ruler.push("");
    }
  }

  // Padded to the width of "0x" + 8 hex digits + 2 spaces so the ruler sits
  // directly above the byte columns it labels.
  const rows = ["offset      " + ruler.join(" ")];
  for (let i = 0; i < buf.length; i += 16)
  {
    const chunk = buf.slice(i, i + 16);
    const bytes = [];
    const ascii = [];

    for (let j = 0; j < 16; j++)
    {
      if (j < chunk.length)
      {
        bytes.push(chunk[j].toString(16).padStart(2, "0"));
        ascii.push((chunk[j] >= 32 && chunk[j] < 127) ? String.fromCharCode(chunk[j]) : ".");
      }
      else
      {
        bytes.push("  ");
        ascii.push(" ");
      }
      if (j === 7)
      {
        bytes.push("");
      }
    }

    // The 0x prefix is not decoration. A bare row label like 00000080 reads as
    // decimal to anything scanning quickly, and a PE header parsed at the wrong
    // base produces a confident, completely wrong answer.
    rows.push("0x" + (base + i).toString(16).padStart(8, "0") + "  " + bytes.join(" ") + " |" + ascii.join("") + "|");
  }
  return rows.join("\n");
}

async function toolReadFileHex(root, args, target, stat)
{
  const requested = Math.max(0, Math.floor(Number(args.start_byte) || 0));
  if (requested >= stat.size)
  {
    return {
      ok: false,
      text: "start_byte " + requested + " is past the end of the file (" + stat.size + " bytes)"
    };
  }

  // Snap to a 16 byte boundary so a column label is the low nibble of the real
  // offset. Unaligned rows force the reader to count bytes across the row, and
  // that is where header field offsets get misread.
  const start = requested - (requested % 16);
  const want = Number(args.max_bytes) > 0 ? Math.floor(Number(args.max_bytes)) : 256;
  const length = Math.min(want + (requested - start), MAX_HEX_BYTES, stat.size - start);

  const handle = await fsp.open(target, "r");
  let buf = Buffer.alloc(length);
  try
  {
    const read = await handle.read(buf, 0, length, start);
    buf = buf.slice(0, read.bytesRead);
  }
  finally
  {
    await handle.close();
  }

  const end = start + buf.length;
  const hex = function (n)
  {
    return "0x" + n.toString(16);
  };

  const notes = [];
  notes.push("Row labels, column labels and byte values are hexadecimal; the byte counts in this header are decimal. " +
    "Offset of any byte = the row label plus its column label.");

  if (end < stat.size)
  {
    notes.push("Showing bytes " + start + "-" + (end - 1) + " of " + stat.size +
      ". Pass start_byte=" + end + " (" + hex(end) + ") to continue.");
  }
  if (want > MAX_HEX_BYTES)
  {
    notes.push("max_bytes was capped at " + MAX_HEX_BYTES + ".");
  }
  if (start !== requested)
  {
    notes.push("Started at " + start + " instead of " + requested + " to keep rows 16 byte aligned.");
  }

  // An all-zero window looks like a failed read. Saying so saves the caller from
  // concluding the structure is not there and guessing instead.
  const allZero = buf.length > 0 && buf.every(function (b)
  {
    return b === 0;
  });
  if (allZero)
  {
    notes.push("Every byte in this range is 00, so whatever you are looking for is elsewhere in the file.");
  }

  // Reading source code as hex happens, and it wastes a round and a lot of
  // context to learn nothing that numbered lines would not have shown.
  if (!looksBinaryName(target) && decodeFile(buf).ok)
  {
    notes.push("This file is readable as text. Call read_file without hex=true to get numbered lines instead.");
  }

  return {
    ok: true,
    summary: relFromRoot(root, target) + " hex " + start + "-" + (end - 1) + " / " + stat.size + " bytes",
    text: "HEX " + relFromRoot(root, target) + " (bytes " + start + "-" + (end - 1) +
      " of " + stat.size + ", offsets " + hex(start) + "-" + hex(Math.max(start, end - 1)) + ")\n" +
      (notes.length > 0 ? ("[" + notes.join(" ") + "]\n") : "") +
      hexDump(buf, start)
  };
}

async function toolReadFile(root, args)
{
  const target = resolveInside(root, args.path);
  const stat = await fsp.stat(target).catch(function ()
  {
    return null;
  });

  if (!stat)
  {
    return { ok: false, text: "not found: " + toPosix(args.path) };
  }
  if (args.hex === true || args.hex === "true")
  {
    return toolReadFileHex(root, args, target, stat);
  }
  if (stat.isDirectory())
  {
    return { ok: false, text: "that path is a directory, use list_dir: " + toPosix(args.path) };
  }
  if (looksBinaryName(target))
  {
    return {
      ok: false,
      text: "binary file, refusing to read as text (" + stat.size + " bytes). " +
        "To inspect its bytes call read_file again with hex=true, plus start_byte and max_bytes."
    };
  }

  if (stat.size > MAX_FILE_BYTES)
  {
    return {
      ok: false,
      text: "file is too large to load as text (" + Math.round(stat.size / 1024 / 1024) + " MB, limit " +
        Math.round(MAX_FILE_BYTES / 1024 / 1024) + " MB). Analyse it with run_command instead, " +
        "for example: grep -c 'ERROR' \"" + toPosix(args.path) + "\""
    };
  }

  const buf = await fsp.readFile(target);
  const decoded = decodeFile(buf);
  if (!decoded.ok)
  {
    return {
      ok: false,
      text: "binary content detected, refusing to read as text. " +
        "To inspect its bytes call read_file again with hex=true, plus start_byte and max_bytes."
    };
  }

  // Count lines over the WHOLE file. Slicing bytes first would report a wrong
  // total and make the model believe a 60k line log is only a few thousand.
  // The BOM is already stripped so edit_file snippets can match the first line.
  const text = decoded.text;
  const lines = text.split(/\r?\n/);
  const total = lines.length;

  const offset = Math.min(Math.max(1, Number(args.start_line) || 1), Math.max(1, total));
  const limit = Number(args.max_lines) > 0 ? Math.min(Number(args.max_lines), MAX_LINES_PER_READ) : MAX_LINES_PER_READ;
  const slice = lines.slice(offset - 1, offset - 1 + limit);

  // Minified bundles and one-line JSON are a single enormous line. Clipping the
  // whole result would report "lines 1-1 of 1" while hiding most of the file, so
  // clip per line and say how much was hidden.
  let clippedLines = 0;
  let clippedChars = 0;

  const numbered = slice.map(function (l, i)
  {
    let shown = l;
    if (shown.length > MAX_LINE_CHARS)
    {
      clippedLines++;
      clippedChars += shown.length - MAX_LINE_CHARS;
      shown = shown.slice(0, MAX_LINE_CHARS) +
        " ... [line " + (offset + i) + " cut here, " + (l.length - MAX_LINE_CHARS) + " more chars on this line]";
    }
    return (offset + i) + "| " + shown;
  }).join("\n");

  const lastShown = offset + slice.length - 1;
  const shown = offset + "-" + lastShown;
  const notes = [];

  if (lastShown < total)
  {
    notes.push("Not the whole file: " + (total - lastShown) + " line(s) after line " + lastShown +
      " were not returned. Pass start_line=" + (lastShown + 1) + " to continue, " +
      "or use run_command (grep -n, sed -n) when you need to reason over the entire file.");
  }
  if (offset > 1)
  {
    notes.push("Lines 1-" + (offset - 1) + " were skipped.");
  }
  if (decoded.encoding === "utf16le" || decoded.encoding === "utf16be")
  {
    notes.push("This file is " + (decoded.encoding === "utf16le" ? "UTF-16LE" : "UTF-16BE") +
      ". Edits keep that encoding.");
  }
  else if (decoded.encoding === "legacy")
  {
    notes.push("This file is " + decoded.label + ", not UTF-8. Editing it saves it as UTF-8; " +
      "the text itself is preserved.");
  }
  if (clippedLines > 0)
  {
    notes.push(clippedLines + " very long line(s) were cut short, hiding " + clippedChars + " characters. " +
      "This file is minified or one-line data: locate what you need with search_text, " +
      "or process it with run_command, rather than reading it whole.");
  }

  // Notes go before the body: the result is clipped at the end, so a trailing
  // warning about truncation would itself be truncated away.
  return {
    ok: true,
    summary: relFromRoot(root, target) + " lines " + shown + " / " + total,
    text: "FILE " + relFromRoot(root, target) + " (lines " + shown + " of " + total + ")\n" +
      (notes.length > 0 ? "[" + notes.join(" ") + "]\n" : "") + numbered
  };
}

const BOM = "﻿";

// Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page, so a
// UTF-8 script with Korean text runs as mojibake. MSVC has the same problem
// (warning C4819). For those file types a BOM is the correct default.
const BOM_EXT = new Set([".ps1", ".psm1", ".psd1", ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx", ".rc", ".bat", ".cmd"]);

function hasNonAscii(text)
{
  return /[^\x00-\x7F]/.test(text);
}

function wantsBom(target, content)
{
  return process.platform === "win32" && BOM_EXT.has(path.extname(target).toLowerCase()) && hasNonAscii(content);
}

function stripBom(text)
{
  return text.charAt(0) === BOM ? text.slice(1) : text;
}

// Windows produces UTF-16 text constantly: PowerShell 5.1 defaults to UTF-16LE
// for Out-File, ">" redirection and Export-Csv, and Visual Studio saves some
// sources that way. Such a file is full of NUL bytes, so without this the model
// cannot read back output it just generated itself with run_command.
function bomlessUtf16(buf)
{
  const limit = Math.min(buf.length, 4096);
  if (limit < 16)
  {
    return "utf8";
  }

  let evenNul = 0;
  let oddNul = 0;
  let pairs = 0;
  for (let i = 0; i + 1 < limit; i += 2)
  {
    pairs++;
    if (buf[i] === 0)
    {
      evenNul++;
    }
    if (buf[i + 1] === 0)
    {
      oddNul++;
    }
  }

  // Requiring the other half to be completely free of NULs keeps real binaries,
  // which have zeros on both sides, from being decoded as text.
  if (oddNul >= pairs * 0.9 && evenNul === 0)
  {
    return "utf16le";
  }
  if (evenNul >= pairs * 0.9 && oddNul === 0)
  {
    return "utf16be";
  }
  return "utf8";
}

function detectEncoding(buf)
{
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE)
  {
    // FF FE 00 00 opens UTF-32LE, which is not text this reader can decode.
    if (!(buf.length >= 4 && buf[2] === 0 && buf[3] === 0))
    {
      return "utf16le";
    }
    return "utf8";
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF)
  {
    return "utf16be";
  }
  return bomlessUtf16(buf);
}

function looksBinaryText(text)
{
  const limit = Math.min(text.length, 4096);
  let bad = 0;
  for (let i = 0; i < limit; i++)
  {
    const c = text.charCodeAt(i);
    if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13))
    {
      bad++;
    }
  }

  // The absolute floor matters as much as the ratio. A 40 character file with a
  // single ANSI escape in it is 2.5% control characters and is still a text
  // file; a real binary has hundreds in the first block.
  return bad > 8 && bad > limit * 0.01;
}

// Returns { ok, text, encoding, bom }. The encoding travels back to the writers
// so that editing a UTF-16 file does not silently convert it to UTF-8.
function decodeFile(buf)
{
  const encoding = detectEncoding(buf);

  if (encoding === "utf16le" || encoding === "utf16be")
  {
    let src = buf;
    if (src.length % 2 === 1)
    {
      src = src.slice(0, src.length - 1);
    }
    if (encoding === "utf16be")
    {
      src = Buffer.from(src).swap16();
    }

    const raw = src.toString("utf16le");
    const text = stripBom(raw);
    if (looksBinaryText(text))
    {
      return { ok: false, encoding: "binary", text: "", bom: false };
    }
    return { ok: true, text: text, encoding: encoding, bom: text !== raw };
  }

  if (looksBinaryContent(buf))
  {
    return { ok: false, encoding: "binary", text: "", bom: false };
  }

  const raw = buf.toString("utf8");

  // Korean Windows source trees are full of CP949 files. Decoding one as UTF-8
  // yields replacement characters, and writing those back would erase the
  // original characters for good, so decode it properly instead.
  if (raw.indexOf("�") >= 0)
  {
    const legacy = decodeLegacy(buf);

    // The decode succeeding is not enough. A legacy code page maps almost every
    // byte to *some* character, so an executable with no NUL bytes decoded
    // cleanly as EUC-KR and arrived here as text. read_file then refused it by
    // extension while edit_file happily rewrote it as UTF-8, reporting the
    // corruption as a helpful encoding conversion. The UTF-16 branch above has
    // always re-checked; this one did not.
    if (legacy && !looksBinaryText(legacy.text))
    {
      return { ok: true, text: legacy.text, encoding: "legacy", label: legacy.label, bom: false };
    }

    if (!legacy && looksBinaryText(raw))
    {
      return { ok: false, encoding: "binary", text: "", bom: false };
    }
    if (legacy)
    {
      return { ok: false, encoding: "binary", text: "", bom: false };
    }
  }

  const text = stripBom(raw);

  // looksBinaryContent above only looks for NUL bytes, so a file packed with
  // other control bytes reached this point and was handed back as text. The
  // UTF-16 branch has always run this check; the plain branch had not.
  if (looksBinaryText(text))
  {
    return { ok: false, encoding: "binary", text: "", bom: false };
  }

  return { ok: true, text: text, encoding: "utf8", bom: text !== raw };
}

// Node can decode these but cannot encode them, so a file that arrives in a
// legacy code page is saved back as UTF-8 and the change is reported.
const LEGACY_CODEPAGES = ["euc-kr", "windows-1252"];

function decodeLegacy(buf)
{
  for (let i = 0; i < LEGACY_CODEPAGES.length; i++)
  {
    try
    {
      const text = new TextDecoder(LEGACY_CODEPAGES[i], { fatal: false }).decode(buf);
      if (text.indexOf("�") < 0)
      {
        return { text: text, label: LEGACY_CODEPAGES[i] };
      }
    }
    catch (err)
    {
      // decoder not built into this runtime, try the next candidate
    }
  }
  return null;
}

// A legacy file has no encoder, so it becomes UTF-8. Source types that MSVC and
// PowerShell 5.1 misread without a BOM get one, which also covers the case of an
// edit introducing the first non-ASCII character into a plain ASCII source.
function bomOnSave(target, content, encoding, hadBom)
{
  if (encoding === "utf16le" || encoding === "utf16be")
  {
    return true;
  }
  if (hadBom)
  {
    return true;
  }
  return wantsBom(target, content);
}

function encodeFile(text, encoding, keepBom)
{
  if (encoding === "utf16le" || encoding === "utf16be")
  {
    const body = Buffer.from(text, "utf16le");
    const payload = (encoding === "utf16be") ? Buffer.from(body).swap16() : body;
    if (!keepBom)
    {
      return payload;
    }
    const mark = (encoding === "utf16be") ? Buffer.from([0xFE, 0xFF]) : Buffer.from([0xFF, 0xFE]);
    return Buffer.concat([mark, payload]);
  }
  return Buffer.from((keepBom ? BOM : "") + text, "utf8");
}

function encodingNote(encoding)
{
  if (encoding === "utf16le")
  {
    return " Decoded as UTF-16LE.";
  }
  if (encoding === "utf16be")
  {
    return " Decoded as UTF-16BE.";
  }
  return "";
}

// Windows source trees are usually CRLF. The model always produces LF, so
// without this every edit would rewrite every line of the file.
function detectEol(text)
{
  const crlf = (text.match(/\r\n/g) || []).length;
  if (crlf === 0)
  {
    return "\n";
  }
  const lf = (text.match(/\n/g) || []).length;
  return crlf >= (lf - crlf) ? "\r\n" : "\n";
}

function toEol(text, eol)
{
  const normalized = String(text).replace(/\r\n/g, "\n");
  return eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

// Literal single replacement. Everything the model writes is data, never a
// substitution pattern.
function spliceFirst(haystack, needle, replacement)
{
  const at = haystack.indexOf(needle);
  if (at < 0)
  {
    return haystack;
  }
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}

function countOccurrences(haystack, needle)
{
  if (!needle)
  {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

// A file-writing tool must be pointed at a file. Passing "." or a directory
// used to surface a raw EISDIR from Node, which told the model nothing.
// The text writers must not touch an existing binary. Checked by extension so
// it does not depend on a content heuristic being right, and only for files that
// already exist: creating something new is always allowed.
function binaryWriteRefusal(root, target, toolName)
{
  let stat = null;
  try
  {
    stat = fs.statSync(target);
  }
  catch (err)
  {
    return "";
  }

  if (!stat.isFile() || !looksBinaryName(target))
  {
    return "";
  }

  return toolName + " will not overwrite " + relFromRoot(root, target) +
    ": that is a binary file (" + stat.size + " bytes) and writing text over it would destroy it. " +
    "Inspect it with read_file hex=true. If replacing it really is the intent, say so and use run_command.";
}

function requireFilePath(root, args, toolName)
{
  const raw = String(args.path === undefined || args.path === null ? "" : args.path).trim();
  if (raw === "" || raw === "." || raw === "./" || raw === "/")
  {
    return toolName + " needs a file path, for example src/main.cpp; \"" + raw + "\" refers to the working folder itself.";
  }

  const target = resolveInside(root, raw);
  let stat = null;
  try
  {
    stat = fs.statSync(target);
  }
  catch (err)
  {
    stat = null;
  }
  if (stat && stat.isDirectory())
  {
    return toolName + " cannot write to " + relFromRoot(root, target) + " because it is a directory; give a file path inside it.";
  }
  return null;
}

async function toolWriteFile(root, args)
{
  const bad = requireFilePath(root, args, "write_file");
  if (bad)
  {
    return { ok: false, text: bad };
  }

  const target = resolveInside(root, args.path);
  let content = typeof args.content === "string" ? args.content : "";

  // read_file refuses a binary by extension and replace_in_files skips them,
  // but write_file used to overwrite one and report success: a 514 byte exe
  // became a 21 byte text file with nothing to say it had been destroyed.
  // Creating a new file is untouched by this.
  const binaryRefusal = binaryWriteRefusal(root, target, "write_file");
  if (binaryRefusal)
  {
    return { ok: false, text: binaryRefusal };
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  const existed = fs.existsSync(target);

  let eolNote = "";
  let hadBom = false;
  let encoding = "utf8";

  if (existed)
  {
    // Preserve the file's existing line ending style, BOM and text encoding.
    let previous = "";
    try
    {
      const before = await fsp.readFile(target);
      const decoded = decodeFile(before);
      if (decoded.ok)
      {
        previous = decoded.bom ? (BOM + decoded.text) : decoded.text;
        hadBom = decoded.bom;
        if (decoded.encoding === "utf16le" || decoded.encoding === "utf16be")
        {
          encoding = decoded.encoding;
          eolNote += " " + (encoding === "utf16le" ? "UTF-16LE" : "UTF-16BE") + " encoding preserved.";
        }
        else if (decoded.encoding === "legacy")
        {
          eolNote += " This file was " + decoded.label + ", not UTF-8; it is saved as UTF-8 now.";
        }
      }
    }
    catch (err)
    {
      previous = "";
    }

    const eol = detectEol(previous);
    if (eol === "\r\n" && content.indexOf("\r\n") < 0)
    {
      content = toEol(content, "\r\n");
      eolNote += " CRLF line endings preserved.";
    }
    if (hadBom)
    {
      eolNote += " UTF-8 BOM preserved.";
    }
  }

  content = stripBom(content);

  const keepBom = bomOnSave(target, content, encoding, hadBom);
  if (keepBom && !hadBom && encoding === "utf8")
  {
    eolNote += " Saved with a UTF-8 BOM so Windows tools (PowerShell 5.1, MSVC) read the non-ASCII text correctly.";
  }

  await fsp.writeFile(target, encodeFile(content, encoding, keepBom));

  const lineCount = content.split(/\r?\n/).length;
  return {
    ok: true,
    summary: (existed ? "overwrote " : "created ") + relFromRoot(root, target) + " (" + lineCount + " lines)",
    text: (existed ? "Overwrote" : "Created") + " " + relFromRoot(root, target) + " with " + content.length +
      " chars / " + lineCount + " lines." + eolNote
  };
}

async function toolEditFile(root, args)
{
  const bad = requireFilePath(root, args, "edit_file");
  if (bad)
  {
    return { ok: false, text: bad };
  }

  const target = resolveInside(root, args.path);
  const oldStr = String(args.old_string === undefined ? "" : args.old_string);
  const newStr = String(args.new_string === undefined ? "" : args.new_string);

  if (!fs.existsSync(target))
  {
    return { ok: false, text: "not found: " + toPosix(args.path) + " (use write_file to create it)" };
  }
  if (oldStr === "")
  {
    return { ok: false, text: "old_string must not be empty" };
  }

  const binaryRefusal = binaryWriteRefusal(root, target, "edit_file");
  if (binaryRefusal)
  {
    return { ok: false, text: binaryRefusal };
  }

  const decoded = decodeFile(await fsp.readFile(target));
  if (!decoded.ok)
  {
    return { ok: false, text: "binary content detected, refusing to edit as text" };
  }
  const hadBom = decoded.bom;
  const original = decoded.text;
  const eol = detectEol(original);
  const encNote = (decoded.encoding === "legacy")
    ? (" This file was " + decoded.label + ", not UTF-8; it is saved as UTF-8 now.")
    : encodingNote(decoded.encoding);

  let search = oldStr;
  let replace = newStr;
  let occurrences = countOccurrences(original, search);
  let note = "";

  // Fall back to the file's own line endings before giving up: the model reads
  // normalized text, so a CRLF file would never match an LF snippet.
  if (occurrences === 0)
  {
    const converted = toEol(oldStr, eol);
    if (converted !== oldStr)
    {
      const found = countOccurrences(original, converted);
      if (found > 0)
      {
        search = converted;
        replace = toEol(newStr, eol);
        occurrences = found;
        note = " Line endings were adapted to the file (" + (eol === "\r\n" ? "CRLF" : "LF") + ").";
      }
    }
  }

  if (occurrences === 0)
  {
    // Point at the closest line so the model can see how it differs instead of
    // retrying the same snippet.
    const firstLine = oldStr.split(/\r?\n/).find(function (l)
    {
      return l.trim().length > 0;
    }) || "";
    const needle = firstLine.trim();
    const lines = original.split(/\r?\n/);
    const hints = [];

    if (needle)
    {
      for (let i = 0; i < lines.length && hints.length < 3; i++)
      {
        if (lines[i].indexOf(needle) >= 0)
        {
          hints.push("  line " + (i + 1) + ": " + JSON.stringify(lines[i]));
        }
      }
    }

    let text = "old_string not found in " + relFromRoot(root, target) + ".";
    if (hints.length > 0)
    {
      text += "\nThe file does contain that text, but the surrounding whitespace differs. Actual lines:\n" +
        hints.join("\n") +
        "\nCopy the snippet verbatim from read_file output, including indentation.";
    }
    else
    {
      text += " Read the file again and copy the snippet verbatim, including indentation.";
    }

    return { ok: false, text: text };
  }

  if (occurrences > 1 && !args.replace_all)
  {
    return {
      ok: false,
      text: "old_string appears " + occurrences + " times; pass replace_all=true or supply a longer unique snippet"
    };
  }

  // Not String.replace: even with a string needle it interprets $$, $&, $` and
  // $' in the replacement. A Makefile line written as "cp $$SRC $$DST" came out
  // as "cp $SRC $DST", and new_string of "$&" was replaced by old_string
  // itself. Splicing by index is literal.
  const updated = args.replace_all
    ? original.split(search).join(replace)
    : spliceFirst(original, search, replace);
  const body = stripBom(updated);
  await fsp.writeFile(target,
    encodeFile(body, decoded.encoding, bomOnSave(target, body, decoded.encoding, hadBom)));

  return {
    ok: true,
    summary: "edited " + relFromRoot(root, target) + " (" + occurrences + " replacement" + (occurrences > 1 ? "s" : "") + ")",
    text: "Edited " + relFromRoot(root, target) + ": replaced " + occurrences + " occurrence(s)." + note + encNote
  };
}

async function toolCreateDir(root, args)
{
  const target = resolveInside(root, args.path);

  // mkdir over an existing file throws a bare EEXIST, which reads like the
  // directory is already there. Say what is actually in the way.
  const stat = await fsp.stat(target).catch(function ()
  {
    return null;
  });
  if (stat && !stat.isDirectory())
  {
    return {
      ok: false,
      text: "cannot create " + relFromRoot(root, target) + " because a file with that name already exists"
    };
  }

  await fsp.mkdir(target, { recursive: true });
  return {
    ok: true,
    summary: "created " + relFromRoot(root, target) + "/",
    text: "Directory ready: " + relFromRoot(root, target)
  };
}

async function toolDeletePath(root, args)
{
  const target = resolveInside(root, args.path);
  if (path.resolve(target) === path.resolve(root))
  {
    return { ok: false, text: "refusing to delete the workspace root" };
  }
  if (!fs.existsSync(target))
  {
    return { ok: false, text: "not found: " + toPosix(args.path) };
  }

  const stat = await fsp.stat(target);
  if (stat.isDirectory())
  {
    if (!args.recursive)
    {
      const entries = await fsp.readdir(target);
      if (entries.length > 0)
      {
        return { ok: false, text: "directory is not empty, pass recursive=true to delete it" };
      }
    }
    await fsp.rm(target, { recursive: true, force: true });
  }
  else
  {
    await fsp.unlink(target);
  }

  return {
    ok: true,
    summary: "deleted " + relFromRoot(root, target),
    text: "Deleted " + relFromRoot(root, target)
  };
}

async function toolFindFiles(root, args)
{
  const pattern = String(args.pattern || "*");
  const limit = Math.min(500, Math.max(1, Number(args.max_results) || 200));
  const startDir = resolveInside(root, args.path);

  const out = await collectScanTargets(root, startDir, { limit: 20000 });
  if (out.missing)
  {
    return missingScanPath(args);
  }

  const re = globToRegExp(pattern.indexOf("/") >= 0 ? pattern : "**/" + pattern);
  const bare = globToRegExp(pattern);

  // Count every match before cutting the list. Reporting only the shown ones
  // reads as "that is all there is", and a caller then works from a fraction of
  // the project without knowing it.
  const excluded = excludeMatcher(args.exclude);
  const dropped = [];
  const all = out.files.filter(function (f)
  {
    if (!re.test(f) && !bare.test(path.posix.basename(f)))
    {
      return false;
    }
    if (excluded && excluded(f))
    {
      dropped.push(f);
      return false;
    }
    return true;
  });
  const hits = all.slice(0, limit);
  const hidden = all.length - hits.length;

  const notes = [];
  if (dropped.length > 0)
  {
    notes.push(dropped.length + " match(es) were left out because exclude=" +
      JSON.stringify(String(args.exclude)) + " covered them: " + dropped.slice(0, 6).join(", ") +
      (dropped.length > 6 ? (" ... and " + (dropped.length - 6) + " more") : ""));
  }
  if (hidden > 0)
  {
    notes.push("Only the first " + hits.length + " of " + all.length + " matches are listed; " +
      hidden + " more were left out. Narrow the pattern, pass a subfolder in path, " +
      "or raise max_results (up to 500).");
  }
  if (out.truncated)
  {
    notes.push("The folder walk stopped early, so even this count is not the whole tree.");
  }

  return {
    ok: true,
    summary: (hidden > 0 ? (hits.length + " of " + all.length) : String(hits.length)) +
      " file(s) matching " + pattern,
    text: all.length === 0
      ? "No file matches " + pattern
      : all.length + " match(es) for " + pattern +
        (hidden > 0 ? (", showing " + hits.length) : "") + ":\n" + hits.join("\n") +
        (notes.length > 0 ? ("\n\n" + notes.join("\n")) : "")
  };
}

const HIT_EXCERPT_CHARS = 240;

// The piece of a matching line worth showing: the part around the match.
//
// This used to be the first 240 characters of the line, which is the same thing
// for ordinary source and useless for one-line data. A minified catalogue put
// "buildVersion" at character 19,165 of a 19,237 character line, so a search for
// it answered "1 hit" and printed the opening brace and the first two products.
// Searching with a regular expression written around the value printed exactly
// the same thing. read_file clipped the line too and advised locating the value
// with search_text, which could not reach it either.
//
// Nothing in that chain was reported as a failure, so the caller got three
// confident answers that all withheld what was asked for, and could only report
// the hit counts it had been given.
function excerptAround(line, at, matchLength, budget)
{
  const text = String(line);
  const room = budget || HIT_EXCERPT_CHARS;

  if (text.length <= room)
  {
    return text.trim();
  }

  const width = Math.max(0, matchLength || 0);
  const lead = Math.max(0, Math.floor((room - width) / 2));
  let start = Math.max(0, (at >= 0 ? at : 0) - lead);
  let end = Math.min(text.length, start + room);
  start = Math.max(0, Math.min(start, end - room));

  const head = start > 0 ? ("...[+" + start + " chars] ") : "";
  const tail = end < text.length ? (" [+" + (text.length - end) + " chars]...") : "";

  // The offset is the only handle a caller has on a line this long, so say it.
  const where = start > 0 ? (" (at char " + at + ")") : "";

  return head + text.slice(start, end).trim() + tail + where;
}

async function toolSearchText(root, args)
{
  const query = String(args.query || "");
  if (!query)
  {
    return { ok: false, text: "query must not be empty" };
  }

  const limit = Math.min(400, Math.max(1, Number(args.max_results) || 80));
  const startDir = resolveInside(root, args.path);
  const globFilter = args.glob ? globToRegExp(String(args.glob).indexOf("/") >= 0 ? args.glob : "**/" + args.glob) : null;
  const excluded = excludeMatcher(args.exclude);
  const excludedFiles = [];

  let re = null;
  if (args.regex)
  {
    try
    {
      re = new RegExp(query, args.case_sensitive ? "" : "i");
    }
    catch (err)
    {
      return { ok: false, text: "invalid regular expression: " + err.message };
    }
  }

  const needle = args.case_sensitive ? query : query.toLowerCase();
  const out = await collectScanTargets(root, startDir, { limit: 20000 });
  if (out.missing)
  {
    return missingScanPath(args);
  }

  // path already named one file, so a glob on top of it can only get in the way.
  const fileFilter = out.single ? null : globFilter;

  const hits = [];
  let scanned = 0;
  let skippedBinary = 0;

  // A file that was never opened is not a file without matches. Logs and
  // generated sources routinely cross the size limit, and skipping them in
  // silence turned "I did not look" into "it is not there".
  const skippedLarge = [];
  const skippedUnreadable = [];

  // Where the scan stopped matters: hitting the cap means the rest of the tree
  // was never looked at, and a caller must not read that as "nothing else".
  let cursor = 0;
  for (; cursor < out.files.length && hits.length < limit; cursor++)
  {
    const i = cursor;
    const rel = out.files[i];
    if (fileFilter && !fileFilter.test(rel) && !fileFilter.test(path.posix.basename(rel)))
    {
      continue;
    }
    if (excluded && excluded(rel))
    {
      excludedFiles.push(rel);
      continue;
    }
    if (looksBinaryName(rel))
    {
      skippedBinary++;
      continue;
    }

    const full = path.join(root, rel);
    let stat = null;
    try
    {
      stat = await fsp.stat(full);
    }
    catch (err)
    {
      continue;
    }
    if (stat.size > SEARCH_MAX_BYTES)
    {
      skippedLarge.push(rel + " (" + Math.round(stat.size / 1024 / 1024) + " MB)");
      continue;
    }

    let buf = null;
    try
    {
      buf = await fsp.readFile(full);
    }
    catch (err)
    {
      skippedUnreadable.push(rel);
      continue;
    }
    const decoded = decodeFile(buf);
    if (!decoded.ok)
    {
      skippedBinary++;
      continue;
    }

    scanned++;
    const lines = decoded.text.split(/\r?\n/);
    for (let l = 0; l < lines.length && hits.length < limit; l++)
    {
      const line = lines[l];
      let match = false;
      let at = -1;
      let matchLength = 0;

      if (re)
      {
        const m = re.exec(line);
        if (m)
        {
          match = true;
          at = m.index;
          matchLength = String(m[0] || "").length;
        }
      }
      else
      {
        at = (args.case_sensitive ? line : line.toLowerCase()).indexOf(needle);
        match = at >= 0;
        matchLength = needle.length;
      }

      if (match)
      {
        hits.push(rel + ":" + (l + 1) + ": " + excerptAround(line, at, matchLength, HIT_EXCERPT_CHARS));
      }
    }
  }

  // A pattern full of regex metacharacters searched literally finds nothing and
  // reads like "the code is not there", so say what actually happened.
  let note = "";
  if (hits.length === 0 && !args.regex && /[\\^$|]|\.\*|\[\^|\\[sdwbSDWB]/.test(query))
  {
    note = "\nThat query looks like a regular expression but was matched literally. " +
      "Pass regex=true to use it as a pattern, or search for a plain substring.";
  }

  const stoppedEarly = hits.length >= limit && cursor < out.files.length;
  const stopNote = stoppedEarly
    ? ("\n\nStopped after " + limit + " hits with " + (out.files.length - cursor) +
       " file(s) never searched. This is a partial result: narrow the query, " +
       "pass a glob or a subfolder, or raise max_results (up to 400).")
    : "";

  let skipNote = "";
  if (skippedLarge.length > 0)
  {
    skipNote += "\n\n" + skippedLarge.length + " file(s) were NOT searched because they are over " +
      Math.round(SEARCH_MAX_BYTES / 1024 / 1024) + " MB:\n" + skippedLarge.slice(0, 10).join("\n") +
      (skippedLarge.length > 10 ? ("\n... and " + (skippedLarge.length - 10) + " more") : "") +
      "\nSearch inside those with run_command, for example: " +
      "grep -n -m 20 '" + query.slice(0, 40).replace(/'/g, "'\\''") + "' \"" +
      skippedLarge[0].replace(/ \(.*$/, "") + "\"";
  }
  if (skippedUnreadable.length > 0)
  {
    skipNote += "\n\n" + skippedUnreadable.length + " file(s) could not be read (locked or no permission): " +
      skippedUnreadable.slice(0, 5).join(", ");
  }
  skipNote += excludeNote(args.exclude, excludedFiles, "searched");

  return {
    ok: true,
    summary: hits.length + (stoppedEarly ? "+" : "") + " hit(s) for \"" + query.slice(0, 40) + "\" in " + scanned + " file(s)" +
      (skippedLarge.length > 0 ? ", " + skippedLarge.length + " too large" : ""),
    text: (hits.length === 0
      ? "No match for \"" + query + "\" (scanned " + scanned + " text files" +
        (skippedBinary > 0 ? ", skipped " + skippedBinary + " binary file(s)" : "") + ")"
      : hits.length + " hit(s) for " + JSON.stringify(query) + ":" + "\n" + hits.join("\n")) + note + stopNote + skipNote
  };
}

// Bulk edit across many files. Doing this through the shell (Set-Content and
// friends) rewrites line endings and encodings, which corrupts a whole tree in
// one go; editing files one by one blows the tool round budget. So the app owns
// the operation and preserves each file's EOL style and BOM.
async function toolReplaceInFiles(root, args)
{
  const find = String(args.find === undefined ? "" : args.find);
  const replacement = String(args.replace === undefined ? "" : args.replace);

  if (find === "")
  {
    return { ok: false, text: "find must not be empty" };
  }

  const startDir = resolveInside(root, args.path);
  const globFilter = args.glob
    ? globToRegExp(String(args.glob).indexOf("/") >= 0 ? args.glob : "**/" + args.glob)
    : null;
  const excluded = excludeMatcher(args.exclude);
  const excludedFiles = [];
  const samples = [];
  let sampleBudget = SAMPLE_LINE_BUDGET;

  let re = null;
  if (args.regex)
  {
    try
    {
      re = new RegExp(find, args.case_sensitive ? "g" : "gi");
    }
    catch (err)
    {
      return { ok: false, text: "invalid regular expression: " + err.message };
    }
  }

  const out = await collectScanTargets(root, startDir, { limit: 20000 });
  if (out.missing)
  {
    return missingScanPath(args);
  }

  // path already named one file, so a glob on top of it can only get in the way.
  const fileFilter = out.single ? null : globFilter;

  const changed = [];
  const skipped = [];
  let totalHits = 0;
  let scanned = 0;
  let skippedBinary = 0;
  const dryRun = args.dry_run === true;

  for (let i = 0; i < out.files.length; i++)
  {
    const rel = out.files[i];
    if (fileFilter && !fileFilter.test(rel) && !fileFilter.test(path.posix.basename(rel)))
    {
      continue;
    }
    if (excluded && excluded(rel))
    {
      excludedFiles.push(rel);
      continue;
    }
    if (looksBinaryName(rel))
    {
      skippedBinary++;
      continue;
    }

    const full = path.join(root, rel);
    let stat = null;
    try
    {
      stat = await fsp.stat(full);
    }
    catch (err)
    {
      continue;
    }
    if (stat.size > REPLACE_MAX_BYTES)
    {
      skipped.push(rel + ": over " + Math.round(REPLACE_MAX_BYTES / 1024 / 1024) +
        " MB (" + Math.round(stat.size / 1024 / 1024) + " MB), not touched");
      continue;
    }

    let buf = null;
    try
    {
      buf = await fsp.readFile(full);
    }
    catch (err)
    {
      continue;
    }
    const decoded = decodeFile(buf);
    if (!decoded.ok)
    {
      skippedBinary++;
      continue;
    }

    scanned++;

    const hadBom = decoded.bom;
    const original = decoded.text;
    const eol = detectEol(original);

    let hits = 0;
    let updated = original;

    if (re)
    {
      // Count first, then replace with a string so $1 backreferences expand.
      // A replacer callback would insert "$1" literally.
      re.lastIndex = 0;
      const matches = original.match(re);
      hits = matches ? matches.length : 0;
      if (hits > 0)
      {
        re.lastIndex = 0;
        updated = original.replace(re, toEol(replacement, eol));
      }
    }
    else
    {
      // Match the literal in the file's own line ending style.
      const needle = toEol(find, eol);
      hits = countOccurrences(original, needle);
      if (hits === 0 && needle !== find)
      {
        hits = countOccurrences(original, find);
        if (hits > 0)
        {
          updated = original.split(find).join(toEol(replacement, eol));
        }
      }
      else if (hits > 0)
      {
        updated = original.split(needle).join(toEol(replacement, eol));
      }
    }

    if (hits === 0 || updated === original)
    {
      continue;
    }

    totalHits += hits;
    changed.push(rel + " (" + hits + ")");

    if (samples.length < SAMPLE_FILES && sampleBudget > 0)
    {
      const shown = changedLines(original, updated, replacement, Math.min(sampleBudget, 12));
      if (shown.length > 0)
      {
        samples.push({ rel: rel, lines: shown });
        sampleBudget -= shown.length;
      }
    }

    if (!dryRun)
    {
      try
      {
        await fsp.writeFile(full,
          encodeFile(updated, decoded.encoding, bomOnSave(full, updated, decoded.encoding, hadBom)));
      }
      catch (err)
      {
        // One unwritable file (read-only, locked) must not sink the whole batch.
        totalHits -= hits;
        changed.pop();
        skipped.push(rel + " - " + friendlyFsError(err, root));
        continue;
      }
    }
  }

  const verb = dryRun ? "would change" : "changed";
  const skipNote = skipped.length > 0
    ? "\n" + skipped.length + " file(s) could not be written:\n" + skipped.slice(0, 20).join("\n")
    : "";

  if (changed.length === 0)
  {
    // Escaping a paren for a literal search is the classic way to match nothing
    // here: "LOG\(" without regex=true looks for a backslash in the text.
    const looksLikePattern = !args.regex && /[\\^$|]|\.\*|\[\^|\\[sdwbSDWB]/.test(find)
      ? "\nThat find string looks like a regular expression but was matched literally. " +
        "Pass regex=true to use it as a pattern, or drop the escapes and search for the plain text."
      : "";

    return {
      ok: skipped.length === 0,
      summary: skipped.length > 0
        ? ("nothing written, " + skipped.length + " blocked")
        : ("no match in " + scanned + " file(s)"),
      text: "No file was changed" + (skipped.length === 0
        ? ": nothing contains " + JSON.stringify(find) + " (scanned " + scanned + " text files" +
          (skippedBinary > 0 ? ", skipped " + skippedBinary + " binary file(s)" : "") + ")."
        : ".") + looksLikePattern + skipNote + excludeNote(args.exclude, excludedFiles, "examined")
    };
  }

  const listed = changed.slice(0, 200);
  const more = changed.length - listed.length;

  // This tool means "change all of these", so anything left over is almost
  // always a scope mistake rather than a decision. The common shape: the caller
  // narrows to one subtree, replaces there, and reports the job done while
  // another subtree still has the old text. The tool knows what it searched
  // for, so it can just look.
  const leftovers = dryRun ? null : await remainingMatches(root, find, replacement, re, args);
  let leftoverNote = "";

  if (leftovers && leftovers.files.length > 0)
  {
    leftoverNote = "\n\nStill present elsewhere in the working folder: " + leftovers.total +
      " occurrence(s) of " + JSON.stringify(find.slice(0, 60)) + " in " + leftovers.files.length + " file(s):\n" +
      leftovers.files.slice(0, 10).join("\n") +
      (leftovers.files.length > 10 ? ("\n... and " + (leftovers.files.length - 10) + " more") : "") +
      "\nThose were outside the path or glob you passed. Decide deliberately whether they should change too, " +
      "and do not report the job as finished until you have.";
  }

  let sampleNote = "";
  if (samples.length > 0)
  {
    const shown = [];
    for (let i = 0; i < samples.length; i++)
    {
      shown.push(samples[i].rel + ":");
      for (let j = 0; j < samples[i].lines.length; j++)
      {
        shown.push("  " + samples[i].lines[j]);
      }
    }
    sampleNote = "\n\nWhat those lines say now" +
      (changed.length > samples.length ? (" (first " + samples.length + " of " + changed.length + " files)") : "") +
      ":\n" + shown.join("\n") +
      "\nA version or a constant is often spelled a second way next to the one you replaced, " +
      "and that spelling does not match the search text.";
  }

  return {
    ok: true,
    summary: verb + " " + changed.length + " file(s), " + totalHits + " replacement(s)" +
      (skipped.length > 0 ? ", " + skipped.length + " blocked" : "") +
      (leftovers && leftovers.files.length > 0 ? ", " + leftovers.total + " left elsewhere" : ""),
    text: verb.charAt(0).toUpperCase() + verb.slice(1) + " " + changed.length + " file(s) with " + totalHits +
      " replacement(s); line endings and BOM preserved per file.\n" + listed.join("\n") +
      (more > 0 ? "\n... and " + more + " more file(s)" : "") + skipNote + sampleNote + leftoverNote +
      excludeNote(args.exclude, excludedFiles, "examined")
  };
}

const SAMPLE_FILES = 6;
const SAMPLE_LINE_BUDGET = 28;
const SAMPLE_WINDOW = 2;

// The lines a replace actually rewrote, with a couple of lines either side.
//
// The tool used to report only which files changed and how many hits: enough to
// know it ran, not enough to see a scope mistake. Bumping a version across a
// repository left "#define APP_VERSION_MINOR 4" sitting two lines under the
// string that had just become "1.5.0", every run. The second spelling of the
// same fact does not contain the search text, so nothing in the result
// mentioned it. Showing the neighbourhood puts it in front of the caller
// without asking anything of them, and without spending a round.
//
// One line of context was not enough - it stopped exactly short of the define
// that mattered - so the window is two, with a shared budget across all files
// so a thousand-file replace cannot flood the result.
function changedLines(original, updated, replacement, budget)
{
  const before = original.split(/\r?\n/);
  const after = updated.split(/\r?\n/);

  // Every hit gets the same replacement, so the line count normally holds. When
  // it does not, fall back to spotting the replacement text in the new lines.
  const aligned = before.length === after.length;
  const flat = String(replacement).split(/\r?\n/)[0];

  const wanted = new Set();
  const isEdit = new Set();

  for (let i = 0; i < after.length; i++)
  {
    const changedHere = aligned ? (before[i] !== after[i]) : (flat !== "" && after[i].indexOf(flat) >= 0);
    if (!changedHere)
    {
      continue;
    }

    isEdit.add(i);
    for (let k = i - SAMPLE_WINDOW; k <= i + SAMPLE_WINDOW; k++)
    {
      if (k >= 0 && k < after.length && after[k].trim())
      {
        wanted.add(k);
      }
    }
    if (wanted.size >= budget)
    {
      break;
    }
  }

  const rows = Array.from(wanted).sort(function (a, b)
  {
    return a - b;
  }).slice(0, budget);

  const out = [];
  let prev = -2;
  for (let i = 0; i < rows.length; i++)
  {
    const n = rows[i];
    if (n > prev + 1 && out.length > 0)
    {
      out.push("  ...");
    }
    out.push((n + 1) + (isEdit.has(n) ? "> " : "  ") + after[n].trim().slice(0, 110));
    prev = n;
  }

  return out;
}

// Occurrences of the search text that survive anywhere in the working folder.
// Skipped when the replacement itself contains the search text, because then
// every rewritten line still matches and the count would be meaningless.
async function remainingMatches(root, find, replacement, re, args)
{
  if (re)
  {
    try
    {
      if (new RegExp(re.source, re.flags.replace("g", "")).test(replacement))
      {
        return null;
      }
    }
    catch (err)
    {
      return null;
    }
  }
  else if (replacement.indexOf(find) >= 0)
  {
    return null;
  }

  const out = await collectScanTargets(root, path.resolve(root), { limit: 20000 });
  if (out.missing)
  {
    return null;
  }

  const files = [];
  let total = 0;
  const excluded = excludeMatcher(args.exclude);

  for (let i = 0; i < out.files.length && files.length < 40; i++)
  {
    const rel = out.files[i];
    if (looksBinaryName(rel))
    {
      continue;
    }
    // Deliberately out of scope, so it is not leftover work.
    if (excluded && excluded(rel))
    {
      continue;
    }

    let buf = null;
    try
    {
      const stat = await fsp.stat(path.join(root, rel));
      if (stat.size > REPLACE_MAX_BYTES)
      {
        continue;
      }
      buf = await fsp.readFile(path.join(root, rel));
    }
    catch (err)
    {
      continue;
    }

    const decoded = decodeFile(buf);
    if (!decoded.ok)
    {
      continue;
    }

    let hits = 0;
    if (re)
    {
      const matches = decoded.text.match(new RegExp(re.source, re.flags.indexOf("g") >= 0 ? re.flags : re.flags + "g"));
      hits = matches ? matches.length : 0;
    }
    else
    {
      hits = countOccurrences(decoded.text, find);
      if (hits === 0 && args.case_sensitive !== true)
      {
        hits = countOccurrences(decoded.text.toLowerCase(), find.toLowerCase());
      }
    }

    if (hits > 0)
    {
      files.push(rel + " (" + hits + ")");
      total += hits;
    }
  }

  return { files: files, total: total };
}

// A crashed Windows process exits with an NTSTATUS, which Node surfaces as a
// large negative number. "exit code -1073741819" means nothing to the model, so
// name the exception: that is the difference between "build succeeded" and
// "the program access-violated".
const NTSTATUS_NAMES =
{
  0xC0000005: "ACCESS_VIOLATION - the process dereferenced an invalid pointer (crash)",
  0xC000001D: "ILLEGAL_INSTRUCTION (crash)",
  0xC0000025: "NONCONTINUABLE_EXCEPTION (crash)",
  0xC000008C: "ARRAY_BOUNDS_EXCEEDED (crash)",
  0xC0000090: "FLOAT_INVALID_OPERATION (crash)",
  0xC0000094: "INTEGER_DIVIDE_BY_ZERO (crash)",
  0xC0000095: "INTEGER_OVERFLOW (crash)",
  0xC00000FD: "STACK_OVERFLOW - usually runaway recursion (crash)",
  0xC0000135: "DLL_NOT_FOUND - a required DLL is missing",
  0xC0000139: "ENTRYPOINT_NOT_FOUND - a DLL export is missing",
  0xC0000142: "DLL_INIT_FAILED",
  0xC0000374: "HEAP_CORRUPTION - a heap block was corrupted (crash)",
  0xC0000409: "STACK_BUFFER_OVERRUN / __fastfail - security check failed (crash)",
  0xC0000417: "INVALID_CRT_PARAMETER (crash)",
  0xC000041D: "UNHANDLED_EXCEPTION_IN_CALLBACK (crash)",
  0x80000003: "BREAKPOINT - a debug break was hit",
  0xC0000602: "FAIL_FAST_EXCEPTION (crash)"
};

function describeExitCode(code)
{
  if (code === null || code === undefined || code === 0)
  {
    return null;
  }

  // Node reports the status as a signed 32-bit value.
  const unsigned = code < 0 ? (code >>> 0) : code;
  const name = NTSTATUS_NAMES[unsigned];
  if (!name)
  {
    return null;
  }

  return "0x" + unsigned.toString(16).toUpperCase() + " " + name;
}

// Forces a UTF-8 console so native tools (cmd, cl, git) do not hand back text
// in the legacy ANSI code page, which would reach the model as mojibake.
const WIN_PRELUDE =
  "try { chcp 65001 > $null } catch {}; " +
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; " +
  "$global:LASTEXITCODE = 0; ";

// powershell -Command collapses a native crash into exit 1, and re-exiting with
// the NTSTATUS does not survive either. $LASTEXITCODE does hold the real value,
// so print it on a marker line and read it back instead of trusting the shell's
// own exit code. A crashed program reports e.g. -1073741819 (ACCESS_VIOLATION),
// while a failed cmdlet leaves $LASTEXITCODE at 0 and is normalised to 1.
// Keeping only the head of a chatty command loses the end of the output, and
// the end is where the test summary, the error total and the exit code marker
// live. Keep both ends and say how much of the middle went away.
function makeOutputSink(headLimit, tailLimit)
{
  const head = [];
  const tail = [];
  let headBytes = 0;
  let tailBytes = 0;
  let dropped = 0;

  return {
    push: function (chunk)
    {
      if (headBytes < headLimit)
      {
        head.push(chunk);
        headBytes += chunk.length;
        return;
      }

      tail.push(chunk);
      tailBytes += chunk.length;

      while (tail.length > 1 && tailBytes > tailLimit)
      {
        tailBytes -= tail[0].length;
        dropped += tail[0].length;
        tail.shift();
      }
    },
    join: function ()
    {
      if (tail.length === 0)
      {
        return Buffer.concat(head);
      }
      if (dropped === 0)
      {
        return Buffer.concat(head.concat(tail));
      }
      const note = Buffer.from("\n... [" + dropped + " bytes dropped from the middle of the output] ...\n");
      return Buffer.concat([Buffer.concat(head), note, Buffer.concat(tail)]);
    }
  };
}

const EXIT_MARKER = "__OMQ_EXIT__:";

const WIN_POSTLUDE =
  "; $__omqOk = $?; $__omqCode = $LASTEXITCODE; " +
  "if ($null -eq $__omqCode) { $__omqCode = 0 }; " +
  "if (-not $__omqOk -and $__omqCode -eq 0) { $__omqCode = 1 }; " +
  "Write-Output ('" + EXIT_MARKER + "' + $__omqCode)";

// Pulls the marker line out of stdout and returns the code it carried.
function extractExitMarker(stdout)
{
  const lines = String(stdout).split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i--)
  {
    const line = lines[i].trim();
    if (line.indexOf(EXIT_MARKER) === 0)
    {
      const value = parseInt(line.slice(EXIT_MARKER.length), 10);
      lines.splice(i, 1);
      return { code: Number.isFinite(value) ? value : null, stdout: lines.join("\n") };
    }
  }

  return { code: null, stdout: String(stdout) };
}

// Legacy code pages still leak through in some tools, so fall back when the
// UTF-8 decode produces replacement characters.
const OUTPUT_CODEPAGES = ["euc-kr", "windows-1252"];

// Picks the best decode for one slice of bytes.
function decodeOutputChunk(slice)
{
  const utf8 = slice.toString("utf8");
  const bad = (utf8.match(/�/g) || []).length;
  if (bad === 0)
  {
    return utf8;
  }

  for (let i = 0; i < OUTPUT_CODEPAGES.length; i++)
  {
    try
    {
      const alt = new TextDecoder(OUTPUT_CODEPAGES[i], { fatal: false }).decode(slice);
      if ((alt.match(/�/g) || []).length < bad)
      {
        return alt;
      }
    }
    catch (err)
    {
      // decoder not available in this build
    }
  }

  return utf8;
}

function decodeOutput(buf)
{
  if (!buf || buf.length === 0)
  {
    return "";
  }

  const utf8 = buf.toString("utf8");
  if (utf8.indexOf("�") < 0)
  {
    return utf8;
  }

  // One build can emit two encodings in the same stream: nmake writes its
  // banner in the ANSI code page while cl writes UTF-8. Decoding the whole
  // buffer one way fixed half of it and double mangled the other half, so once
  // anything looks wrong each line is decoded on its own. Splitting on LF keeps
  // any CR in place, so CRLF output stays CRLF.
  const lines = [];
  let start = 0;

  for (let i = 0; i <= buf.length; i++)
  {
    if (i === buf.length || buf[i] === 0x0a)
    {
      lines.push(decodeOutputChunk(buf.slice(start, i)));
      start = i + 1;
    }
  }

  return lines.join("\n");
}

// Kills a process and everything it spawned. On Windows the shell's children
// (cl.exe, MSBuild, the program under test) survive a plain child.kill().
function killProcessTree(pid)
{
  if (!pid)
  {
    return;
  }

  try
  {
    if (process.platform === "win32")
    {
      // Synchronous on purpose: the parent shell must still be alive for
      // taskkill /T to discover the children it spawned.
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore", timeout: 10000 });
    }
    else
    {
      // POSIX children are started in their own process group. Kill the group
      // so compilers, test runners and servers spawned by Bash do not survive a
      // timeout or a cancelled turn.
      process.kill(-pid, "SIGKILL");
    }
  }
  catch (err)
  {
    // already gone
  }
}

function runShell(root, command, timeoutMs, signal)
{
  return new Promise(function (resolve)
  {
    const isWin = process.platform === "win32";
    const file = isWin ? "powershell.exe" : "/bin/bash";
    const argv = isWin
      // -ExecutionPolicy Bypass is not optional here. npm, npx, yarn, pnpm, tsc
      // and most other Node CLIs are .ps1 shims, and under the default policy
      // PowerShell refuses to load them: every npm test on a stock machine came
      // back as "cannot be loaded because running scripts is disabled".
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command", WIN_PRELUDE + command + WIN_POSTLUDE]
      : ["--noprofile", "--norc", "-o", "pipefail", "-c", command];

    let child = null;
    try
    {
      child = spawn(file, argv,
      {
        cwd: root,
        detached: !isWin,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    }
    catch (err)
    {
      resolve({ code: -1, stdout: "", stderr: "spawn failed: " + err.message, timedOut: false });
      return;
    }

    // Buffers, not strings: decoding each chunk would cut multi-byte characters
    // at the chunk boundary and corrupt non-ASCII output.
    const outSink = makeOutputSink(MAX_COMMAND_OUTPUT * 2, MAX_COMMAND_OUTPUT * 2);
    const errSink = makeOutputSink(MAX_COMMAND_OUTPUT, MAX_COMMAND_OUTPUT);
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let cancelled = false;

    let settled = false;
    const settle = function (result)
    {
      if (settled)
      {
        return;
      }
      settled = true;
      clearTimeout(timer);
      releaseSignal();
      resolve(result);
    };

    const timer = setTimeout(function ()
    {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    // Cancelling a turn has to stop the work, not just stop listening to it.
    const onAbort = function ()
    {
      cancelled = true;
      killProcessTree(child.pid);

      // Return right away. Waiting for the pipes to close would keep the user
      // blocked behind whatever grandchild is still winding down.
      settle(
      {
        code: null,
        stdout: decodeOutput(outSink.join()),
        stderr: decodeOutput(errSink.join()),
        timedOut: false,
        cancelled: true
      });
    };

    if (signal)
    {
      if (signal.aborted)
      {
        onAbort();
      }
      else
      {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    function releaseSignal()
    {
      if (signal)
      {
        try
        {
          signal.removeEventListener("abort", onAbort);
        }
        catch (err)
        {
          // nothing to release
        }
      }
    }

    child.stdout.on("data", function (d)
    {
      outBytes += d.length;
      outSink.push(d);
    });
    child.stderr.on("data", function (d)
    {
      errBytes += d.length;
      errSink.push(d);
    });

    child.on("error", function (err)
    {
      settle(
      {
        code: -1,
        stdout: decodeOutput(outSink.join()),
        stderr: "process error: " + err.message,
        timedOut: timedOut,
        cancelled: cancelled
      });
    });

    child.on("close", function (code)
    {
      settle(
      {
        code: code,
        stdout: decodeOutput(outSink.join()),
        stderr: decodeOutput(errSink.join()),
        timedOut: timedOut,
        cancelled: cancelled
      });
    });
  });
}

// ---------------------------------------------------------------------------
// build / run / test
// ---------------------------------------------------------------------------

// Wraps a command in the MSVC developer environment when the toolchain needs it.
// Printed once the developer environment is live, so the banner in front of it
// can be dropped without hiding a vcvarsall failure.
const MSVC_READY = "__OMQ_MSVC_READY__";

function withMsvc(command, needsMsvc)
{
  if (!needsMsvc || process.platform !== "win32")
  {
    return { command: command, ok: true };
  }

  const msvc = toolchain.detect();
  if (!msvc)
  {
    return { command: command, ok: false, reason: "MSVC was not found on this machine, so this project cannot be built here." };
  }

  // The whole cmd payload is handed to PowerShell -Command, so it has to
  // survive PowerShell's parser before cmd.exe ever sees it. A double-quoted
  // wrapper broke on the first quote inside the build command: msbuild
  // "app.vcxproj" ended the wrapper early and msbuild was left reporting
  // MSB1009 for a project file sitting right there. A single-quoted string is
  // literal, so the inner quotes arrive intact.
  // The marker is echoed to both streams. vcvarsall writes to stderr as well as
  // stdout, and on many machines that includes a harmless
  // "'vswhere.exe' is not recognized" line that otherwise shows up in front of
  // every single build result.
  const payload = 'call "' + msvc.vcvarsall + '" x64 && echo ' + MSVC_READY +
    " && echo " + MSVC_READY + " 1>&2 && " + command;
  return { command: "cmd /c '" + payload.split("'").join("''") + "'", ok: true, msvc: true };
}

// Drops the vcvarsall banner that precedes every MSVC command. When vcvarsall
// itself failed the marker is missing and the full output is kept, which is
// exactly when those lines are worth reading.
function stripMsvcPreamble(text)
{
  const s = String(text || "");
  const at = s.indexOf(MSVC_READY);
  if (at < 0)
  {
    return s;
  }

  const lineEnd = s.indexOf("\n", at);
  return lineEnd < 0 ? "" : s.slice(lineEnd + 1);
}

// Runs one project task and reports a verdict instead of a wall of log output.
// Whether a build has to configure first, and the question is whether the build
// directory is configured rather than whether the folder is there.
//
// This used to test for the folder. An empty build/ - which is what create_dir
// or a mkdir leaves, and what a configure that died early leaves - made the app
// skip configure from then on, so every later build failed with "not a CMake
// build directory" or MSB1009 no matter how correct CMakeLists.txt became. The
// only way out was deleting the folder, and in the greenfield scenario the model
// had worked that out for itself and was running Remove-Item -Recurse -Force on
// build/ between attempts.
//
// CMakeCache.txt is the marker CMake itself uses. Once it exists, cmake --build
// regenerates on its own when CMakeLists.txt changes, so there is nothing
// further to arrange here.
function needsConfigure(root, taskName, task)
{
  if (taskName !== "build" || !task || task.requires !== "configure")
  {
    return false;
  }
  return !fs.existsSync(path.join(root, "build", "CMakeCache.txt"));
}

async function runProjectTask(root, taskName, args, signal)
{
  const info = project.detect(root);
  if (!info)
  {
    return {
      ok: false,
      text: "No build system was detected in the working folder. " +
        "Look at the files with list_dir and ask the user how the project is built, " +
        "or use run_command with an explicit command."
    };
  }

  let task = info.tasks[taskName];
  if (taskName === "run")
  {
    task = project.resolveRun(root, info) || task;
  }

  if (!task || !task.command)
  {
    const available = Object.keys(info.tasks).filter(function (k)
    {
      return info.tasks[k] && info.tasks[k].command;
    });
    return {
      ok: false,
      text: "This project (" + info.label + ") has no " + taskName + " step that the app can infer." +
        (available.length > 0 ? " Available: " + available.join(", ") + "." : "") +
        (taskName === "run" ? " Build it first, or use run_command with the exact executable." : "") +
        (taskName === "test" ? " Add a test script or use run_command with your test runner." : "")
    };
  }

  const steps = [];

  if (needsConfigure(root, taskName, task))
  {
    const cfg = info.tasks.configure;
    if (cfg && cfg.command)
    {
      steps.push({ label: "configure", spec: cfg });
    }
  }
  steps.push({ label: taskName, spec: task });

  const extra = String(args.extra_args || args.args || args.filter || "").trim();
  const timeoutMs = Math.min(1800000, Math.max(5000, Number(args.timeout_ms) || 300000));

  const parts = [];
  let lastCode = 0;
  let combined = "";
  let lastStepOutput = "";

  for (let i = 0; i < steps.length; i++)
  {
    const step = steps[i];
    let commandText = step.spec.command;
    if (extra && step.label === taskName)
    {
      // Drop our default flag when the caller passes the same one, so the
      // command line does not end up with two --timeout values.
      const extraFlags = extra.match(/--[a-z-]+/gi) || [];
      for (let f = 0; f < extraFlags.length; f++)
      {
        const flag = extraFlags[f];
        commandText = commandText.replace(new RegExp("\\s" + flag + "(\\s+[^\\s-][^\\s]*)?", "i"), "");
      }
      commandText += " " + extra;
    }

    const wrapped = withMsvc(commandText, step.spec.needsMsvc);
    if (!wrapped.ok)
    {
      return { ok: false, text: wrapped.reason };
    }

    const res = await runShell(root, wrapped.command, timeoutMs, signal);

    if (process.platform === "win32" && !res.timedOut)
    {
      const marked = extractExitMarker(res.stdout);
      if (marked.code !== null)
      {
        res.stdout = marked.stdout;
        res.code = marked.code;
      }
    }

    if (wrapped.msvc)
    {
      res.stdout = stripMsvcPreamble(res.stdout);
      res.stderr = stripMsvcPreamble(res.stderr);
    }

    const status = describeExitCode(res.code);
    lastCode = res.code;
    combined += res.stdout + "\n" + res.stderr + "\n";
    lastStepOutput = (res.stdout + "\n" + res.stderr).trim();

    parts.push("[" + step.label + "] " + commandText);
    parts.push(res.timedOut
      ? ("  killed after " + Math.round(timeoutMs / 1000) + "s timeout")
      : ("  exit code: " + (res.code === null ? "unknown" : res.code) + (status ? "  =>  " + status : "")));

    if (res.timedOut)
    {
      parts.push("  hint: the process exceeded the limit and its whole process group was killed. Check for a prompt, " +
        "a server that intentionally keeps running, a deadlock, or a test waiting on unavailable input; use a shorter " +
        "timeout and add progress logging to narrow down where it stopped.");
    }

    if (res.cancelled)
    {
      return {
        ok: false,
        cancelled: true,
        summary: taskName + " 취소됨",
        text: parts.join("\n") + "\n  cancelled by the user"
      };
    }
    if (res.code !== 0 || res.timedOut)
    {
      break;
    }
  }

  const diag = project.summarizeOutput(combined);
  const succeeded = lastCode === 0;
  const emptyTestRun = taskName === "test" && succeeded && diag.testFails.length === 0 && diag.ranNoTests;

  if (diag.errors.length > 0)
  {
    parts.push("--- " + diag.errors.length + " error(s) ---");
    parts.push(diag.errors.slice(0, 15).join("\n"));
    if (diag.errors.length > 15)
    {
      parts.push("... and " + (diag.errors.length - 15) + " more error(s)");
    }
  }
  if (diag.testFails.length > 0)
  {
    parts.push("--- " + diag.testFails.length + " test failure line(s) ---");
    parts.push(diag.testFails.slice(0, 15).join("\n"));
  }
  if (diag.warnings.length > 0)
  {
    parts.push("--- " + diag.warnings.length + " warning(s), first 5 ---");
    parts.push(diag.warnings.slice(0, 5).join("\n"));
  }

  // Keep the raw tail so the model can still read what actually happened.
  // Show the tail of the step that mattered: a long configure log would
  // otherwise push the actual build result out of view.
  const tail = (lastStepOutput || combined).trim().split(/\r?\n/).slice(-40).join("\n");
  parts.push("--- output (last lines) ---");
  parts.push(clip(tail, 6000));

  if (diag.linkError && !succeeded)
  {
    parts.push("--- unresolved symbol at link time ---");
    parts.push("A declaration was found and its definition was not. This is a project wiring problem, " +
      "not a broken toolchain: check that every source file defining the missing symbol is listed in the " +
      "target that needs it (add_executable / target_sources for CMake, ClCompile for a .vcxproj), that a " +
      "C function used from C++ is declared extern \"C\", and that any library it needs is linked. " +
      "Do not conclude the environment is at fault before the source list has been checked.");
  }

  if (emptyTestRun)
  {
    parts.push("--- no tests were executed ---");
    parts.push("The runner exited successfully but its output shows no sign that any test actually ran, " +
      "so nothing was verified. Check that test files or a test project exist and are being discovered; " +
      "do not report this as a passing test run.");
  }

  const summaryBits = [];
  summaryBits.push(emptyTestRun ? "test ran but found no tests" : (taskName + (succeeded ? " ok" : " failed")));
  if (diag.errors.length > 0)
  {
    summaryBits.push(diag.errors.length + " error(s)");
  }
  if (diag.testFails.length > 0)
  {
    summaryBits.push(diag.testFails.length + " test failure(s)");
  }
  if (diag.warnings.length > 0)
  {
    summaryBits.push(diag.warnings.length + " warning(s)");
  }

  return {
    ok: succeeded && diag.errors.length === 0 && diag.testFails.length === 0 && !emptyTestRun,
    summary: summaryBits.join(", "),
    text: parts.join("\n")
  };
}

async function toolBuildProject(root, args, signal)
{
  return runProjectTask(root, "build", args || {}, signal);
}

async function toolRunProject(root, args, signal)
{
  return runProjectTask(root, "run", args || {}, signal);
}

async function toolTestProject(root, args, signal)
{
  return runProjectTask(root, "test", args || {}, signal);
}

async function toolRunCommand(root, args, signal)
{
  const command = String(args.command || "").trim();
  if (!command)
  {
    return { ok: false, text: "command must not be empty" };
  }

  const timeoutMs = Math.min(600000, Math.max(1000, Number(args.timeout_ms) || DEFAULT_COMMAND_TIMEOUT_MS));
  const res = await runShell(root, command, timeoutMs, signal);

  if (res.cancelled)
  {
    return { ok: false, cancelled: true, summary: "취소됨", text: "$ " + command + "\ncancelled by the user" };
  }

  // Prefer the marker the shell printed: it carries the real NTSTATUS.
  if (process.platform === "win32" && !res.timedOut)
  {
    const marked = extractExitMarker(res.stdout);
    if (marked.code !== null)
    {
      res.stdout = marked.stdout;
      res.code = marked.code;
    }
  }

  const seconds = Math.round(timeoutMs / 100) / 10;
  const parts = [];
  parts.push("$ " + command);
  const status = describeExitCode(res.code);
  parts.push(res.timedOut
    ? ("killed after " + seconds + "s timeout")
    : ("exit code: " + (res.code === null ? "unknown" : res.code) + (status ? "  =>  " + status : "")));

  if (status && /crash/i.test(status))
  {
    const lines = [];
    lines.push("hint: the program did not exit normally, it crashed. Any output above stopped at the crash point, " +
      "so a successful compile says nothing about this.");

    if (/ACCESS_VIOLATION/.test(status))
    {
      lines.push("ACCESS_VIOLATION usually means one of: a pointer that was never assigned, use after delete, " +
        "an index past the end of a buffer, or an allocation whose size computed to 0. " +
        "Check every allocation size and growth step (capacity * 2 is still 0 when capacity starts at 0), " +
        "and check that each container's first insertion actually allocates storage. " +
        "To find the exact line, add prints around the first suspect operation and run again.");
    }
    else if (/STACK_OVERFLOW/.test(status))
    {
      lines.push("STACK_OVERFLOW points at unbounded recursion or a huge stack local; look for a base case that never fires.");
    }
    else if (/HEAP_CORRUPTION|STACK_BUFFER_OVERRUN/.test(status))
    {
      lines.push("This means memory was written out of bounds or freed twice; review the most recently changed buffer writes and delete calls.");
    }

    parts.push(lines.join(" "));
  }
  if (res.stdout.trim())
  {
    parts.push("--- stdout ---\n" + clipEnds(res.stdout.trim(), MAX_COMMAND_OUTPUT));
  }
  if (res.stderr.trim())
  {
    parts.push("--- stderr ---\n" + clipEnds(res.stderr.trim(), 6000));

    if (res.code === 126)
    {
      parts.push("hint: the file was found but is not executable. Check its execute bit (chmod +x) or invoke a script explicitly with bash/python.");
    }
    else if (res.code === 127)
    {
      parts.push("hint: Bash could not find a command. Check spelling with command -v; install the missing package instead of guessing a path.");
    }
  }
  if (!res.stdout.trim() && !res.stderr.trim())
  {
    parts.push("(no output)");

    // A silent non-zero exit gives the model nothing to work with, which is how
    // it ends up repeating the same broken command. Explain the likely cause.
    // A crash already got its own explanation above, and shell-syntax advice
    // there would only mislead.
    if (res.code !== 0 && !res.timedOut && !status)
    {
      const hints = [];
      hints.push("This shell is non-interactive Bash.");
      hints.push("Use && between dependent steps, quote paths with spaces, and remove output redirection while diagnosing the failure.");
      parts.push("hint: " + hints.join(" "));
    }
  }

  return {
    ok: res.code === 0 && !res.timedOut,
    summary: res.timedOut
      ? ("timeout " + seconds + "s")
      : (status ? ("crash " + status.split(" ")[0]) : ("exit " + (res.code === null ? "?" : res.code))),
    text: parts.join("\n")
  };
}

const HANDLERS =
{
  list_dir: toolListDir,
  read_file: toolReadFile,
  write_file: toolWriteFile,
  edit_file: toolEditFile,
  create_dir: toolCreateDir,
  delete_path: toolDeletePath,
  find_files: toolFindFiles,
  search_text: toolSearchText,
  replace_in_files: toolReplaceInFiles,
  build_project: toolBuildProject,
  run_project: toolRunProject,
  test_project: toolTestProject,
  run_command: toolRunCommand
};

// OpenAI-style tool schemas handed to LM Studio.
const SPECS =
[
  {
    type: "function",
    function:
    {
      name: "list_dir",
      description: "List entries of a directory inside the working folder. Use this first to understand the project layout.",
      parameters:
      {
        type: "object",
        properties:
        {
          path: { type: "string", description: "Directory path relative to the working folder. Use \".\" for the root." },
          depth: { type: "integer", description: "Recursion depth, 1-4. Default 1." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function:
    {
      name: "read_file",
      description: "Read a file from the working folder. Text files come back as numbered lines. " +
        "Set hex=true to inspect the raw bytes of a binary instead, which is how you check headers, " +
        "magic numbers and field offsets in an executable or any other binary format.",
      parameters:
      {
        type: "object",
        properties:
        {
          path: { type: "string", description: "File path relative to the working folder." },
          start_line: { type: "integer", description: "1-based first line to return. Default 1." },
          max_lines: { type: "integer", description: "How many lines to return. Default 4000." },
          hex: { type: "boolean", description: "Return a hex dump of the raw bytes instead of text. Works on binaries." },
          start_byte: { type: "integer", description: "With hex=true: byte offset to start at. Default 0." },
          max_bytes: { type: "integer", description: "With hex=true: how many bytes to dump. Default 256, maximum 4096." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function:
    {
      name: "write_file",
      description: "Create a file or replace its whole content. Parent directories are created automatically. Requires user approval.",
      parameters:
      {
        type: "object",
        properties:
        {
          path: { type: "string", description: "File path relative to the working folder." },
          content: { type: "string", description: "Full file content to write." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function:
    {
      name: "edit_file",
      description: "Replace an exact snippet inside an existing file. Read the file first so old_string matches byte for byte. Requires user approval.",
      parameters:
      {
        type: "object",
        properties:
        {
          path: { type: "string", description: "File path relative to the working folder." },
          old_string: { type: "string", description: "Exact text to replace, including indentation." },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." }
        },
        required: ["path", "old_string", "new_string"]
      }
    }
  },
  {
    type: "function",
    function:
    {
      name: "create_dir",
      description: "Create a directory inside the working folder. Requires user approval.",
      parameters:
      {
        type: "object",
        properties:
        {
          path: { type: "string", description: "Directory path relative to the working folder." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function:
    {
      name: "delete_path",
      description: "Delete a file or directory inside the working folder. Requires user approval.",
      parameters:
      {
        type: "object",
        properties:
        {
          path: { type: "string", description: "Path relative to the working folder." },
          recursive: { type: "boolean", description: "Delete a non-empty directory." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function:
    {
      name: "find_files",
      description: "Find files by name or glob pattern, for example *.cpp or src/**/*.h.",
      parameters:
      {
        type: "object",
        properties:
        {
          pattern: { type: "string", description: "Glob pattern such as *.cpp, CMakeLists.txt or src/**/*.h." },
          path: { type: "string", description: "Directory to search from. Default \".\"." },
          exclude: { type: "string", description: "Comma separated names or globs to leave out, for example \"third_party,build\". A bare name covers that whole subtree." },
          max_results: { type: "integer", description: "Maximum number of paths. Default 200." }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function:
    {
      name: "search_text",
      description: "Search file contents inside the working folder and return file:line matches.",
      parameters:
      {
        type: "object",
        properties:
        {
          query: { type: "string", description: "Text or regular expression to look for." },
          glob: { type: "string", description: "Restrict to files matching this glob, for example *.cpp." },
          path: { type: "string", description: "Directory to search from. Default \".\"." },
          exclude: { type: "string", description: "Comma separated names or globs to leave out, for example \"third_party,generated,*.min.js\". A bare name covers that whole subtree." },
          regex: { type: "boolean", description: "Treat query as a regular expression." },
          case_sensitive: { type: "boolean", description: "Case sensitive match. Default false." },
          max_results: { type: "integer", description: "Maximum number of hits. Default 80." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function:
    {
      name: "replace_in_files",
      description: "Replace text across many files at once, preserving each file's line endings and BOM. Use this instead of editing files one by one or rewriting files through the shell (sed -i), which corrupts encodings. When the text varies between files (different messages, names, numbers), use regex=true with a capture group and a $1 backreference so ONE call covers every variant instead of one call per literal. Requires user approval.",
      parameters:
      {
        type: "object",
        properties:
        {
          find: { type: "string", description: "Literal text (or regular expression when regex=true) to replace." },
          replace: { type: "string", description: "Replacement text. With regex=true you may use $1 style backreferences." },
          glob: { type: "string", description: "Restrict to files matching this glob, for example *.cpp." },
          path: { type: "string", description: "Directory to start from. Default \".\"." },
          exclude: { type: "string", description: "Comma separated names or globs this replace must not touch, for example \"third_party,vendor\". A bare name covers that whole subtree. Use this when told to leave something alone: it is the only way to say \"everywhere except here\", and files it covers are neither changed nor reported as leftover work." },
          regex: { type: "boolean", description: "Treat find as a regular expression." },
          case_sensitive: { type: "boolean", description: "Case sensitive match. Default false for regex, always exact for literals." },
          dry_run: { type: "boolean", description: "Report what would change without writing anything." }
        },
        required: ["find", "replace"]
      }
    }
  },
  {
    type: "function",
    function:
    {
      name: "build_project",
      description: "Build the project in the working folder. The app detects CMake, .NET, Cargo, npm, Makefile, Bash build scripts, or bare C/C++ sources, runs CMake configure first when needed, and reports compiler diagnostics as a short list. Prefer this over assembling a build command by hand. Requires user approval.",
      parameters:
      {
        type: "object",
        properties:
        {
          extra_args: { type: "string", description: "Extra arguments appended to the detected build command, for example --config Release." },
          timeout_ms: { type: "integer", description: "Timeout in milliseconds. Default 600000." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function:
    {
      name: "run_project",
      description: "Run the project in the working folder: npm start, dotnet run, cargo run, python entry point, or the executable the last build produced. Requires user approval.",
      parameters:
      {
        type: "object",
        properties:
        {
          args: { type: "string", description: "Arguments passed to the program." },
          timeout_ms: { type: "integer", description: "Timeout in milliseconds. Default 600000." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function:
    {
      name: "test_project",
      description: "Run the project's tests (ctest, npm test, node --test, dotnet test, cargo test, pytest) and report which ones failed. Requires user approval.",
      parameters:
      {
        type: "object",
        properties:
        {
          filter: { type: "string", description: "Extra arguments for the test runner, for example a name filter." },
          timeout_ms: { type: "integer", description: "Timeout in milliseconds. Default 600000." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function:
    {
      name: "run_command",
      description: "Run a non-interactive Bash command with the working folder as the current directory. Use it to build, test or run git. Requires user approval.",
      parameters:
      {
        type: "object",
        properties:
        {
          command: { type: "string", description: "Command line to execute." },
          timeout_ms: { type: "integer", description: "Timeout in milliseconds. Default 120000." }
        },
        required: ["command"]
      }
    }
  }
];

// Short human-facing label shown in the chat bubble for a tool call.
function describeCall(name, args)
{
  const a = args || {};
  if (name === "list_dir")
  {
    return String(a.path || ".");
  }
  if (name === "read_file" || name === "create_dir" || name === "delete_path" || name === "write_file")
  {
    return String(a.path || "");
  }
  if (name === "edit_file")
  {
    return String(a.path || "");
  }
  if (name === "find_files")
  {
    return String(a.pattern || "");
  }
  if (name === "search_text")
  {
    return String(a.query || "").slice(0, 60);
  }
  if (name === "replace_in_files")
  {
    return String(a.find || "").slice(0, 40) + " -> " + String(a.replace || "").slice(0, 40) +
      (a.glob ? "  [" + a.glob + "]" : "") +
      (a.exclude ? "  [not " + String(a.exclude).slice(0, 40) + "]" : "");
  }
  if (name === "build_project" || name === "run_project" || name === "test_project")
  {
    return String(a.extra_args || a.args || a.filter || "").slice(0, 80);
  }
  if (name === "run_command")
  {
    return String(a.command || "").slice(0, 120);
  }
  return "";
}

// Filesystem errors reach the model as raw errno strings with absolute paths.
// Name the likely cause and keep paths workspace-relative.
function friendlyFsError(err, root)
{
  const code = err && err.code;
  let msg = String((err && err.message) || err);

  try
  {
    const abs = path.resolve(root);
    msg = msg.split(abs + path.sep).join("").split(abs).join(".");
  }
  catch (e)
  {
    // leave the message as it is
  }

  if (code === "EPERM" || code === "EACCES")
  {
    return "permission denied (" + msg + "). The file is most likely read-only or held by another process; " +
      "check write permission (chmod u+w), close whatever holds it, or write to a different path.";
  }
  if (code === "EBUSY")
  {
    return "the file is in use by another process (" + msg + ").";
  }
  if (code === "ENOSPC")
  {
    return "the disk is full (" + msg + ").";
  }
  if (code === "EISDIR")
  {
    return "that path is a directory, not a file (" + msg + ").";
  }
  if (code === "ENOTEMPTY")
  {
    return "the directory is not empty (" + msg + "); pass recursive=true to remove it with its contents.";
  }
  if (code === "EMFILE" || code === "ENFILE")
  {
    return "too many open files (" + msg + "); retry in a moment.";
  }
  return msg;
}

// Command-shaped tools put the verdict on the last line, so their results are
// clipped from the middle. File and search results read from the top.
const TAIL_MATTERS = new Set(["run_command", "build_project", "run_project", "test_project"]);

async function execute(root, name, args, signal, limits)
{
  const handler = HANDLERS[name];
  if (!handler)
  {
    return { ok: false, text: "unknown tool: " + name };
  }

  let result = null;
  try
  {
    result = await handler(root, args || {}, signal);
  }
  catch (err)
  {
    result = { ok: false, text: "tool error: " + friendlyFsError(err, root) };
  }

  // The caller sizes this against the model's context. A fixed cap can be
  // larger than the whole conversation budget on a small-context model.
  const asked = limits && Number(limits.maxChars) > 0 ? Math.floor(limits.maxChars) : MAX_RESULT_CHARS;
  const cap = Math.min(MAX_RESULT_CHARS, Math.max(1200, asked));

  result.text = TAIL_MATTERS.has(name)
    ? clipEnds(result.text || "", cap)
    : clip(result.text || "", cap);
  if (!result.summary)
  {
    result.summary = result.ok ? "done" : "failed";
  }
  return result;
}

// Half of this schema is prose, and most of that prose was added because of a
// specific observed failure. Whether any of it still earns its tokens was
// finally measurable once the suite had a pass-rate baseline, so it was
// measured: every description cut to its first sentence, keeping the mechanical
// facts and dropping the guidance. That saves 1,930 characters, about 644
// tokens, which is 23% of the schema and would have grown the history budget by
// the same amount.
//
// The raw totals said take it: 96 of 108 scenario runs passed lean against 92
// for the full schema. Judged against the baseline instead, four scenarios that
// had never failed did:
//
//   binary-asset-guard  3/3 -> 2/3      go-module-slug     3/3 -> 2/3
//   greenfield-cmake    3/3 -> 2/3      huge-log-analysis  3/3 -> 2/3
//
// binary-asset-guard is the one that settled it. Without the guidance the model
// edited the header to claim 48 rows while the binary still held 32, and
// reported the job done - the exact shape that check was added to catch.
//
// Two behavioural shifts were visible before that, over five scenarios run three
// times each: exclude went from used twice to never, and edit_file went from 6
// calls to 10 while replace_in_files fell from 25 to 21. Looping edit_file over
// many files is what corrupts encodings, so the prose is buying a safer pattern
// even where the checks come out even.
//
// Strictly, 0 failures in 81 reliable-scenario runs against 4 is p = 0.12, so
// this is not proof on its own. It is one weak signal pointing the same way as
// two measured behaviour changes and one safety failure, and the saving is 644
// tokens. Keeping the prose.

module.exports =
{
  SPECS: SPECS,
  execute: execute,
  isMutating: isMutating,
  describeCall: describeCall,
  resolveInside: resolveInside,
  outsidePaths: outsidePaths,
  binaryWrites: binaryWrites,
  workspaceRisk: workspaceRisk,
  MAX_RESULT_CHARS: MAX_RESULT_CHARS,
  // Exported for the regression tests: build output can carry two encodings in
  // one stream, and decoding it as a single blob mangled half of it.
  decodeOutput: decodeOutput,
  // Exported for the regression tests: an empty build directory used to disable
  // configure permanently, and running a real cmake build to prove that stays
  // fixed would put ten seconds into a suite that finishes in two.
  needsConfigure: needsConfigure
};
