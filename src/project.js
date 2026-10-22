"use strict";

// Project detection for build / run / test.
//
// Without this the model has to rediscover how a project is built on every
// turn, which burns tool rounds and often ends in a wrong command. Here the app
// looks at the workspace once, decides which build system is in play, and hands
// back ready-to-run command lines plus a parser that turns a wall of compiler
// output into the handful of lines that matter.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const toolchain = require("./toolchain");

const IGNORE_DIRS = new Set(
[
  ".git", "node_modules", "build", "out", "bin", "obj", "dist", "target",
  ".vs", ".vscode", "__pycache__", ".venv", "venv", "Binaries", "Intermediate"
]);

function exists(root, rel)
{
  try
  {
    return fs.existsSync(path.join(root, rel));
  }
  catch (err)
  {
    return false;
  }
}

function readJson(root, rel)
{
  try
  {
    return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8").replace(/^\uFEFF/, ""));
  }
  catch (err)
  {
    return null;
  }
}

function shellQuote(value)
{
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

// Shallow scan: enough to spot project markers without walking a whole tree.
function topLevelNames(root)
{
  try
  {
    return fs.readdirSync(root, { withFileTypes: true }).map(function (e)
    {
      return { name: e.name, dir: e.isDirectory(), file: e.isFile() };
    });
  }
  catch (err)
  {
    return [];
  }
}

function findByExt(root, exts, limit, depth)
{
  const found = [];
  const maxDepth = depth === undefined ? 2 : depth;

  function walk(dir, level, prefix)
  {
    if (found.length >= limit || level > maxDepth)
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

    for (let i = 0; i < entries.length && found.length < limit; i++)
    {
      const e = entries[i];
      if (e.isSymbolicLink())
      {
        continue;
      }
      if (e.isDirectory())
      {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith("."))
        {
          continue;
        }
        walk(path.join(dir, e.name), level + 1, prefix + e.name + "/");
      }
      else if (e.isFile() && exts.indexOf(path.extname(e.name).toLowerCase()) >= 0)
      {
        found.push(prefix + e.name);
      }
    }
  }

  walk(root, 0, "");
  return found;
}

function hasCommand(name)
{
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = String(process.env.PATH || "").split(path.delimiter);

  for (let i = 0; i < dirs.length; i++)
  {
    if (!dirs[i])
    {
      continue;
    }
    for (let e = 0; e < exts.length; e++)
    {
      try
      {
        const candidate = path.join(dirs[i], name + exts[e]);
        if (fs.existsSync(candidate))
        {
          if (process.platform !== "win32")
          {
            fs.accessSync(candidate, fs.constants.X_OK);
          }
          return true;
        }
      }
      catch (err)
      {
        // keep looking
      }
    }
  }
  return false;
}

// Whether "python -m pytest" can work at all. Detection runs on every turn and
// after every file change, so the answer is cached for a minute.
const pytestCache = new Map();

function pytestAvailable(py)
{
  const hit = pytestCache.get(py);
  if (hit && Date.now() - hit.at < 60000)
  {
    return hit.ok;
  }

  let ok = false;
  try
  {
    const res = spawnSync(py, ["-c", "import pytest"], { stdio: "ignore", timeout: 10000 });
    ok = res.status === 0;
  }
  catch (err)
  {
    ok = false;
  }
  pytestCache.set(py, { ok: ok, at: Date.now() });
  return ok;
}

