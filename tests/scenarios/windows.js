"use strict";

// Windows-specific tool surface: a test that hangs, a UTF-16LE PowerShell
// script, a binary that has to be read as hex, and a log too big to read whole.

const fs = require("fs");
const path = require("path");
const { check, needs, saidAny, toolSaid, countTool, powershellCommand } = require("../lib/check");

// ---------------------------------------------------------------------------
// A test that never returns
// ---------------------------------------------------------------------------

const HANG_TEST = [
  "\"use strict\";",
  "",
  "// Waits forever on purpose: this is the shape of a test that pops a modal",
  "// dialog or blocks on stdin, which is how a Windows test run hangs.",
  "console.log(\"probe: starting long check\");",
  "setInterval(function ()",
  "{",
  "  // keep the event loop alive",
  "}, 3600000);",
  ""
].join("\n");

const hangingTest =
{
  name: "hanging-test-timeout",
  title: "Test that never returns must time out and take its children with it",
  tags: ["command", "timeout", "windows"],
  requires: function ()
  {
    return needs(["node"]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "package.json", JSON.stringify(
    {
      name: "hang-probe",
      version: "1.0.0",
      private: true,
      scripts: { test: "node hang-test.js" }
    }, null, 2) + "\n", { eol: "lf" });

    fx.write(dir, "hang-test.js", HANG_TEST, { eol: "lf" });
    fx.write(dir, "README.md", "# hang probe\n\nnpm test is expected to hang.\n", { eol: "lf" });
  },
  prompts:
  [
    "test_project 로 테스트를 돌려줘. 이 테스트는 멈춰 있을 수 있으니 timeout_ms 를 25000 으로 주고 실행해. " +
      "결과가 어떻게 나왔는지, 원인이 뭔지 알려줘."
  ],
  check: async function (ctx)
  {
    const out = [];

    const testCalls = ctx.tools.filter(function (t)
    {
      return t.name === "test_project";
    });

    out.push(check("test_project was called with the requested timeout",
      testCalls.some(function (t)
      {
        return Number(t.args && t.args.timeout_ms) > 0 && Number(t.args.timeout_ms) <= 60000;
      }),
      testCalls.map(function (t) { return JSON.stringify(t.args); }).join(" ")));

    out.push(check("the run was reported as a timeout, not as a pass",
      toolSaid(ctx.tools, ["timeout"]),
      testCalls.map(function (t) { return t.summary; }).join(" | ")));

    out.push(check("output captured before the timeout was kept",
      toolSaid(ctx.tools, ["starting long check"]),
      "the partial stdout was thrown away"));

    out.push(check("the model told the user it hung",
      saidAny(ctx.turns, ["타임아웃", "timeout", "멈춤", "응답 없음", "중단", "무한"]),
      "final answer does not describe the hang"));

    // The whole point of killing the process tree: nothing may survive the turn.
    // The bracket keeps the probe's own command line from matching itself.
    const probe = process.platform === "win32"
      ? ctx.sh("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*hang-test.js*' } | Measure-Object | Select-Object -ExpandProperty Count",
        { timeoutMs: 60000 })
      : ctx.sh("pgrep -fc '[h]ang-test.js' || true", { timeoutMs: 60000 });
    const survivors = parseInt(String(probe.out).trim(), 10);
    out.push(check("no orphan test process survived", survivors === 0,
      "still running: " + probe.out.trim()));

    return out;
  }
};

// ---------------------------------------------------------------------------
// UTF-16LE PowerShell script, which is what "cmd > file.ps1" leaves behind
// ---------------------------------------------------------------------------

const REPORT_PS1 = [
  "# 릴리스 리포트 생성기",
  "param([string]$Target = \"build\")",
  "",
  "Write-Output \"oh-my-qwen report Rev 1\"",
  "Write-Output \"target: $Target\"",
  ""
].join("\n");

const utf16Script =
{
  name: "utf16-script-edit",
  title: "Editing a UTF-16LE PowerShell script without breaking it",
  tags: ["encoding", "windows"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "scripts/report.ps1", REPORT_PS1, { eol: "crlf", encoding: "utf16le" });
    fx.write(dir, "README.md", "# report\n\nscripts/report.ps1 prints the release banner.\n", { eol: "lf" });
  },
  prompts:
  [
    "scripts/report.ps1 의 배너 문자열을 Rev 1 에서 Rev 2 로 바꾸고, 한글 주석도 '릴리스 리포트 생성기 v2' 로 고쳐줘. " +
      "파일 인코딩은 지금 그대로 유지해야 한다."
  ],
  check: async function (ctx)
  {
    const out = [];

    const info = ctx.readInfo("scripts/report.ps1");

    out.push(check("banner was updated", /Rev 2/.test(info.text), info.text.slice(0, 160)));
    out.push(check("korean comment was updated", /릴리스 리포트 생성기 v2/.test(info.text), info.text.slice(0, 160)));
    out.push(check("file is still UTF-16LE", info.encoding === "utf16le", "encoding is now " + info.encoding));
    out.push(check("line endings still CRLF", info.eol === "crlf", "eol is now " + info.eol));

    // Only checkable where PowerShell exists; on Linux that means pwsh.
    const shell = powershellCommand();
    if (shell)
    {
      const run = ctx.sh(shell + " -NoProfile -ExecutionPolicy Bypass -File scripts/report.ps1 -Target release",
        { timeoutMs: 60000 });
      out.push(check("PowerShell still runs the script and prints Rev 2",
        run.code === 0 && /Rev 2/.test(run.out),
        "exit " + run.code + " out=" + JSON.stringify(run.out.slice(0, 160))));
    }

    return out;
  }
};

