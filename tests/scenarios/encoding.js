"use strict";

// Encoding and line-ending scenarios. These are the ones that break silently:
// nothing errors out, the file just quietly turns into mojibake or flips every
// line ending so the next diff is unreadable.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { check, needs, saidAny, countTool, toolSaid } = require("../lib/check");

// Decodes a legacy code page through Windows PowerShell, the same way the
// fixture wrote it.
function decodeLegacy(file, codepage)
{
  if (process.platform !== "win32")
  {
    const source = Number(codepage) === 949 ? "CP949" : ("CP" + codepage);
    const res = spawnSync("iconv", ["-f", source, "-t", "UTF-8", file],
      { encoding: "utf8", windowsHide: true });
    return res.status === 0 ? String(res.stdout || "") : "";
  }

  const script =
    "$ErrorActionPreference='Stop';" +
    "$bytes=[System.IO.File]::ReadAllBytes('" + file.split("\\").join("\\\\") + "');" +
    "$enc=[System.Text.Encoding]::GetEncoding(" + codepage + ");" +
    "[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($enc.GetString($bytes)))";

  const res = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
  {
    encoding: "utf8",
    windowsHide: true
  });

  if (res.status !== 0 || !res.stdout)
  {
    return "";
  }
  return Buffer.from(res.stdout.trim(), "base64").toString("utf8");
}

function isValidUtf8(buf)
{
  const text = buf.toString("utf8");
  return Buffer.compare(Buffer.from(text, "utf8"), buf) === 0;
}

function hasBom(dir, rel)
{
  const buf = fs.readFileSync(path.join(dir, rel));
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

// ---------------------------------------------------------------------------
// Legacy code page + UTF-16 data
// ---------------------------------------------------------------------------

const LEGACY_CPP = [
  "#include \"rules.h\"",
  "",
  "#include <cstdio>",
  "",
  "// 점수 계산 규칙: 한 판에서 얻을 수 있는 점수는 최대 250점으로 제한한다.",
  "// 연속 보너스는 3회까지만 누적하며, 그 이상은 무시한다.",
  "int ClampScore(int raw)",
  "{",
  "  if (raw > 250)",
  "  {",
  "    return 250;",
  "  }",
  "  return raw;",
  "}",
  "",
  "int main(void)",
  "{",
  "  printf(\"%d\\n\", ClampScore(400));",
  "  return 0;",
  "}",
  ""
].join("\n");

const RULES_H = [
  "#pragma once",
  "",
  "int ClampScore(int raw);",
  ""
].join("\n");

const EXPORT_CSV = [
  "player,score",
  "alpha,120",
  "beta,240",
  "gamma,65",
  "delta,15",
  ""
].join("\n");

const legacyEncoding =
{
  name: "encoding-legacy-mix",
  title: "CP949 source plus a UTF-16LE CSV, as PowerShell 5.1 leaves them",
  tags: ["encoding", "cpp"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "legacy/report.cpp", LEGACY_CPP, { eol: "crlf", encoding: "cp949" });
    fx.write(dir, "legacy/rules.h", RULES_H, { eol: "crlf", encoding: "utf8" });
    fx.write(dir, "data/export.csv", EXPORT_CSV, { eol: "crlf", encoding: "utf16le" });
  },
  prompts:
  [
    "legacy/report.cpp 의 한글 주석에 적힌 점수 제한 규칙을 읽고, 그 상한값을 legacy/rules.h 에 " +
      "MAX_SCORE 상수로 추가해줘. rules.h 에는 한글 주석으로 근거를 한 줄 남겨줘. " +
      "그리고 data/export.csv 의 score 열 합계도 계산해서 알려줘."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("CP949 comment was decoded, not mojibake",
      saidAny(ctx.turns, ["250"]) || toolSaid(ctx.tools, ["최대 250점"]),
      "the 250 limit never appears in the answer or any tool result"));

    out.push(check("UTF-16LE csv was readable (sum 440)",
      saidAny(ctx.turns, ["440"]),
      "answer never states the correct total"));

    const headerText = ctx.exists("legacy/rules.h") ? ctx.read("legacy/rules.h") : "";
    out.push(check("MAX_SCORE was added to rules.h",
      /MAX_SCORE/.test(headerText) && /250/.test(headerText),
      headerText.slice(0, 200)));

    const korean = /[가-힣]/.test(headerText);
    out.push(check("korean comment landed in rules.h", korean, korean ? "" : "no hangul in the header"));

    // The BOM is a Windows answer to MSVC's C4819. GCC and Clang read UTF-8
    // without one, and on Linux the app deliberately does not add it.
    const bomLabel = process.platform === "win32"
      ? "rules.h got a UTF-8 BOM so MSVC will not warn C4819"
      : "rules.h was saved as UTF-8 without a Windows BOM";
    if (korean)
    {
      const bom = hasBom(ctx.dir, "legacy/rules.h");
      out.push(check(bomLabel, process.platform === "win32" ? bom : !bom,
        bom ? "a BOM was added on Linux" : "no BOM on a header that now contains hangul"));
    }
    else
    {
      out.push(check(bomLabel, false, "skipped, no hangul written"));
    }

    const cppBuf = fs.readFileSync(path.join(ctx.dir, "legacy/report.cpp"));
    const asUtf8 = isValidUtf8(cppBuf) ? cppBuf.toString("utf8").replace(/^﻿/, "") : "";
    const asLegacy = asUtf8 ? "" : decodeLegacy(path.join(ctx.dir, "legacy/report.cpp"), 949);
    const readable = /최대 250점/.test(asUtf8 || asLegacy);
    out.push(check("report.cpp survived without turning into mojibake", readable,
      (asUtf8 || asLegacy).split("\n").slice(4, 6).join(" | ").slice(0, 160)));

    return out;
  }
};

