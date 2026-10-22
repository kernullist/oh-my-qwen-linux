"use strict";

// A .NET project, a project grown over several turns, and a regex rename with
// back references.

const crypto = require("crypto");
const { check, needs, saidAny, countTool, toolSaid, pythonCommand } = require("../lib/check");

function hash(text)
{
  return crypto.createHash("sha1").update(String(text).replace(/\r\n/g, "\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// .NET console project
// ---------------------------------------------------------------------------

const CSPROJ = [
  "<Project Sdk=\"Microsoft.NET.Sdk\">",
  "  <PropertyGroup>",
  "    <OutputType>Exe</OutputType>",
  "    <TargetFramework>net9.0</TargetFramework>",
  "    <Nullable>disable</Nullable>",
  "    <ImplicitUsings>disable</ImplicitUsings>",
  "    <AssemblyName>ledger</AssemblyName>",
  "    <RootNamespace>Ledger</RootNamespace>",
  "  </PropertyGroup>",
  "</Project>",
  ""
].join("\n");

// Uses Enumerable.Sum and List<T> without the using directives that supply
// them, which is the first thing that breaks in a hand-written csproj.
const PROGRAM_CS = [
  "using System;",
  "",
  "namespace Ledger",
  "{",
  "  public static class Program",
  "  {",
  "    public static int Main(string[] args)",
  "    {",
  "      List<int> amounts = new List<int> { 120, 240, 65, 15 };",
  "      Console.WriteLine(\"total={0}\", amounts.Sum());",
  "      Console.WriteLine(\"largest={0}\", amounts.Max());",
  "      return 0;",
  "    }",
  "  }",
  "}",
  ""
].join("\n");

const dotnetConsole =
{
  name: "dotnet-console-build",
  title: ".NET console project missing its using directives",
  tags: ["dotnet", "build"],
  requires: function ()
  {
    return needs(["dotnet"]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "ledger.csproj", CSPROJ, { eol: "crlf" });
    fx.write(dir, "Program.cs", PROGRAM_CS, { eol: "crlf" });
    fx.write(dir, "README.md", "# ledger\n\nPrints the total and largest amount.\n", { eol: "lf" });
  },
  prompts:
  [
    "이 프로젝트를 빌드해줘. 컴파일 에러가 나면 고치고, 빌드가 되면 실행해서 total 과 largest 값이 " +
      "제대로 나오는지 확인해줘."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("project detected as dotnet",
      ctx.detected && ctx.detected.kind === "dotnet",
      ctx.detected ? ctx.detected.kind : "nothing detected"));

    out.push(check("used build_project",
      countTool(ctx.tools, "build_project") > 0,
      "build_project x" + countTool(ctx.tools, "build_project") +
        ", run_command x" + countTool(ctx.tools, "run_command")));

    out.push(check("the C# diagnostic reached the model",
      toolSaid(ctx.tools, ["CS0246", "CS1061", "List<int>", "Sum"]),
      "no compiler diagnostic in any tool result"));

    const build = ctx.sh("dotnet build --nologo -v q 2>&1", { timeoutMs: 420000 });
    out.push(check("independent dotnet build succeeds", build.code === 0,
      build.code === 0 ? "" : ("exit " + build.code + "\n" + build.out.split("\n").slice(-12).join("\n"))));

    if (build.code === 0)
    {
      const run = ctx.sh("dotnet run --no-build 2>&1", { timeoutMs: 180000 });
      out.push(check("program prints total=440 and largest=240",
        /total=440/.test(run.out) && /largest=240/.test(run.out),
        "exit " + run.code + " out=" + JSON.stringify(run.out.slice(0, 200))));
    }
    else
    {
      out.push(check("program prints total=440 and largest=240", false, "skipped, build failed"));
    }

    return out;
  }
};

// ---------------------------------------------------------------------------
// The same project across three turns
// ---------------------------------------------------------------------------

const TALLY_PY = [
  "\"\"\"Counts words in a text file.\"\"\"",
  "",
  "import sys",
  "from collections import Counter",
  "",
  "",
  "def tally(text):",
  "    return Counter(text.split())",
  "",
  "",
  "def format_plain(counts):",
  "    lines = []",
  "    for word, n in counts.most_common():",
  "        lines.append(\"%s %d\" % (word, n))",
  "    return \"\\n\".join(lines)",
  "",
  "",
  "def main(argv):",
  "    if len(argv) < 2:",
  "        print(\"usage: tally.py <file>\")",
  "        return 2",
  "    with open(argv[1], \"r\", encoding=\"utf-8\") as handle:",
  "        text = handle.read()",
  "    print(format_plain(tally(text)))",
  "    return 0",
  "",
  "",
  "if __name__ == \"__main__\":",
  "    sys.exit(main(sys.argv))",
  ""
].join("\n");

const TALLY_TEST_PY = [
  "import os",
  "import sys",
  "",
  "sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))",
  "",
  "from tally.counter import tally, format_plain",
  "",
  "",
  "def test_tally_counts_words():",
  "    counts = tally(\"a b a\")",
  "    assert counts[\"a\"] == 2",
  "    assert counts[\"b\"] == 1",
  "",
  "",
  "def test_format_plain_is_sorted_by_count():",
  "    text = format_plain(tally(\"a b a\"))",
  "    assert text.splitlines()[0] == \"a 2\"",
  ""
].join("\n");

const multiTurn =
{
  name: "multi-turn-grow",
  title: "One Python project grown and fixed over three turns",
  tags: ["python", "multiturn"],
  requires: function ()
  {
    const miss = needs(["python"]);
    if (miss)
    {
      return miss;
    }
    const { spawnSync } = require("child_process");
    return spawnSync(pythonCommand(), ["-c", "import pytest"], { windowsHide: true }).status === 0
      ? ""
      : "pytest not installed";
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "tally/__init__.py", "", { eol: "lf" });
    fx.write(dir, "tally/counter.py", TALLY_PY, { eol: "lf" });
    fx.write(dir, "tests/test_counter.py", TALLY_TEST_PY, { eol: "lf" });
    fx.write(dir, "requirements.txt", "pytest\n", { eol: "lf" });
    fx.write(dir, "README.md", "# tally\n\n단어 빈도를 세는 작은 CLI.\n\n## 사용\n\n    python -m tally.counter <file>\n",
      { eol: "lf" });
  },
  prompts:
  [
    "tally/counter.py 에 format_json(counts) 함수를 추가해줘. 표준 json 모듈로 {\"word\": count} 형태의 " +
      "문자열을 반환하면 된다. tests/ 에 그 함수 테스트도 추가하고, test_project 로 전부 통과하는지 확인해줘.",
    "빈 파일을 넣으면 어떻게 되는지 확인하고, 빈 입력에서도 죽지 않게 고쳐줘. 그 경우를 검증하는 테스트도 추가하고 " +
      "test_project 로 확인해줘.",
    "마지막으로 README.md 에 format_json 사용법과 빈 입력 처리 동작을 추가해줘. 그리고 테스트를 한 번 더 돌려서 " +
      "전부 통과하는지 알려줘."
  ],
  check: async function (ctx)
  {
    const out = [];

    const source = ctx.exists("tally/counter.py") ? ctx.read("tally/counter.py") : "";
    out.push(check("format_json was added", /def\s+format_json/.test(source), source.slice(0, 200)));

    const testFiles = ctx.files().filter(function (f)
    {
      return /^tests\//.test(f) && /\.py$/.test(f);
    });
    const testText = testFiles.map(function (f)
    {
      return ctx.read(f);
    }).join("\n");

    out.push(check("a test for format_json exists", /format_json/.test(testText),
      testFiles.join(", ")));

    out.push(check("a test for the empty input case exists",
      /empty|빈|""\)|''\)/.test(testText), testFiles.join(", ")));

    const readme = ctx.exists("README.md") ? ctx.read("README.md") : "";
    out.push(check("README documents format_json", /format_json/.test(readme), readme.slice(0, 200)));

    out.push(check("all three turns ran tools",
      ctx.turns.length === 3 && ctx.turns.every(function (t) { return t.tools.length > 0; }),
      ctx.turns.map(function (t) { return t.tools.length; }).join(", ")));

    const run = ctx.sh(pythonCommand() + " -m pytest -q 2>&1", { timeoutMs: 240000 });
    out.push(check("independent pytest run passes", run.code === 0,
      run.code === 0 ? "" : ("exit " + run.code + "\n" + run.out.split("\n").slice(-14).join("\n"))));

    const empty = ctx.sh(": > empty.txt; " + pythonCommand() + " -m tally.counter empty.txt 2>&1; echo \"exit=$?\"",
      { timeoutMs: 120000 });
    out.push(check("running it on an empty file does not crash",
      !/Traceback/.test(empty.out), empty.out.slice(-300)));

    return out;
  }
};