// Newest executable produced by a build, so "run" has something to point at.
function findExecutable(root)
{
  const candidates = [];

  function scan(dir, level)
  {
    if (level > 3)
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
      const e = entries[i];
      const full = path.join(dir, e.name);

      if (e.isDirectory())
      {
        // CMakeFiles holds the compiler probes CMake builds while configuring
        // (CMakeDetermineCompilerABI_C.bin is an executable ELF), and one of
        // them could be newer than the program that was actually wanted.
        if (e.name === "node_modules" || e.name === ".git" || e.name === "CMakeFiles" || e.name.startsWith("."))
        {
          continue;
        }
        scan(full, level + 1);
      }
      else if (e.isFile() && !/\.(so(\.\d+)*|o|a)$/i.test(e.name))
      {
        // Shared libraries are ELF files with the execute bit set too.
        try
        {
          const stat = fs.statSync(full);
          let runnable = /\.exe$/i.test(e.name);
          if (process.platform !== "win32" && (stat.mode & 0o111) !== 0)
          {
            const fd = fs.openSync(full, "r");
            const magic = Buffer.alloc(4);
            const read = fs.readSync(fd, magic, 0, magic.length, 0);
            fs.closeSync(fd);
            runnable = read === 4 && magic[0] === 0x7f && magic.toString("ascii", 1, 4) === "ELF";
          }
          if (runnable)
          {
            candidates.push({ rel: path.relative(root, full), mtime: stat.mtimeMs });
          }
        }
        catch (err)
        {
          // skip
        }
      }
    }
  }

  scan(root, 0);
  candidates.sort(function (a, b)
  {
    return b.mtime - a.mtime;
  });

  return candidates.length > 0 ? candidates[0].rel.split(path.sep).join("/") : null;
}

// Reads one registry value without a dependency. Returns "" when anything at
// all goes wrong, which is the common case: no Unreal installed.
function regValue(key, name)
{
  try
  {
    const res = spawnSync("reg", ["query", key, "/v", name], { encoding: "utf8", windowsHide: true, timeout: 8000 });
    if (res.status !== 0 || !res.stdout)
    {
      return "";
    }
    // "    InstalledDirectory    REG_SZ    C:\Program Files\Epic Games\UE_5.4"
    const m = res.stdout.match(new RegExp("\\s" + name + "\\s+REG_\\w+\\s+(.+)"));
    return m ? m[1].trim() : "";
  }
  catch (err)
  {
    return "";
  }
}

