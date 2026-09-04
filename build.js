"use strict";

// Ubuntu portable build:
//   node build.js              portable folder + single Node SEA executable
//   node build.js --folder     portable folder only
//   node build.js --exe        single executable only
//   node build.js --no-archive skip .tar.gz archives
//   node build.js --out DIR    output directory (default ./dist)

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = __dirname;
const APP_NAME = "oh-my-qwen";
const PLATFORM_TAG = "linux-" + process.arch;
const ENTRY = "server.js";
const UI_FILES = ["index.html", "app.js", "styles.css"];
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const PORTABLE_MARKER_TEXT = [
  "oh-my-qwen portable mode",
  "",
  "While this file (or a data directory) sits next to the app, settings and chat",
  "history are written to ./data instead of $XDG_CONFIG_HOME/oh-my-qwen.",
  "Delete both to use the normal per-user configuration directory.",
  "You can also set OMQ_DATA_DIR to an explicit location.",
  ""
].join("\n");

const FOLDER_LAUNCHER = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  'OMQ_HOME="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
  'if [[ ! -x "$OMQ_HOME/node" ]]; then',
  '  echo "[oh-my-qwen] bundled node runtime is missing or not executable" >&2',
  "  exit 1",
  "fi",
  'exec "$OMQ_HOME/node" "$OMQ_HOME/app/server.js" "$@"',
  ""
].join("\n");

function parseArgs(argv)
{
  const opts = { folder: false, exe: false, archive: true, out: path.join(ROOT, "dist") };
  for (let i = 2; i < argv.length; i++)
  {
    const arg = argv[i];
    if (arg === "--folder")
    {
      opts.folder = true;
    }
    else if (arg === "--exe")
    {
      opts.exe = true;
    }
    else if (arg === "--no-archive")
    {
      opts.archive = false;
    }
    else if (arg === "--out" && argv[i + 1])
    {
      opts.out = path.resolve(argv[++i]);
    }
    else if (arg === "--help" || arg === "-h")
    {
      opts.help = true;
    }
    else
    {
      throw new Error("unknown option: " + arg);
    }
  }
  if (!opts.folder && !opts.exe)
  {
    opts.folder = true;
    opts.exe = true;
  }
  return opts;
}

function log(step, message)
{
  process.stdout.write("[" + step + "] " + message + "\n");
}

function human(bytes)
{
  if (bytes >= 1024 * 1024)
  {
    return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
  }
  return Math.ceil(bytes / 1024) + " KiB";
}

async function rmrf(target)
{
  await fsp.rm(target, { recursive: true, force: true });
}

async function mkdirp(target)
{
  await fsp.mkdir(target, { recursive: true });
}

async function copyFile(from, to, mode)
{
  await mkdirp(path.dirname(to));
  await fsp.copyFile(from, to);
  if (mode !== undefined)
  {
    await fsp.chmod(to, mode);
  }
}

function run(file, args, options)
{
  return new Promise(function (resolve)
  {
    let child;
    try
    {
      child = spawn(file, args, Object.assign(
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"]
      }, options || {}));
    }
    catch (err)
    {
      resolve({ code: -1, stdout: "", stderr: "spawn failed: " + err.message });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", function (data) { stdout += data.toString("utf8"); });
    child.stderr.on("data", function (data) { stderr += data.toString("utf8"); });
    child.on("error", function (err)
    {
      resolve({ code: -1, stdout: stdout, stderr: "process error: " + err.message });
    });
    child.on("close", function (code)
    {
      resolve({ code: code, stdout: stdout, stderr: stderr });
    });
  });
}

