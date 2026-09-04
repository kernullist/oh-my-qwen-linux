"use strict";

// The three modules nothing else touches:
//
//   node tests/native.js
//
// tests/unit.js exercises the tool layer, tests/http.js the routes, and
// tests/run.js the agent loop. None of them reach logger.js, picker.js or
// assets.js - about 550 lines, all of it on the path a real user takes. The
// logger is the only record of why a windowless build died, the picker is the
// button the operator complained about, and assets.js is the guard between a
// URL and the filesystem.
//
// logger.js installs process handlers and replaces the global console, so it is
// tested by spawning real processes rather than requiring it. That also covers
// the one thing that matters most: whether a fatal error reaches the file
// before the process goes away.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

const results = [];
let currentGroup = "";

function group(name)
{
  currentGroup = name;
}

function ok(label, condition, detail)
{
  results.push({
    group: currentGroup,
    label: label,
    ok: !!condition,
    detail: condition ? "" : String(detail === undefined ? "" : detail)
  });
}

function skip(label, why)
{
  results.push({ group: currentGroup, label: label, ok: true, skipped: why, detail: "" });
}

function rmrf(dir)
{
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* gone */ }
}

function scratch(name)
{
  const dir = path.join(os.tmpdir(), "omq-native-" + name);
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Runs a snippet in a child process with its own data folder, so the logger
// writes somewhere disposable and the global console damage stays contained.
function runChild(dataDir, code, opts)
{
  const options = opts || {};
  const file = path.join(dataDir, "child-" + (options.tag || "x") + ".js");
  fs.writeFileSync(file, code, "utf8");

  const res = spawnSync(process.execPath, [file],
    {
      cwd: ROOT,
      env: Object.assign({}, process.env, { OMQ_DATA_DIR: dataDir }),
      encoding: "utf8",
      timeout: options.timeoutMs || 20000,
      windowsHide: true
    });

  return {
    code: typeof res.status === "number" ? res.status : -1,
    out: String(res.stdout || ""),
    err: String(res.stderr || "")
  };
}

// ---------------------------------------------------------------------------
// assets.js
// ---------------------------------------------------------------------------

async function testAssets()
{
  group("assets: request normalising");

  const assets = require("../src/assets");

  ok("the root becomes the page", assets.normalizeRequest("/") === "index.html",
    String(assets.normalizeRequest("/")));
  ok("an empty path becomes the page", assets.normalizeRequest("") === "index.html",
    String(assets.normalizeRequest("")));
  ok("a plain name passes through", assets.normalizeRequest("/app.js") === "app.js",
    String(assets.normalizeRequest("/app.js")));
  ok("a query string is dropped", assets.normalizeRequest("/app.js?v=2") === "app.js",
    String(assets.normalizeRequest("/app.js?v=2")));
  ok("a fragment is dropped", assets.normalizeRequest("/app.js#top") === "app.js",
    String(assets.normalizeRequest("/app.js#top")));
  ok("backslashes are normalised", assets.normalizeRequest("/sub\\file.css") === "sub/file.css",
    String(assets.normalizeRequest("/sub\\file.css")));
  ok("doubled slashes collapse", assets.normalizeRequest("//app.js") === "app.js",
    String(assets.normalizeRequest("//app.js")));
  ok("a single dot segment is dropped", assets.normalizeRequest("/./app.js") === "app.js",
    String(assets.normalizeRequest("/./app.js")));

  // Traversal is the whole reason this function exists.
  const escapes = ["/../server.js", "/sub/../../server.js", "/%2e%2e/server.js",
    "/..%2Fserver.js", "/....//../server.js"];
  for (let i = 0; i < escapes.length; i++)
  {
    ok("refuses traversal: " + escapes[i], assets.normalizeRequest(escapes[i]) === null,
      String(assets.normalizeRequest(escapes[i])));
  }

  // A percent sequence that does not decode must be refused, not passed on raw.
  ok("refuses a broken percent escape", assets.normalizeRequest("/%zz") === null,
    String(assets.normalizeRequest("/%zz")));

  group("assets: reading");

  const dir = scratch("assets");
  fs.mkdirSync(path.join(dir, "public", "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "public", "index.html"), "<h1>hi</h1>", "utf8");
  fs.writeFileSync(path.join(dir, "public", "sub", "x.css"), "body{}", "utf8");
  fs.writeFileSync(path.join(dir, "secret.txt"), "not for the browser", "utf8");
  const pub = path.join(dir, "public");

  const index = await assets.read("/", pub);
  ok("serves the page from the public folder", index && index.toString("utf8") === "<h1>hi</h1>",
    index ? index.toString("utf8") : "null");

  const nested = await assets.read("/sub/x.css", pub);
  ok("serves a nested file", nested && nested.toString("utf8") === "body{}",
    nested ? nested.toString("utf8") : "null");

  const missing = await assets.read("/nope.txt", pub);
  ok("a missing file is null, not a throw", missing === null, String(missing));

  const outside = await assets.read("/../secret.txt", pub);
  ok("a file above the public folder is refused", outside === null,
    outside ? outside.toString("utf8") : "null");

  // Symlink-free belt and braces: even a name that resolves out is refused by
  // the prefix check rather than read.
  const sneaky = await assets.read("/sub/../../secret.txt", pub);
  ok("and so is a path that climbs out through a subfolder", sneaky === null,
    sneaky ? sneaky.toString("utf8") : "null");

  ok("a checkout is not reported as an embedded build", assets.isEmbedded() === false,
    String(assets.isEmbedded()));

  // The comment on EMBEDDED says to keep it in sync with build.js, and nothing
  // enforced that. Two lists that must agree and never check each other is how
  // a portable build ends up serving a blank page.
  const buildSrc = fs.readFileSync(path.join(ROOT, "build.js"), "utf8");
  const missingFromBuild = assets.EMBEDDED.filter(function (name)
  {
    return buildSrc.indexOf("\"" + name + "\"") < 0;
  });
  ok("every embedded asset is named in build.js", missingFromBuild.length === 0,
    "not found in build.js: " + missingFromBuild.join(", "));

  const publicFiles = fs.readdirSync(path.join(ROOT, "public"));
  const notEmbedded = publicFiles.filter(function (name)
  {
    return /\.(html|js|css)$/i.test(name) && assets.EMBEDDED.indexOf(name) < 0;
  });
  ok("every shipped UI file is in the embedded list", notEmbedded.length === 0,
    "in public/ but not embedded: " + notEmbedded.join(", "));

  rmrf(dir);
}

// ---------------------------------------------------------------------------
// picker.js
// ---------------------------------------------------------------------------

function testPicker()
{
  group("picker: Ubuntu dialog command lines");

  const picker = require("../src/picker");

  const zenityArgs = picker.buildArgs("zenity", "/home/user/project");
  ok("zenity is asked for a directory",
    zenityArgs.indexOf("--file-selection") >= 0 && zenityArgs.indexOf("--directory") >= 0,
    zenityArgs.join(" "));
  ok("zenity receives the starting directory",
    zenityArgs.some(function (arg) { return arg === "--filename=/home/user/project/"; }),
    zenityArgs.join(" "));

  const kdeArgs = picker.buildArgs("kdialog", "/home/user/project");
  ok("kdialog is asked for an existing directory",
    kdeArgs[0] === "--getexistingdirectory" && kdeArgs[1] === "/home/user/project",
    kdeArgs.join(" "));

  // 1,200 characters of PowerShell built by string concatenation, and nothing
  // checked that it parses. A typo in it makes the folder button dead and every
  // other test in this repository still passes.
  if (process.platform !== "win32")
  {
    const backend = picker.resolveBackend();
    ok("backend discovery is safe when GUI helpers are absent",
      backend === null || backend.name === "zenity" || backend.name === "kdialog",
      JSON.stringify(backend));
  }
  else
  {
    const dir = scratch("picker");
    const file = path.join(dir, "dialog.ps1");
    fs.writeFileSync(file, picker.PS_SCRIPT, "utf8");

    const probe =
      "$errs = $null; " +
      "[System.Management.Automation.Language.Parser]::ParseFile(" +
      "(Resolve-Path '" + file.split("\\").join("/") + "').Path, [ref]$null, [ref]$errs) | Out-Null; " +
      "if ($errs -and $errs.Count -gt 0) { $errs | ForEach-Object { $_.Message }; exit 1 } else { 'PARSE_OK' }";

    let checked = 0;
    for (const shell of ["powershell.exe", "pwsh.exe"])
    {
      const res = spawnSync(shell, ["-NoLogo", "-NoProfile", "-Command", probe],
        { encoding: "utf8", windowsHide: true, timeout: 60000 });
      if (res.error && res.error.code === "ENOENT")
      {
        skip("the script parses in " + shell, "not installed");
        continue;
      }
      checked++;
      const text = String(res.stdout || "") + String(res.stderr || "");
      ok("the script parses in " + shell, /PARSE_OK/.test(text), text.trim().slice(0, 300));
    }
    ok("at least one PowerShell was available to check with", checked > 0,
      "neither powershell.exe nor pwsh.exe could be run");

    rmrf(dir);
  }

  group("picker: cancel versus a broken dialog");

  const interpret = picker.interpretDialogOutput;

  const picked = interpret("D:\\work\\game\n", "", 0, "pwsh.exe");
  ok("a selected path comes back as a path", picked.ok === true && picked.path === "D:\\work\\game",
    JSON.stringify(picked));
  ok("and names the backend that produced it", picked.backend === "pwsh.exe", JSON.stringify(picked));

  const cancelled = interpret("", "", 0, "pwsh.exe");
  ok("a clean exit with no path is a cancel",
    cancelled.ok === false && cancelled.reason === "cancelled", JSON.stringify(cancelled));

  const broken = interpret("", "Add-Type : could not load System.Windows.Forms", 1, "pwsh.exe");
  ok("a non-zero exit is a broken dialog, not a cancel",
    broken.ok === false && broken.reason === "dialog_failed", JSON.stringify(broken));
  ok("and carries the shell's own complaint", /System\.Windows\.Forms/.test(broken.message),
    JSON.stringify(broken));

  const quiet = interpret("", "", 3, "pwsh.exe");
  ok("a silent non-zero exit still reports the code", broken.ok === false &&
    /exit code 3/.test(quiet.message), JSON.stringify(quiet));

  // This is the case that used to come back wrong: the path was read off stdout
  // before the exit code was looked at, so a shell that failed while printing
  // anything at all was reported as a successful pick, and the caller would
  // have registered a working folder that nobody chose.
  const failedButNoisy = interpret("Cannot find type [Omq.Fg]\n", "", 1, "pwsh.exe");
  ok("output from a failed shell is not mistaken for a chosen folder",
    failedButNoisy.ok === false && failedButNoisy.reason === "dialog_failed",
    JSON.stringify(failedButNoisy));

  const trailing = interpret("WARNING: something\nD:\\picked\n\n", "", 0, "pwsh.exe");
  ok("the last line is taken when the shell chatters first",
    trailing.ok === true && trailing.path === "D:\\picked", JSON.stringify(trailing));

  const longErr = interpret("", "x".repeat(900), 1, "pwsh.exe");
  ok("a runaway error message is clipped", longErr.message.length <= 300,
    "length " + longErr.message.length);

  ok("no output and no code at all does not throw",
    interpret(undefined, undefined, 0, "pwsh.exe").reason === "cancelled", "");
}

// ---------------------------------------------------------------------------
// logger.js
// ---------------------------------------------------------------------------

function testLogger()
{
  group("logger: what reaches the file");

  const dir = scratch("logger");
  const logFile = path.join(dir, "oh-my-qwen.log");

  const basic = runChild(dir, [
    "const logger = require(" + JSON.stringify(path.join(ROOT, "src", "logger").split("\\").join("/")) + ");",
    "const file = logger.install();",
    "console.log('plain message');",
    "console.warn('a warning');",
    "console.error('an error');",
    "console.log('with an object', { a: 1, b: 'two' });",
    "console.log('with an error', new Error('boom'));",
    "const circular = { name: 'loop' }; circular.self = circular;",
    "console.log('with a circular object', circular);",
    "process.stdout.write('LOGFILE=' + file + '\\n');"
  ].join("\n"), { tag: "basic" });

  ok("install() returns a path and the child exits cleanly", basic.code === 0,
    "exit " + basic.code + " " + basic.err.slice(0, 200));
  ok("the log lands in the data folder", /LOGFILE=/.test(basic.out) &&
    basic.out.indexOf(dir) >= 0, basic.out.slice(0, 200));
  ok("the file exists", fs.existsSync(logFile), logFile);

  const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";

  ok("console.log is recorded as INFO", /INFO\s+plain message/.test(text), text.slice(0, 300));
  ok("console.warn is recorded as WARN", /WARN\s+a warning/.test(text), text.slice(0, 300));
  ok("console.error is recorded as ERROR", /ERROR\s+an error/.test(text), text.slice(0, 300));
  ok("every line is timestamped", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /m.test(text),
    text.split("\n")[0]);
  ok("the console still receives it too", /plain message/.test(basic.out), basic.out.slice(0, 200));

  ok("a plain object is serialised as JSON", /\{"a":1,"b":"two"\}/.test(text), text.slice(0, 400));
  // String() on an object that JSON cannot take gives "[object Object]", which
  // is no information at all in the file that explains a silent death.
  ok("nothing is reduced to [object Object]", !/\[object Object\]/.test(text),
    (text.match(/^.*\[object Object\].*$/m) || [""])[0]);
  ok("an Error argument records its stack", /Error: boom/.test(text) && /at /.test(text),
    text.slice(0, 400));
  // A circular object throws inside JSON.stringify, and the logger has to
  // survive that: a log line is never worth taking the process down for.
  ok("a circular object does not break the line", /with a circular object/.test(text),
    text.slice(-300));
  ok("and the cycle is described rather than swallowed",
    /Circular/.test(text) && /loop/.test(text),
    (text.match(/^.*with a circular object.*$/m) || [""])[0]);

  group("logger: rotation");

  const rotDir = scratch("logger-rot");
  const rotFile = path.join(rotDir, "oh-my-qwen.log");
  fs.writeFileSync(rotFile, "x".repeat(2 * 1024 * 1024 + 10), "utf8");

  const rotated = runChild(rotDir, [
    "const logger = require(" + JSON.stringify(path.join(ROOT, "src", "logger").split("\\").join("/")) + ");",
    "logger.install();",
    "console.log('after rotation');"
  ].join("\n"), { tag: "rot" });

  ok("the child survives a rotation", rotated.code === 0, "exit " + rotated.code + " " + rotated.err.slice(0, 200));
  ok("the oversized log is moved aside", fs.existsSync(rotFile + ".1"), "no .1 file");
  const fresh = fs.existsSync(rotFile) ? fs.readFileSync(rotFile, "utf8") : "";
  ok("and a fresh one starts", /after rotation/.test(fresh) && fresh.length < 4096,
    "length " + fresh.length);
  ok("the previous contents are kept, not dropped",
    fs.existsSync(rotFile + ".1") && fs.statSync(rotFile + ".1").size > 2 * 1024 * 1024,
    "the .1 file is not the old log");

  const smallDir = scratch("logger-small");
  const smallFile = path.join(smallDir, "oh-my-qwen.log");
  fs.writeFileSync(smallFile, "earlier session\n", "utf8");
  runChild(smallDir, [
    "const logger = require(" + JSON.stringify(path.join(ROOT, "src", "logger").split("\\").join("/")) + ");",
    "logger.install();",
    "console.log('appended');"
  ].join("\n"), { tag: "small" });
  const appended = fs.readFileSync(smallFile, "utf8");
  ok("a log under the limit is appended to, not rotated",
    /earlier session/.test(appended) && /appended/.test(appended) && !fs.existsSync(smallFile + ".1"),
    appended.slice(0, 200));

  group("logger: a process that dies");

  // The reason this module exists. The single-file build has no console, so an
  // uncaught error leaves nothing behind unless it is written here - and it has
  // to be written synchronously, because a queued stream write does not survive
  // the process.exit that follows.
  const fatalDir = scratch("logger-fatal");
  const fatalFile = path.join(fatalDir, "oh-my-qwen.log");

  const fatal = runChild(fatalDir, [
    "const logger = require(" + JSON.stringify(path.join(ROOT, "src", "logger").split("\\").join("/")) + ");",
    "logger.install();",
    "console.log('still fine here');",
    "setTimeout(function () { throw new Error('died on purpose'); }, 10);"
  ].join("\n"), { tag: "fatal" });

  ok("an uncaught exception exits non-zero", fatal.code !== 0, "exit " + fatal.code);
  ok("and exits with 1 specifically", fatal.code === 1, "exit " + fatal.code);

  const fatalText = fs.existsSync(fatalFile) ? fs.readFileSync(fatalFile, "utf8") : "";
  ok("the crash reached the log file", /FATAL/.test(fatalText), fatalText.slice(-400));
  ok("with the message", /died on purpose/.test(fatalText), fatalText.slice(-400));
  ok("and the stack", /at /.test(fatalText.split("FATAL")[1] || ""), fatalText.slice(-400));
  ok("the line written before the crash survived too", /still fine here/.test(fatalText),
    fatalText.slice(0, 300));
  // Without this a terminal or the .cmd launcher would show nothing at all,
  // because installing a handler replaces Node's own stack printer.
  ok("the crash is also on stderr for anyone with a console",
    /died on purpose/.test(fatal.err), fatal.err.slice(0, 300));

  group("logger: a rejection is not fatal");

  const rejDir = scratch("logger-reject");
  const rejFile = path.join(rejDir, "oh-my-qwen.log");

  const rejected = runChild(rejDir, [
    "const logger = require(" + JSON.stringify(path.join(ROOT, "src", "logger").split("\\").join("/")) + ");",
    "logger.install();",
    "Promise.reject(new Error('nobody caught me'));",
    "setTimeout(function () { console.log('still running'); process.exit(0); }, 200);"
  ].join("\n"), { tag: "reject" });

  ok("an unhandled rejection does not kill the process", rejected.code === 0,
    "exit " + rejected.code + " " + rejected.err.slice(0, 200));
  const rejText = fs.existsSync(rejFile) ? fs.readFileSync(rejFile, "utf8") : "";
  ok("but it is recorded", /unhandled rejection/.test(rejText) && /nobody caught me/.test(rejText),
    rejText.slice(-300));
  ok("and the process kept going", /still running/.test(rejText), rejText.slice(-300));

  group("logger: install twice");

  const twiceDir = scratch("logger-twice");
  const twiceFile = path.join(twiceDir, "oh-my-qwen.log");
  const twice = runChild(twiceDir, [
    "const logger = require(" + JSON.stringify(path.join(ROOT, "src", "logger").split("\\").join("/")) + ");",
    "const a = logger.install();",
    "const b = logger.install();",
    "console.log('once only');",
    "process.stdout.write('SAME=' + String(a === b) + '\\n');"
  ].join("\n"), { tag: "twice" });

  ok("the second install returns the same path", /SAME=true/.test(twice.out), twice.out.slice(0, 200));
  const twiceText = fs.existsSync(twiceFile) ? fs.readFileSync(twiceFile, "utf8") : "";
  const hits = (twiceText.match(/once only/g) || []).length;
  ok("and does not wrap the console a second time", hits === 1, "the line was logged " + hits + " time(s)");

  rmrf(dir);
  rmrf(rotDir);
  rmrf(smallDir);
  rmrf(fatalDir);
  rmrf(rejDir);
  rmrf(twiceDir);
}

// ---------------------------------------------------------------------------

async function main()
{
  try
  {
    await testAssets();
    testPicker();
    testLogger();
  }
  catch (err)
  {
    process.stdout.write("suite threw: " + (err && err.stack ? err.stack : err) + "\n");
  }

  let lastGroup = "";
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < results.length; i++)
  {
    const r = results[i];
    if (r.group !== lastGroup)
    {
      lastGroup = r.group;
      process.stdout.write("\n" + r.group + "\n");
    }
    if (!r.ok) { failed++; }
    if (r.skipped) { skipped++; }

    const mark = r.skipped ? "skip" : (r.ok ? "ok  " : "FAIL");
    process.stdout.write("  " + mark + " " + r.label +
      (r.skipped ? "  (" + r.skipped + ")" : "") +
      (r.ok ? "" : "\n       " + String(r.detail).split("\n").slice(0, 4).join("\n       ")) + "\n");
  }

  process.stdout.write("\n" + (results.length - failed) + "/" + results.length + " checks passed" +
    (skipped > 0 ? ", " + skipped + " skipped" : "") + "\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (err)
{
  process.stdout.write("native suite crashed: " + (err && err.stack ? err.stack : err) + "\n");
  process.exit(2);
});