// Where the engine for this project lives. Launcher installs are keyed by
// version ("5.4"); source builds are keyed by a GUID under the user hive.
function unrealEngineDir(association)
{
  if (process.platform !== "win32")
  {
    const linuxCandidates = [process.env.UE_ENGINE_DIR, process.env.UNREAL_ENGINE_ROOT, "/opt/UnrealEngine"];
    for (let i = 0; i < linuxCandidates.length; i++)
    {
      const dir = linuxCandidates[i];
      if (dir && fs.existsSync(path.join(dir, "Engine", "Build", "BatchFiles", "Linux", "Build.sh")))
      {
        return path.resolve(dir);
      }
    }
    return "";
  }

  if (!association)
  {
    return "";
  }

  const candidates =
  [
    regValue("HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\" + association, "InstalledDirectory"),
    regValue("HKCU\\Software\\Epic Games\\Unreal Engine\\Builds", association)
  ];

  for (let i = 0; i < candidates.length; i++)
  {
    const dir = candidates[i];
    if (dir && fs.existsSync(path.join(dir, "Engine", "Build", "BatchFiles", "Build.bat")))
    {
      return dir;
    }
  }

  return "";
}

function unrealProject(root, uproject, uplugin)
{
  const marker = uproject || uplugin;
  const projectName = path.basename(marker).replace(/\.(uproject|uplugin)$/i, "");
  const descriptor = readJson(root, marker) || {};
  const association = String(descriptor.EngineAssociation || "").trim();
  const engine = uproject ? unrealEngineDir(association) : "";

  const notes =
  [
    "Unreal builds go through UnrealBuildTool. Never compile individual .cpp files directly and do not " +
      "build the generated IDE project; both bypass UnrealHeaderTool and produce nothing usable.",
    "Binaries, Intermediate, Saved and DerivedDataCache are generated. Never edit them and never treat " +
      "what is in them as source.",
    "Editing a UCLASS, USTRUCT, UPROPERTY or UFUNCTION declaration means the generated.h is stale until " +
      "the next build regenerates it, so a header change alone will not compile."
  ];

  if (association)
  {
    notes.push("EngineAssociation in " + marker + " is \"" + association + "\".");
  }

  const tasks =
  {
    build: { command: null, needsMsvc: false },
    test: { command: null, needsMsvc: false },
    run: { command: null, needsMsvc: false }
  };

  if (engine)
  {
    const abs = path.join(path.resolve(root), marker);
    if (process.platform === "win32")
    {
      const batch = path.join(engine, "Engine", "Build", "BatchFiles", "Build.bat");
      tasks.build =
      {
        command: "cmd /c '\"" + batch + "\" " + projectName + "Editor Win64 Development -Project=\"" + abs +
          "\" -WaitMutex -FromMsBuild'",
        needsMsvc: false
      };
      tasks.run =
      {
        command: "& \"" + path.join(engine, "Engine", "Binaries", "Win64", "UnrealEditor.exe") + "\" \"" + abs + "\"",
        needsMsvc: false
      };
    }
    else
    {
      const buildScript = path.join(engine, "Engine", "Build", "BatchFiles", "Linux", "Build.sh");
      const editor = path.join(engine, "Engine", "Binaries", "Linux", "UnrealEditor");
      tasks.build =
      {
        command: "bash " + shellQuote(buildScript) + " " + shellQuote(projectName + "Editor") +
          " Linux Development " + shellQuote("-Project=" + abs) + " -WaitMutex",
        needsMsvc: false
      };
      tasks.run = fs.existsSync(editor)
        ? { command: shellQuote(editor) + " " + shellQuote(abs), needsMsvc: false }
        : { command: null, needsMsvc: false };
    }
    notes.push("Engine found at " + engine + ".");
  }
  else if (uproject)
  {
    notes.push("The engine for this project could not be located. Set UE_ENGINE_DIR or UNREAL_ENGINE_ROOT " +
      "to the Unreal Engine root, or build from the editor instead of guessing a path.");
  }
  else
  {
    notes.push("This is a plugin on its own (" + marker + "), with no .uproject to build it from. " +
      "It is compiled by whichever project hosts it.");
  }

  return {
    kind: "unreal",
    label: "Unreal Engine (" + marker + ")",
    marker: marker,
    tasks: tasks,
    notes: notes
  };
}

function cmakeGenerator()
{
  if (hasCommand("ninja"))
  {
    return { arg: " -G Ninja -DCMAKE_BUILD_TYPE=Debug", name: "Ninja" };
  }
  return { arg: " -DCMAKE_BUILD_TYPE=Debug", name: "Unix Makefiles" };
}

// Returns a description of how to build / run / test this workspace.
function detect(root)
{
  if (!root)
  {
    return null;
  }

  const names = topLevelNames(root);
  const nameSet = new Set(names.map(function (n)
  {
    return n.name.toLowerCase();
  }));

  const slns = names.filter(function (n)
  {
    return n.file && /\.sln$/i.test(n.name);
  }).map(function (n)
  {
    return n.name;
  });

  const vcxprojs = findByExt(root, [".vcxproj"], 3, 2);
  const csprojs = findByExt(root, [".csproj", ".fsproj"], 3, 2);

  // --- Unreal Engine ----------------------------------------------------
  // Checked first: a .uproject is the most specific marker there is, and an
  // Unreal tree also carries a generated .sln plus hundreds of .cpp files. Let
  // either of those win and the model is told to run msbuild or cl over engine
  // sources, which cannot work and wastes the whole turn finding that out.
  const uproject = names.filter(function (n)
  {
    return n.file && /\.uproject$/i.test(n.name);
  }).map(function (n)
  {
    return n.name;
  })[0];

  const uplugin = names.filter(function (n)
  {
    return n.file && /\.uplugin$/i.test(n.name);
  }).map(function (n)
  {
    return n.name;
  })[0];

  if (uproject || uplugin)
  {
    return unrealProject(root, uproject, uplugin);
  }

  // --- CMake ------------------------------------------------------------
  if (nameSet.has("cmakelists.txt"))
  {
    const gen = cmakeGenerator();
    return {
      kind: "cmake",
      label: "CMake (" + gen.name + ")",
      marker: "CMakeLists.txt",
      tasks:
      {
        configure: { command: "cmake -S . -B build" + gen.arg, needsMsvc: false },
        build: { command: "cmake --build build", needsMsvc: false, requires: "configure" },
        test: { command: "ctest --test-dir build --output-on-failure --timeout 120", needsMsvc: false },
        run: { command: null, needsMsvc: false }
      },
      notes: ["Run configure once (or after CMakeLists.txt changes), then build."]
    };
  }

  // --- MSBuild ----------------------------------------------------------
  if (process.platform === "win32" && (slns.length > 0 || vcxprojs.length > 0))
  {
    const target = slns.length > 0 ? slns[0] : vcxprojs[0];
    return {
      kind: "msbuild",
      label: "MSBuild (" + target + ")",
      marker: target,
      tasks:
      {
        build: { command: 'msbuild "' + target + '" /nologo /m /p:Configuration=Debug /p:Platform=x64', needsMsvc: true },
        test: { command: 'vstest.console.exe /Platform:x64 "' + target + '"', needsMsvc: true },
        run: { command: null, needsMsvc: false }
      },
      notes: ["msbuild only exists inside the MSVC developer environment, which the app loads for you."]
    };
  }

  // --- .NET -------------------------------------------------------------
  if (csprojs.length > 0)
  {
    return {
      kind: "dotnet",
      label: ".NET (" + csprojs[0] + ")",
      marker: csprojs[0],
      tasks:
      {
        build: { command: "dotnet build", needsMsvc: false },
        test: { command: "dotnet test", needsMsvc: false },
        run: { command: "dotnet run", needsMsvc: false }
      },
      notes: []
    };
  }

  // --- Rust -------------------------------------------------------------
  if (nameSet.has("cargo.toml"))
  {
    return {
      kind: "cargo",
      label: "Cargo",
      marker: "Cargo.toml",
      tasks:
      {
        build: { command: "cargo build", needsMsvc: false },
        test: { command: "cargo test", needsMsvc: false },
        run: { command: "cargo run", needsMsvc: false }
      },
      notes: []
    };
  }

  // --- Go ---------------------------------------------------------------
  if (nameSet.has("go.mod") || nameSet.has("go.work"))
  {
    let moduleName = "";
    try
    {
      const text = fs.readFileSync(path.join(root, "go.mod"), "utf8");
      const m = text.match(/^\s*module\s+(\S+)/m);
      moduleName = m ? m[1] : "";
    }
    catch (err)
    {
      moduleName = "";
    }

    const hasMain = findByExt(root, [".go"], 40, 2).some(function (f)
    {
      try
      {
        return /^\s*package\s+main\b/m.test(fs.readFileSync(path.join(root, f), "utf8"));
      }
      catch (err)
      {
        return false;
      }
    });

    return {
      kind: "go",
      label: "Go" + (moduleName ? " (" + moduleName + ")" : ""),
      marker: nameSet.has("go.mod") ? "go.mod" : "go.work",
      tasks:
      {
        build: { command: "go build ./...", needsMsvc: false },
        // -count=1 defeats the result cache, which otherwise replays a stale
        // pass after the source was already fixed.
        test: { command: "go test ./... -count=1", needsMsvc: false },
        run: { command: hasMain ? "go run ." : null, needsMsvc: false }
      },
      notes: ["go vet ./... catches a class of mistakes the compiler allows."]
    };
  }

  // --- Node -------------------------------------------------------------
  if (nameSet.has("package.json"))
  {
    const pkg = readJson(root, "package.json") || {};
    const scripts = pkg.scripts || {};
    // findByExt matches path.extname, which is ".js" for "a.test.js", so the
    // test-file shape has to be checked on the names it returns.
    const hasNodeTests = findByExt(root, [".js", ".mjs", ".cjs"], 200, 2).some(function (f)
    {
      return /\.test\.[cm]?js$|(^|\/)tests?\//i.test(f);
    });

    return {
      kind: "node",
      label: "Node.js" + (pkg.name ? " (" + pkg.name + ")" : ""),
      marker: "package.json",
      tasks:
      {
        build: { command: scripts.build ? "npm run build" : null, needsMsvc: false },
        test: { command: scripts.test ? "npm test" : (hasNodeTests ? "node --test" : null), needsMsvc: false },
        run: { command: scripts.start ? "npm start" : ("node " + shellQuote(pkg.main || "index.js")), needsMsvc: false }
      },
      notes: scripts.build ? [] : ["package.json has no build script; there may be nothing to compile."]
    };
  }

  // --- Python -----------------------------------------------------------
  // Split into two passes. A declared Python project wins immediately, but a
  // couple of loose .py helpers must not outrank a Makefile or a build script
  // in a C++ repository, so that case is decided at the bottom instead.
  const pyFiles = findByExt(root, [".py"], 40, 2);
  const pyDeclared = nameSet.has("pyproject.toml") || nameSet.has("requirements.txt") ||
    nameSet.has("setup.py") || nameSet.has("setup.cfg") || nameSet.has("pipfile") ||
    nameSet.has("poetry.lock") || nameSet.has("environment.yml");

  // Ubuntu ships python3 and no "python" unless python-is-python3 is
  // installed, so a hard-coded "python" failed every run and test with 127.
  const py = hasCommand("python3") || !hasCommand("python") ? "python3" : "python";

  function pythonProject()
  {
    const testish = pyFiles.filter(function (f)
    {
      return /(^|\/)test_|_test\.py$|(^|\/)tests?\//i.test(f);
    });
    const entry = ["main.py", "app.py", "run.py", "__main__.py"].filter(function (f)
    {
      return exists(root, f);
    })[0] || (pyFiles.length === 1 ? pyFiles[0] : null);

    return {
      kind: "python",
      label: "Python" + (nameSet.has("pyproject.toml") ? " (pyproject.toml)" : ""),
      marker: nameSet.has("pyproject.toml") ? "pyproject.toml" : (pyFiles[0] || "requirements.txt"),
      tasks:
      {
        build: { command: null, needsMsvc: false },
        test: { command: testish.length > 0 ? py + " -m pytest -q" : null, needsMsvc: false },
        run: { command: entry ? py + " " + shellQuote(entry) : null, needsMsvc: false }
      },
      notes: testish.length > 0
        ? (pytestAvailable(py)
          ? ["If a test needs a plugin that is missing, say so instead of installing packages."]
          : ["pytest is NOT installed for " + py + ", so test_project will fail with \"No module named pytest\". " +
            "Do not try pip, ensurepip or apt: Ubuntu blocks installing into the system Python and the user did not ask " +
            "for it. Run unittest-style tests with " + py + " -m unittest discover, call plain test_* functions from a " +
            "short " + py + " script, and tell the user pytest is missing."])
        : ["No test files were found (test_*.py or tests/)."]
    };
  }

  if (pyDeclared)
  {
    return pythonProject();
  }

  // --- Make / build scripts --------------------------------------------
  if (nameSet.has("makefile") || nameSet.has("gnumakefile"))
  {
    const tool = hasCommand("make") ? "make" : null;
    return {
      kind: "make",
      label: (tool || "Make") + " (Makefile)",
      marker: "Makefile",
      tasks:
      {
        build: { command: tool, needsMsvc: false },
        test: { command: tool ? tool + " test" : null, needsMsvc: false },
        run: { command: null, needsMsvc: false }
      },
      notes: tool ? [] : ["GNU make was not found. Install build-essential before building this project."]
    };
  }

  const scriptName = ["build.sh", "configure", "autogen.sh"].filter(function (f)
  {
    return exists(root, f);
  })[0];

  if (scriptName)
  {
    const invoke = "bash " + shellQuote("./" + scriptName);
    return {
      kind: "script",
      label: "build script (" + scriptName + ")",
      marker: scriptName,
      tasks:
      {
        build: { command: invoke, needsMsvc: false },
        test: { command: null, needsMsvc: false },
        run: { command: null, needsMsvc: false }
      },
      notes: ["The script is invoked with Bash from the workspace root."]
    };
  }

  // --- Bare C/C++ sources ----------------------------------------------
  const sources = findByExt(root, [".cpp", ".cc", ".cxx", ".c"], 40, 2);
  if (sources.length > 0)
  {
    const name = path.basename(path.resolve(root)).replace(/[^A-Za-z0-9_.-]/g, "_") || "app";
    const native = toolchain.detect();
    const hasCpp = sources.some(function (f) { return /\.(cpp|cc|cxx)$/i.test(f); });
    const compiler = hasCpp ? native.cxx : native.cc;
    const list = sources.map(function (f)
    {
      return shellQuote(f);
    }).join(" ");

    return {
      kind: "native-direct",
      label: "Native compiler (" + sources.length + " source file(s))",
      marker: sources[0],
      tasks:
      {
        build: { command: compiler ? (shellQuote(compiler) + " -Wall -Wextra -g -o " + shellQuote(name) + " " + list) : null, needsMsvc: false },
        test: { command: null, needsMsvc: false },
        run: { command: null, needsMsvc: false }
      },
      notes: compiler
        ? ["No build system was found, so the sources are compiled directly with " + compiler + "."]
        : ["No C/C++ compiler was found. Install build-essential or clang before building."]
    };
  }

  // Loose .py files with no project file and no build system: now it really is
  // a Python project.
  if (pyFiles.length > 0)
  {
    return pythonProject();
  }

  return null;
}

// Fills in a run command from whatever executable is actually on disk.
function resolveRun(root, info)
{
  if (!info)
  {
    return null;
  }
  if (info.tasks.run && info.tasks.run.command)
  {
    return info.tasks.run;
  }

  const exe = findExecutable(root);
  if (!exe)
  {
    return null;
  }
  return { command: shellQuote("./" + exe), needsMsvc: false, resolvedExe: exe };
}

// ---------------------------------------------------------------------------
// build output summarisation
// ---------------------------------------------------------------------------

const DIAG_PATTERNS =
[
  // MSVC / tsc: file(line[,col]): error C2065: text
  { re: /^\s*(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(fatal error|error|warning)\s+([A-Za-z]+[\d]+)\s*:\s*(.*)$/, file: 1, line: 2, sev: 4, code: 5, msg: 6 },
  // gcc / clang: file:line:col: error: text
  { re: /^\s*(.+?):(\d+):(\d+):\s*(fatal error|error|warning):\s*(.*)$/, file: 1, line: 2, sev: 4, msg: 5 },
  // go build / go vet / go test detail: file.go:line[:col]: text, no severity word
  { re: /^\s*(\S*\.go):(\d+)(?::(\d+))?:\s*(.+)$/, file: 1, line: 2, sev: null, msg: 4 },
  // rustc: error[E0308]: text
  { re: /^\s*(error)(\[[A-Z]\d+\])?:\s*(.*)$/, sev: 1, code: 2, msg: 3 },
  // MSVC linker and driver diagnostics, which carry no line number:
  //   test.obj : error LNK2019: unresolved external symbol ...
  //   LINK : fatal error LNK1104: cannot open file ...
  //   cl : Command line warning D9002 : ignoring unknown option ...
  // The trailing code is what keeps this from matching ordinary prose that
  // happens to contain a colon and the word error.
  { re: /^\s*(?:\d+>)?((?:[A-Za-z]:)?[^:]*?)\s*:\s*(?:command line\s+)?(fatal error|error|warning)\s+([A-Za-z]+\d+)\s*:?\s*(.*)$/i,
    file: 1, sev: 2, code: 3, msg: 4 },
  // GNU ld and the driver around it. These carry no "error:" of the gcc shape:
  //   main.c:(.text+0x9): undefined reference to `add'
  //   /usr/bin/ld: cannot find -lfoo: No such file or directory
  //   collect2: error: ld returned 1 exit status
  { re: /^\s*(?:\/\S*\/)?ld(?:\.\w+)?:\s*(?:(\S+?):\s*)?((?:.*?)(?:undefined reference to|cannot find|multiple definition of).*)$/, file: 1, sev: null, msg: 2 },
  { re: /^\s*(\S+?):\(\.\w+[^)]*\):\s*(undefined reference to.*|multiple definition of.*)$/, file: 1, sev: null, msg: 2 },
  { re: /^\s*(?:collect2|clang(?:\+\+)?):\s*(error):\s*(.*)$/, sev: 1, msg: 2 },
  // CMake Error at CMakeLists.txt:12 (add_executable):
  { re: /^\s*CMake (Error|Warning)(?: \(dev\))? at (.+?):(\d+)/, file: 2, line: 3, sev: 1, msg: null },
  // MSBuild summary lines already covered above; python tracebacks:
  { re: /^\s*File "(.+?)", line (\d+)/, file: 1, line: 2, sev: null, msg: null }
];

// Unresolved externals are the one build failure this model consistently reads
// as an environment problem. It is almost never one: the declaration was seen
// and the definition was not handed to the linker.
const LINK_HINT_RE = /\bLNK(2001|2019|1120)\b|undefined reference to|ld returned 1 exit status|Undefined symbols for architecture/;

// Extracts compiler/test diagnostics so a huge log becomes a short verdict.
function summarizeOutput(text)
{
  const lines = String(text || "").split(/\r?\n/);
  const errors = [];
  const warnings = [];
  const testFails = [];

  for (let i = 0; i < lines.length; i++)
  {
    const line = lines[i];

    // test framework failures. A bare "FAIL" or "PASS" line (go test prints one
    // per package plus a final one) carries no information, so it is dropped.
    if (/^\s*(not ok|FAILED|FAIL)\b/i.test(line) || /^\s*\d+\)\s+.*(failed|error)/i.test(line))
    {
      const trimmed = line.trim();
      if (!/^(FAIL|PASS|ok)$/i.test(trimmed))
      {
        testFails.push(trimmed.slice(0, 200));
      }
      continue;
    }

    // ctest per-test verdicts and CRT assertions carry the detail that says
    // which test broke and why.
    if (/\*\*\*(Failed|Timeout|Exception|Not Run)/i.test(line) || /^\s*Assertion failed:/i.test(line))
    {
      testFails.push(line.trim().replace(/\s{2,}/g, " ").slice(0, 220));
      continue;
    }
    if (/^\s*\d+\s+-\s+.*\((Failed|Timeout|SEGFAULT|Exception)\)/i.test(line))
    {
      testFails.push(line.trim().replace(/\s{2,}/g, " ").slice(0, 220));
      continue;
    }
    if (/^\s*Failed\s+\d+\s*-\s*/.test(line) || /Tests failed:/i.test(line))
    {
      testFails.push(line.trim().slice(0, 200));
      continue;
    }

    for (let p = 0; p < DIAG_PATTERNS.length; p++)
    {
      const spec = DIAG_PATTERNS[p];
      const m = line.match(spec.re);
      if (!m)
      {
        continue;
      }

      const sev = spec.sev ? String(m[spec.sev] || "").toLowerCase() : "error";
      const where = spec.file && m[spec.file]
        ? (String(m[spec.file]).split("\\").join("/").split("/").slice(-2).join("/") +
          (spec.line && m[spec.line] ? ":" + m[spec.line] : ""))
        : "";
      const code = spec.code && m[spec.code] ? " " + m[spec.code] : "";
      // MSBuild appends " [C:\path\project.vcxproj]" to every diagnostic, which
      // crowds out the message itself.
      let msg = spec.msg && m[spec.msg] ? String(m[spec.msg]).trim() : line.trim();
      msg = msg.replace(/\s*\[[^\]]*\.(?:vcxproj|csproj|sln|proj)\]\s*$/i, "");
      const entry = (where ? where + ": " : "") + sev + code + ": " + msg;

      if (sev.indexOf("error") >= 0)
      {
        errors.push(entry.slice(0, 240));
      }
      else if (sev === "warning")
      {
        warnings.push(entry.slice(0, 240));
      }
      break;
    }
  }

  const dedupe = function (arr)
  {
    const seen = new Set();
    const out = [];
    for (let i = 0; i < arr.length; i++)
    {
      if (!seen.has(arr[i]))
      {
        seen.add(arr[i]);
        out.push(arr[i]);
      }
    }
    return out;
  };

  return {
    linkError: LINK_HINT_RE.test(String(text || "")),
    errors: dedupe(errors),
    warnings: dedupe(warnings),
    testFails: dedupe(testFails),
    ranNoTests: looksLikeNoTests(text) || !looksLikeTestsRan(text)
  };
}