const LOADER_HEAD = [
  '"use strict";',
  "(function ()",
  "{",
  '  const __path = require("path");',
  "  const __sea = (function ()",
  "  {",
  "    try",
  "    {",
  '      const mod = require("node:sea");',
  '      return (mod && typeof mod.isSea === "function" && mod.isSea()) ? mod : null;',
  "    }",
  "    catch (err)",
  "    {",
  "      return null;",
  "    }",
  "  })();",
  "  const __appDir = __sea ? __path.dirname(process.execPath) : __dirname;",
  "  const __defs = {};",
  "  const __cache = {};",
  "",
  "  function __resolve(fromId, spec)",
  "  {",
  '    if (typeof spec !== "string" || spec.charAt(0) !== ".")',
  "    {",
  "      return null;",
  "    }",
  "    const base = __path.posix.dirname(fromId);",
  "    const id = __path.posix.normalize(__path.posix.join(base, spec));",
  "    if (__defs[id]) { return id; }",
  '    if (__defs[id + ".js"]) { return id + ".js"; }',
  '    if (__defs[id + "/index.js"]) { return id + "/index.js"; }',
  "    return null;",
  "  }",
  "",
  "  function __makeRequire(fromId)",
  "  {",
  "    const fn = function (spec)",
  "    {",
  "      const id = __resolve(fromId, spec);",
  "      return id ? __load(id) : require(spec);",
  "    };",
  "    fn.resolve = function (spec) { return __resolve(fromId, spec) || require.resolve(spec); };",
  "    fn.cache = __cache;",
  "    return fn;",
  "  }",
  "",
  "  function __nativePath(id)",
  "  {",
  '    return __path.join(__appDir, id.split("/").join(__path.sep));',
  "  }",
  "",
  "  function __load(id)",
  "  {",
  "    if (__cache[id]) { return __cache[id].exports; }",
  "    const mod = { id: id, exports: {}, loaded: false };",
  "    __cache[id] = mod;",
  "    const dir = __path.posix.dirname(id);",
  '    const nativeDir = dir === "." ? __appDir : __nativePath(dir);',
  "    __defs[id](mod, mod.exports, __makeRequire(id), nativeDir, __nativePath(id));",
  "    mod.loaded = true;",
  "    return mod.exports;",
  "  }",
  ""
].join("\n");

function nativeOf(id)
{
  return path.join(ROOT, id.split("/").join(path.sep));
}

function resolveModuleId(fromId, spec)
{
  const base = path.posix.dirname(fromId);
  const joined = path.posix.normalize(path.posix.join(base, spec));
  const candidates = [joined, joined + ".js", joined + "/index.js"];
  return candidates.filter(function (id)
  {
    return /\.js$/.test(id) && fs.existsSync(nativeOf(id));
  })[0] || null;
}

async function collectModules(entry)
{
  const seen = new Set();
  const order = [];

  async function visit(id)
  {
    if (seen.has(id))
    {
      return;
    }
    seen.add(id);
    const source = await fsp.readFile(nativeOf(id), "utf8");
    order.push(id);
    const re = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
    let match = re.exec(source);
    while (match)
    {
      const dependency = resolveModuleId(id, match[1]);
      if (!dependency)
      {
        throw new Error(id + " requires unresolved module " + match[1]);
      }
      await visit(dependency);
      match = re.exec(source);
    }
  }

  await visit(entry);
  return order;
}

async function bundle(outFile, modules)
{
  const parts = [LOADER_HEAD];
  for (let i = 0; i < modules.length; i++)
  {
    const id = modules[i];
    const source = (await fsp.readFile(nativeOf(id), "utf8")).replace(/\r\n/g, "\n");
    parts.push("  __defs[" + JSON.stringify(id) + "] = function (module, exports, require, __dirname, __filename)");
    parts.push("  {");
    parts.push(source);
    parts.push("  };");
    parts.push("");
  }
  parts.push("  __load(" + JSON.stringify(modules[0]) + ");");
  parts.push("})();");
  parts.push("");

  await mkdirp(path.dirname(outFile));
  await fsp.writeFile(outFile, parts.join("\n"), "utf8");
  const checked = await run(process.execPath, ["--check", outFile]);
  if (checked.code !== 0)
  {
    throw new Error("bundle syntax check failed:\n" + checked.stderr.slice(0, 2000));
  }
}

