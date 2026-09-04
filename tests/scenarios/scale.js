"use strict";

// Scale scenarios: a tree big enough that search results get truncated, a
// minified one-line file, and a command whose real exit code is buried under
// tens of thousands of output lines.

const { check, needs, saidAny, toolSaid } = require("../lib/check");

const MODULES = ["audio", "input", "netcode", "physics", "render", "scene", "ui", "util"];

function filler(index, name)
{
  return [
    "// " + name + " module, generated fixture " + index,
    "#pragma once",
    "",
    "#include <cstdint>",
    "",
    "namespace " + name,
    "{",
    "  struct Entry" + index,
    "  {",
    "    uint32_t id;",
    "    float weight;",
    "  };",
    "",
    "  inline uint32_t Hash" + index + "(uint32_t seed)",
    "  {",
    "    return seed * 2654435761u + " + (index * 7 + 13) + "u;",
    "  }",
    "}",
    ""
  ].join("\n");
}

function minifiedJson(marker)
{
  const items = [];
  for (let i = 0; i < 260; i++)
  {
    items.push({ id: i, sku: "SKU-" + (10000 + i), tags: ["alpha", "beta", "gamma"], price: 1000 + i * 3 });
  }
  const payload =
  {
    generatedBy: "packer",
    items: items,
    buildVersion: marker,
    checksum: "d41d8cd98f00b204e9800998ecf8427e"
  };
  return JSON.stringify(payload);
}

const bigTree =
{
  name: "big-tree-search",
  title: "Thousands of files, one marker, and a minified one-line JSON",
  tags: ["scale", "search"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    let n = 0;
    for (let m = 0; m < MODULES.length; m++)
    {
      for (let g = 0; g < 8; g++)
      {
        for (let f = 0; f < 18; f++)
        {
          n++;
          fx.write(dir, "engine/" + MODULES[m] + "/group" + g + "/part" + f + ".h", filler(n, MODULES[m]), { eol: "crlf" });
        }
      }
    }

    // The one file that matters, buried where a truncated listing would hide it.
    fx.write(dir, "engine/netcode/group5/part11_notes.h", [
      "// netcode module notes",
      "#pragma once",
      "",
      "// TODO_MARKER_ZX9 replay desync when the tick rate drops below 20 Hz",
      "",
      "namespace netcode",
      "{",
      "  void ReplayGuard();",
      "}",
      ""
    ].join("\n"), { eol: "crlf" });

    fx.write(dir, "data/catalog.min.json", minifiedJson("7.3.1-rc2") + "\n", { eol: "lf" });
    fx.write(dir, "README.md", "# engine fixture\n\nGenerated tree.\n", { eol: "lf" });
  },
  prompts:
  [
    "이 리포지토리에서 TODO_MARKER_ZX9 가 들어 있는 파일 경로와 그 줄의 내용을 찾아줘. " +
      "그리고 data/catalog.min.json 안의 buildVersion 값도 알려줘."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("found the marker file path",
      saidAny(ctx.turns, ["part11_notes.h"]),
      "final answer does not name the file"));

    out.push(check("quoted the marker line",
      saidAny(ctx.turns, ["desync", "20 Hz", "tick"]),
      "final answer does not include the line text"));

    out.push(check("read buildVersion out of the minified json",
      saidAny(ctx.turns, ["7.3.1-rc2"]),
      "final answer does not contain the version"));

    out.push(check("long-line clipping was announced when the json was read",
      !ctx.usedTool("read_file") || toolSaid(ctx.tools, ["cut here", "very long line"], "read_file") ||
        !toolSaid(ctx.tools, ["catalog.min.json"], "read_file"),
      "read_file returned the one-line json without saying it was clipped"));

    return out;
  }
};

const NOISY_PS1 = [
  "# Emits a lot of output and then fails, the way a real test runner does.",
  "$ErrorActionPreference = 'Continue'",
  "for ($i = 1; $i -le 24000; $i++)",
  "{",
  "  Write-Output (\"[{0:D5}] checking module fixture entry\" -f $i)",
  "}",
  "Write-Output 'FAILED: 3 of 24000 checks did not pass'",
  "Write-Output 'first failure: fixture entry 04711 returned 3 instead of 4'",
  "exit 1",
  ""
].join("\n");

const noisyExit =
{
  name: "noisy-command-exit",
  title: "24k lines of output, real failure only on the last lines",
  tags: ["scale", "command"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "scripts/checks.ps1", NOISY_PS1, { eol: "crlf" });
    fx.write(dir, "README.md", "# noisy\n\nRun scripts/checks.ps1 to validate fixtures.\n", { eol: "lf" });
  },
  prompts:
  [
    "scripts/checks.ps1 를 실행해서 결과를 알려줘. 성공했는지 실패했는지, 실패했다면 어떤 항목이 왜 실패했는지까지."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("the run was reported as a failure, not a silent success",
      saidAny(ctx.turns, ["실패", "fail", "exit 1", "오류"]),
      "final answer reads as success"));

    out.push(check("the tail of the output survived clipping",
      toolSaid(ctx.tools, ["04711", "3 of 24000", "first failure"]),
      "no tool result contains the closing failure lines"));

    out.push(check("exit code 1 reached the model",
      toolSaid(ctx.tools, ["exit 1", "exit code 1"]),
      "no tool result reports the non-zero exit code"));

    out.push(check("model named the failing entry",
      saidAny(ctx.turns, ["04711", "4711"]),
      "final answer does not identify the failing fixture"));

    return out;
  }
};

module.exports = [bigTree, noisyExit];