// Positive evidence that a runner actually executed tests. dotnet test on a
// project with no tests prints nothing at all and exits 0, so the absence of
// any result line is the only signal available.
function looksLikeTestsRan(text)
{
  const s = String(text || "");
  const patterns =
  [
    /\btests? passed\b/i,
    /\bpassed!?\b.*\bfailed\b/i,
    /Test Run (Successful|Failed)/i,
    /통과!?.*실패/,
    /테스트 요약/,
    /^\s*#\s*pass\s+\d+/im,
    /^\s*#\s*tests\s+[1-9]/im,
    /\d+\s+passing\b/i,
    /\d+\s+passed\b/i,
    /\d+\s+failed\b/i,
    /Test\s+#\d+/i,
    /\bok\s+\d+\s/im,
    /=+\s*\d+\s+(passed|failed)/i,
    /running \d+ tests?/i,
    /test result:/i,
    // go test: "ok  \tmodule/pkg\t0.009s" or "--- FAIL: TestX"
    /^ok\s+\S+\s+(\(cached\)|[\d.]+m?s)/im,
    /^---\s+(FAIL|PASS|SKIP):/im,
    /^(FAIL|PASS)\s*$/im
  ];

  for (let i = 0; i < patterns.length; i++)
  {
    if (patterns[i].test(s))
    {
      return true;
    }
  }
  return false;
}