async function copyRuntimeTree(target)
{
  await copyFile(path.join(ROOT, "server.js"), path.join(target, "server.js"));
  await fsp.cp(path.join(ROOT, "src"), path.join(target, "src"), { recursive: true });
  await fsp.cp(path.join(ROOT, "public"), path.join(target, "public"), { recursive: true });
}

async function directorySize(dir)
{
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++)
  {
    const full = path.join(dir, entries[i].name);
    total += entries[i].isDirectory() ? await directorySize(full) : (await fsp.stat(full)).size;
  }
  return total;
}

async function buildFolder(opts)
{
  const dir = path.join(opts.out, APP_NAME + "-portable");
  await rmrf(dir);
  await mkdirp(path.join(dir, "app"));
  await copyFile(process.execPath, path.join(dir, "node"), 0o755);
  await copyRuntimeTree(path.join(dir, "app"));
  await fsp.writeFile(path.join(dir, APP_NAME), FOLDER_LAUNCHER, { encoding: "utf8", mode: 0o755 });
  await fsp.writeFile(path.join(dir, "portable.txt"), PORTABLE_MARKER_TEXT, "utf8");
  for (const readme of ["README.md", "README.ko.md"])
  {
    if (fs.existsSync(path.join(ROOT, readme)))
    {
      await copyFile(path.join(ROOT, readme), path.join(dir, readme));
    }
  }
  log("folder", "ready: " + dir + " (" + human(await directorySize(dir)) + ")");
  return dir;
}