// ---------------------------------------------------------------------------
// Mixed EOL / BOM rename across a tree
// ---------------------------------------------------------------------------

const RENAME_FILES =
[
  {
    rel: "src/engine.cpp",
    eol: "crlf",
    encoding: "utf8bom",
    text: [
      "#include \"engine.h\"",
      "",
      "// 점수 계산은 ComputeScore 하나만 쓴다.",
      "int ComputeScore(int base, int bonus)",
      "{",
      "  return base + bonus;",
      "}",
      ""
    ].join("\n")
  },
  {
    rel: "src/loader.cpp",
    eol: "lf",
    encoding: "utf8",
    text: [
      "#include \"engine.h\"",
      "",
      "int LoadAndScore(int base)",
      "{",
      "  return ComputeScore(base, 10);",
      "}",
      ""
    ].join("\n")
  },
  {
    rel: "src/engine.h",
    eol: "crlf",
    encoding: "utf8",
    text: [
      "#pragma once",
      "",
      "int ComputeScore(int base, int bonus);",
      "int LoadAndScore(int base);",
      ""
    ].join("\n")
  },
  {
    rel: "scripts/report.ps1",
    eol: "crlf",
    encoding: "utf8bom",
    text: [
      "# 리포트 생성 스크립트",
      "param([int]$Base = 0)",
      "Write-Output \"ComputeScore base=$Base\"",
      ""
    ].join("\n")
  },
  {
    rel: "docs/notes.md",
    eol: "lf",
    encoding: "utf8",
    text: [
      "# notes",
      "",
      "`ComputeScore` is the only scoring entry point.",
      ""
    ].join("\n")
  },
  {
    rel: "config/rules.json",
    eol: "lf",
    encoding: "utf8",
    text: JSON.stringify({ entry: "ComputeScore", version: 2 }, null, 2) + "\n"
  }
];

const renameState = { blob: null };

const mixedRename =
{
  name: "rename-mixed-eol",
  title: "Tree-wide rename across CRLF/LF, BOM/no-BOM and one binary decoy",
  tags: ["encoding", "edit", "search"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    for (let i = 0; i < RENAME_FILES.length; i++)
    {
      const f = RENAME_FILES[i];
      fx.write(dir, f.rel, f.text, { eol: f.eol, encoding: f.encoding });
    }

    // A binary blob whose bytes happen to contain the identifier. Rewriting it
    // as text would corrupt it, so it must be skipped.
    const blob = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x00]),
      Buffer.from("ComputeScore", "utf8"),
      Buffer.from([0x00, 0x00, 0x90, 0x90, 0x00])
    ]);
    fx.writeBinary(dir, "assets/table.dat", blob);
    renameState.blob = blob;
  },
  prompts:
  [
    "프로젝트 전체에서 식별자 ComputeScore 를 EvaluateScore 로 바꿔줘. 텍스트 파일만 대상이고, " +
      "줄바꿈이나 인코딩은 원래대로 유지해야 한다. 어떤 파일을 몇 군데 바꿨는지 알려줘."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("used replace_in_files rather than one edit per file",
      countTool(ctx.tools, "replace_in_files") > 0,
      "replace_in_files x" + countTool(ctx.tools, "replace_in_files") +
        ", edit_file x" + countTool(ctx.tools, "edit_file") +
        ", write_file x" + countTool(ctx.tools, "write_file")));

    let allRenamed = true;
    let eolKept = true;
    let bomKept = true;
    const details = [];

    for (let i = 0; i < RENAME_FILES.length; i++)
    {
      const f = RENAME_FILES[i];
      const info = ctx.readInfo(f.rel);

      if (/ComputeScore/.test(info.text) || !/EvaluateScore/.test(info.text))
      {
        allRenamed = false;
        details.push(f.rel + ": not renamed");
      }
      if (info.eol !== f.eol)
      {
        eolKept = false;
        details.push(f.rel + ": eol " + f.eol + " -> " + info.eol);
      }
      const wantBom = f.encoding === "utf8bom";
      if (hasBom(ctx.dir, f.rel) !== wantBom)
      {
        bomKept = false;
        details.push(f.rel + ": bom " + wantBom + " -> " + !wantBom);
      }
    }

    out.push(check("every text file was renamed", allRenamed, details.filter(function (d)
    {
      return d.indexOf("not renamed") >= 0;
    }).join("; ")));

    out.push(check("line endings preserved per file", eolKept, details.filter(function (d)
    {
      return d.indexOf("eol") >= 0;
    }).join("; ")));

    out.push(check("BOM preserved per file", bomKept, details.filter(function (d)
    {
      return d.indexOf("bom") >= 0;
    }).join("; ")));

    const blobNow = fs.readFileSync(path.join(ctx.dir, "assets/table.dat"));
    out.push(check("binary decoy left untouched",
      Buffer.compare(blobNow, renameState.blob) === 0,
      "assets/table.dat was rewritten"));

    const json = ctx.read("config/rules.json");
    let jsonOk = false;
    try
    {
      jsonOk = JSON.parse(json).entry === "EvaluateScore";
    }
    catch (err)
    {
      jsonOk = false;
    }
    out.push(check("json stayed valid after the rename", jsonOk, json.slice(0, 120)));

    return out;
  }
};

module.exports = [legacyEncoding, mixedRename];