// ---------------------------------------------------------------------------
// Regex replace with a back reference
// ---------------------------------------------------------------------------

const LOG_FILES =
[
  {
    rel: "src/net/session.cpp",
    eol: "crlf",
    text: [
      "#include \"log.h\"",
      "",
      "void OnConnect(int id)",
      "{",
      "  LOG(\"session %d connected\", id);",
      "  LOG(\"handshake pending\");",
      "}",
      ""
    ].join("\n")
  },
  {
    rel: "src/net/packet.cpp",
    eol: "lf",
    text: [
      "#include \"log.h\"",
      "",
      "void OnPacket(int size)",
      "{",
      "  LOG(\"packet size=%d\", size);",
      "}",
      ""
    ].join("\n")
  },
  {
    rel: "src/core/boot.cpp",
    eol: "crlf",
    text: [
      "#include \"log.h\"",
      "",
      "void Boot(void)",
      "{",
      "  LOG(\"boot start\");",
      "  LOGF(LogCat::Core, \"already migrated\");",
      "}",
      ""
    ].join("\n")
  }
];

const regexRename =
{
  name: "regex-log-migration",
  title: "Regex replace with a back reference, without double converting",
  tags: ["edit", "search"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    for (let i = 0; i < LOG_FILES.length; i++)
    {
      fx.write(dir, LOG_FILES[i].rel, LOG_FILES[i].text, { eol: LOG_FILES[i].eol });
    }
    fx.write(dir, "src/log.h", [
      "#pragma once",
      "",
      "enum class LogCat { Core, Net };",
      "",
      "#define LOG(...)  LogLegacy(__VA_ARGS__)",
      "#define LOGF(cat, ...)  LogTagged(cat, __VA_ARGS__)",
      ""
    ].join("\n"), { eol: "crlf" });
  },
  prompts:
  [
    "src 아래 .cpp 파일에서 구식 LOG(\"...\") 호출을 LOGF(LogCat::Net, \"...\") 으로 바꿔줘. " +
      "단 src/core 아래는 LogCat::Core 를 써야 하고, 이미 LOGF 로 바뀐 줄은 건드리면 안 된다. " +
      "정규식 치환을 쓰고, 먼저 dry_run 으로 범위를 확인해줘."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("a dry run was done first",
      ctx.tools.some(function (t)
      {
        return t.name === "replace_in_files" && t.args.dry_run === true;
      }),
      "no dry_run call"));

    let allConverted = true;
    let noDouble = true;
    let eolKept = true;
    const details = [];

    for (let i = 0; i < LOG_FILES.length; i++)
    {
      const f = LOG_FILES[i];
      const info = ctx.readInfo(f.rel);

      if (/(^|[^F])\bLOG\(/.test(info.text))
      {
        allConverted = false;
        details.push(f.rel + ": still has LOG(");
      }
      if (/LOGF\(LogCat::\w+,\s*LOGF\(/.test(info.text) || /LogCat::\w+,\s*LogCat::/.test(info.text))
      {
        noDouble = false;
        details.push(f.rel + ": converted twice");
      }
      if (info.eol !== f.eol)
      {
        eolKept = false;
        details.push(f.rel + ": eol " + f.eol + " -> " + info.eol);
      }
    }

    out.push(check("every legacy LOG call was converted", allConverted,
      details.filter(function (d) { return d.indexOf("still has") >= 0; }).join("; ")));
    out.push(check("nothing was converted twice", noDouble,
      details.filter(function (d) { return d.indexOf("twice") >= 0; }).join("; ")));
    out.push(check("line endings preserved per file", eolKept,
      details.filter(function (d) { return d.indexOf("eol") >= 0; }).join("; ")));

    const netText = ctx.read("src/net/session.cpp");
    out.push(check("net files use LogCat::Net", /LOGF\(LogCat::Net,/.test(netText), netText.slice(0, 200)));

    const coreText = ctx.read("src/core/boot.cpp");
    out.push(check("core files use LogCat::Core", /LOGF\(LogCat::Core, "boot start"\)/.test(coreText),
      coreText.slice(0, 240)));

    out.push(check("the log header itself was left alone",
      /#define LOG\(\.\.\.\)/.test(ctx.read("src/log.h")),
      ctx.read("src/log.h").slice(0, 200)));

    return out;
  }
};

module.exports = [dotnetConsole, multiTurn, regexRename];