function findPostject()
{
  const local = path.join(ROOT, "node_modules", "postject", "dist", "cli.js");
  if (fs.existsSync(local))
  {
    return { file: process.execPath, args: [local] };
  }
  const probe = spawnSync("npx", ["--yes", "postject", "--help"],
    { cwd: ROOT, encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"] });
  if (probe.status === 0 || /postject/i.test(String(probe.stdout) + String(probe.stderr)))
  {
    return { file: "npx", args: ["--yes", "postject"] };
  }
  return null;
}

async function buildExecutable(opts, bundleFile)
{
  const work = path.join(opts.out, "build");
  const blobFile = path.join(work, "sea-prep.blob");
  const configFile = path.join(work, "sea-config.json");
  const exeFile = path.join(opts.out, APP_NAME);
  const assets = {};
  UI_FILES.forEach(function (name) { assets[name] = path.join(ROOT, "public", name); });
  const config =
  {
    main: bundleFile,
    output: blobFile,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets: assets
  };
  await fsp.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");

  const blob = await run(process.execPath, ["--experimental-sea-config", configFile]);
  if (blob.code !== 0 || !fs.existsSync(blobFile))
  {
    throw new Error("SEA blob generation failed:\n" + (blob.stderr || blob.stdout).slice(0, 2000));
  }

  await rmrf(exeFile);
  await copyFile(process.execPath, exeFile, 0o755);
  const postject = findPostject();
  if (!postject)
  {
    throw new Error("postject is unavailable; run npm install --save-dev postject or build --folder");
  }
  const injected = await run(postject.file, postject.args.concat([
    exeFile, "NODE_SEA_BLOB", blobFile, "--sentinel-fuse", SEA_FUSE
  ]));
  if (injected.code !== 0)
  {
    await rmrf(exeFile);
    throw new Error("postject failed:\n" + (injected.stderr || injected.stdout).slice(0, 2000));
  }
  await fsp.chmod(exeFile, 0o755);
  await fsp.writeFile(path.join(opts.out, "portable.txt"), PORTABLE_MARKER_TEXT, "utf8");
  log("exe", "ready: " + exeFile + " (" + human((await fsp.stat(exeFile)).size) + ")");
  return exeFile;
}

async function killTree(pid)
{
  if (!pid)
  {
    return;
  }
  try
  {
    process.kill(-pid, "SIGKILL");
  }
  catch (err)
  {
    // Already gone.
  }
}

async function smokeTest(label, file, args, cwd)
{
  const port = 8900 + Number(process.hrtime.bigint() % 90n);
  const child = spawn(file, args.concat(["--port", String(port), "--no-open"]),
    { cwd: cwd || path.dirname(file), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", function (data) { out += data.toString("utf8"); });
  child.stderr.on("data", function (data) { out += data.toString("utf8"); });
  child.on("error", function (err) { out += "spawn failed: " + err.message + "\n"; });

  const base = "http://127.0.0.1:" + port;
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++)
  {
    await new Promise(function (resolve) { setTimeout(resolve, 250); });
    try
    {
      ready = (await fetch(base + "/api/state")).ok;
    }
    catch (err)
    {
      // Server is still starting.
    }
  }

  let uiOk = false;
  if (ready)
  {
    const html = await (await fetch(base + "/")).text();
    const css = await (await fetch(base + "/styles.css")).text();
    const js = await (await fetch(base + "/app.js")).text();
    uiOk = /oh-my-qwen/.test(html) && css.length > 1000 && js.length > 1000;
  }
  await killTree(child.pid);
  if (!ready || !uiOk)
  {
    throw new Error(label + " smoke test failed\n" + out.slice(0, 1500));
  }
  log("test", label + " ok");
}

async function archive(source, output, contentsOnly)
{
  await rmrf(output);
  const parent = path.dirname(source);
  const args = contentsOnly
    ? ["-czf", output, "-C", source, "."]
    : ["-czf", output, "-C", parent, path.basename(source)];
  const result = await run("tar", args);
  if (result.code !== 0)
  {
    throw new Error("tar failed:\n" + (result.stderr || result.stdout).slice(0, 1000));
  }
  log("archive", "ready: " + output);
}

async function main()
{
  if (process.platform !== "linux")
  {
    throw new Error("Ubuntu build must run with a native Linux Node.js runtime (current platform: " + process.platform + ")");
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20)
  {
    throw new Error("Node.js 20 or newer is required");
  }

  const opts = parseArgs(process.argv);
  if (opts.help)
  {
    process.stdout.write("Usage: node build.js [--folder] [--exe] [--no-archive] [--out DIR]\n");
    return;
  }

  await mkdirp(opts.out);
  const modules = await collectModules(ENTRY);
  const bundleFile = path.join(opts.out, "build", APP_NAME + ".bundle.js");
  await bundle(bundleFile, modules);
  log("bundle", modules.length + " modules");

  if (opts.folder)
  {
    const dir = await buildFolder(opts);
    await smokeTest("portable folder", path.join(dir, APP_NAME), [], dir);
    await rmrf(path.join(dir, "data"));
    if (opts.archive)
    {
      await archive(dir, path.join(opts.out, APP_NAME + "-portable-" + PLATFORM_TAG + ".tar.gz"), false);
    }
  }

  if (opts.exe)
  {
    const executable = await buildExecutable(opts, bundleFile);
    await smokeTest("single executable", executable, [], opts.out);
    await rmrf(path.join(opts.out, "data"));
    if (opts.archive)
    {
      const stage = path.join(opts.out, "build", "single-package");
      await rmrf(stage);
      await mkdirp(stage);
      await copyFile(executable, path.join(stage, APP_NAME), 0o755);
      await fsp.writeFile(path.join(stage, "portable.txt"), PORTABLE_MARKER_TEXT, "utf8");
      for (const readme of ["README.md", "README.ko.md"])
      {
        if (fs.existsSync(path.join(ROOT, readme)))
        {
          await copyFile(path.join(ROOT, readme), path.join(stage, readme));
        }
      }
      await archive(stage, path.join(opts.out, APP_NAME + "-" + PLATFORM_TAG + ".tar.gz"), true);
    }
  }

  log("done", "artifacts are in " + opts.out);
}

main().catch(function (err)
{
  process.stderr.write("[build] " + (err && err.stack ? err.stack : err) + "\n");
  process.exit(1);
});