// "exit 0" from a test runner that found nothing is not a passing test suite.
// dotnet test, ctest, npm test and pytest all report success in that case.
function looksLikeNoTests(text)
{
  const s = String(text || "");
  const patterns =
  [
    /no test is available/i,
    /테스트를 검색할 수 없습니다/,
    /no tests were found/i,
    /no tests ran/i,
    /no tests found/i,
    /Total tests:\s*0\b/i,
    /\b0 tests? (?:ran|passed|found|executed)/i,
    /^#\s*tests\s+0\s*$/im,
    /Error: no test specified/i,
    /No test files found/i,
    /collected 0 items/i
  ];

  for (let i = 0; i < patterns.length; i++)
  {
    if (patterns[i].test(s))
    {
      return true;
    }
  }

  // "[no test files]" is per package: go test ./... prints it for every package
  // without a _test.go while other packages really did run. It only means
  // nothing ran when no package reported a result of its own.
  if (/\[no test files\]/i.test(s) && !/^ok\s+\S+/im.test(s) && !/^---\s+(FAIL|PASS):/im.test(s))
  {
    return true;
  }

  return false;
}

// Lines appended to the system prompt so the model knows what it can run.
function promptLines(root)
{
  const info = detect(root);
  if (!info)
  {
    return ["No build system was detected in the working folder. Ask the user how the project is built before guessing."];
  }

  const lines = [];
  lines.push("Detected project: " + info.label + " (found " + info.marker + ").");
  lines.push("Use the build_project / run_project / test_project tools instead of assembling build commands yourself.");

  const t = info.tasks;
  if (t.configure && t.configure.command)
  {
    lines.push("  configure: " + t.configure.command);
  }
  if (t.build && t.build.command)
  {
    lines.push("  build: " + t.build.command);
  }
  if (t.test && t.test.command)
  {
    lines.push("  test: " + t.test.command);
  }
  if (t.run && t.run.command)
  {
    lines.push("  run: " + t.run.command);
  }

  for (let i = 0; i < info.notes.length; i++)
  {
    lines.push("  note: " + info.notes[i]);
  }

  return lines;
}

module.exports =
{
  detect: detect,
  resolveRun: resolveRun,
  summarizeOutput: summarizeOutput,
  promptLines: promptLines,
  findExecutable: findExecutable
};