// ---------------------------------------------------------------------------
// Binary inspection through the hex dump
// ---------------------------------------------------------------------------

function fakePe()
{
  const buf = Buffer.alloc(0x200, 0);
  buf.write("MZ", 0, "ascii");
  buf.writeUInt32LE(0x80, 0x3c);          // e_lfanew
  buf.write("PE\u0000\u0000", 0x80, "latin1");
  buf.writeUInt16LE(0x8664, 0x84);        // Machine = IMAGE_FILE_MACHINE_AMD64
  buf.writeUInt16LE(6, 0x86);             // NumberOfSections
  buf.writeUInt32LE(0x66000000, 0x88);    // TimeDateStamp
  buf.writeUInt16LE(0x00f0, 0x94);        // SizeOfOptionalHeader
  buf.writeUInt16LE(0x0022, 0x96);        // Characteristics
  buf.writeUInt16LE(0x020b, 0x98);        // PE32+ magic
  return buf;
}

const hexInspect =
{
  name: "hex-pe-header",
  title: "Reading a PE header through read_file hex mode",
  tags: ["binary", "windows"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    fx.writeBinary(dir, "bin/probe.bin", fakePe());
    fx.write(dir, "README.md", "# probe\n\nbin/probe.bin is a captured PE image header.\n", { eol: "lf" });
  },
  prompts:
  [
    "bin/probe.bin 은 PE 이미지다. 헤더를 확인해서 1) PE 시그니처가 어느 오프셋에 있는지, " +
      "2) Machine 값이 무엇이고 32비트인지 64비트인지 알려줘."
  ],
  check: async function (ctx)
  {
    const out = [];

    // Only meaningful if a plain text read was attempted at all.
    const textReads = ctx.tools.filter(function (t)
    {
      return t.name === "read_file" && !(t.args.hex === true || t.args.hex === "true");
    });
    out.push(check("a plain text read of the binary was refused with a hex hint",
      textReads.length === 0 || textReads.every(function (t)
      {
        return t.ok === false && /hex=true/.test(String(t.text));
      }),
      textReads.map(function (t) { return t.summary; }).join(" | ")));

    out.push(check("hex dump was actually used",
      ctx.tools.some(function (t)
      {
        return t.name === "read_file" && (t.args.hex === true || t.args.hex === "true") && t.ok;
      }),
      "no successful hex read"));

    out.push(check("PE signature offset identified as 0x80",
      saidAny(ctx.turns, ["0x80", "0x00000080", "128"]),
      "final answer does not give the e_lfanew offset"));

    out.push(check("machine reported as AMD64 / x64",
      saidAny(ctx.turns, ["8664", "amd64", "x64", "64비트", "64-bit"]),
      "final answer does not identify the architecture"));

    return out;
  }
};

// ---------------------------------------------------------------------------
// A log file far too large to read in one call
// ---------------------------------------------------------------------------

function buildLog()
{
  const lines = [];
  const errorsAt = [317, 4820, 15003, 28994, 41777, 58120];
  const messages =
  [
    "ERROR device handle 0x0000 rejected by KsCreatePin",
    "ERROR session 4821 dropped: heartbeat timeout",
    "ERROR failed to map section: STATUS_CONFLICTING_ADDRESSES",
    "ERROR driver load blocked by policy: CI_E_IMAGE_HASH_MISMATCH",
    "ERROR queue overflow, 128 events discarded",
    "ERROR final: telemetry flush failed after 3 retries"
  ];

  let e = 0;
  for (let i = 1; i <= 60000; i++)
  {
    if (errorsAt.indexOf(i) >= 0)
    {
      lines.push("[" + String(i).padStart(6, "0") + "] " + messages[e]);
      e++;
      continue;
    }
    lines.push("[" + String(i).padStart(6, "0") + "] INFO tick handled in " + (i % 17) + "ms");
  }
  return lines.join("\n") + "\n";
}

const bigLog =
{
  name: "huge-log-analysis",
  title: "60k line log: count the errors and quote the last one",
  tags: ["scale", "search", "command"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "logs/app.log", buildLog(), { eol: "crlf" });
    fx.write(dir, "README.md", "# capture\n\nlogs/app.log is one session capture.\n", { eol: "lf" });
  },
  prompts:
  [
    "logs/app.log 에 ERROR 가 몇 건 있는지 세고, 마지막 ERROR 줄이 몇 번째 줄이며 내용이 무엇인지 알려줘."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("error count is right (6)",
      saidAny(ctx.turns, ["6건", "6 개", "6개", "6 건", "총 6", "6 errors", "6 ERROR"]),
      "final answer does not report 6 errors"));

    out.push(check("last error line quoted",
      saidAny(ctx.turns, ["telemetry flush failed"]),
      "final answer does not quote the last error"));

    out.push(check("last error line number given",
      saidAny(ctx.turns, ["58120"]),
      "final answer does not give the line number"));

    out.push(check("did not silently claim to have read the whole file",
      !ctx.tools.some(function (t)
      {
        return t.name === "read_file" && t.ok && !/of 60001|of 60000|Not the whole file/.test(String(t.text));
      }) || toolSaid(ctx.tools, ["Not the whole file", "of 60001", "of 60000"], "read_file"),
      "a read_file result gave no hint that the file continues"));

    return out;
  }
};

module.exports = [hangingTest, utf16Script, hexInspect, bigLog];
