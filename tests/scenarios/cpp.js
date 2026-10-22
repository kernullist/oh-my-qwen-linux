"use strict";

// C and C++ scenarios: CMake with ctest, and a bare MSVC project that crashes
// at runtime so the NTSTATUS decoding path gets exercised.

const crypto = require("crypto");
const { check, needs, saidAny, toolSaid, countTool } = require("../lib/check");

function hash(text)
{
  return crypto.createHash("sha1").update(String(text).replace(/\r\n/g, "\n")).digest("hex");
}

const CMAKELISTS = [
  "cmake_minimum_required(VERSION 3.15)",
  "project(stats CXX)",
  "set(CMAKE_CXX_STANDARD 17)",
  "set(CMAKE_CXX_STANDARD_REQUIRED ON)",
  "",
  "add_library(stats src/stats.cpp)",
  "target_include_directories(stats PUBLIC src)",
  "",
  "add_executable(stats_app src/main.cpp)",
  "target_link_libraries(stats_app PRIVATE stats)",
  "",
  "enable_testing()",
  "add_executable(test_stats tests/test_stats.cpp)",
  "target_link_libraries(test_stats PRIVATE stats)",
  "add_test(NAME stats_median COMMAND test_stats)",
  ""
].join("\n");

const STATS_H = [
  "#pragma once",
  "",
  "#include <vector>",
  "",
  "double Mean(const std::vector<double>& values);",
  "double Median(std::vector<double> values);",
  ""
].join("\n");

// Two planted defects:
//   1. std::sort without <algorithm>, so the build fails outright.
//   2. the even-length median picks one element instead of averaging the pair,
//      which only the test catches.
const STATS_CPP = [
  "#include \"stats.h\"",
  "",
  "double Mean(const std::vector<double>& values)",
  "{",
  "  if (values.empty())",
  "  {",
  "    return 0.0;",
  "  }",
  "",
  "  double total = 0.0;",
  "  for (size_t i = 0; i < values.size(); i++)",
  "  {",
  "    total += values[i];",
  "  }",
  "  return total / static_cast<double>(values.size());",
  "}",
  "",
  "double Median(std::vector<double> values)",
  "{",
  "  if (values.empty())",
  "  {",
  "    return 0.0;",
  "  }",
  "",
  "  std::sort(values.begin(), values.end());",
  "  return values[values.size() / 2];",
  "}",
  ""
].join("\n");

const MAIN_CPP = [
  "#include \"stats.h\"",
  "",
  "#include <cstdio>",
  "",
  "int main(void)",
  "{",
  "  std::vector<double> samples = { 4.0, 1.0, 3.0, 2.0 };",
  "  printf(\"mean=%.2f median=%.2f\\n\", Mean(samples), Median(samples));",
  "  return 0;",
  "}",
  ""
].join("\n");

const TEST_CPP = [
  "#include \"stats.h\"",
  "",
  "#include <cstdio>",
  "#include <cmath>",
  "",
  "static int Expect(const char* what, double actual, double expected)",
  "{",
  "  if (std::fabs(actual - expected) < 1e-9)",
  "  {",
  "    return 0;",
  "  }",
  "  printf(\"FAIL %s: expected %.4f, got %.4f\\n\", what, expected, actual);",
  "  return 1;",
  "}",
  "",
  "int main(void)",
  "{",
  "  int failures = 0;",
  "",
  "  failures += Expect(\"median of even count\", Median({ 1.0, 2.0, 3.0, 4.0 }), 2.5);",
  "  failures += Expect(\"median of odd count\", Median({ 5.0, 1.0, 3.0 }), 3.0);",
  "  failures += Expect(\"mean\", Mean({ 2.0, 4.0, 6.0 }), 4.0);",
  "",
  "  if (failures == 0)",
  "  {",
  "    printf(\"all 3 checks passed\\n\");",
  "  }",
  "  return failures == 0 ? 0 : 1;",
  "}",
  ""
].join("\n");

const cmakeState = { testHash: "" };

const cmakeFixAndTest =
{
  name: "cmake-fix-and-test",
  title: "CMake project: compile error then a failing ctest",
  tags: ["cpp", "cmake", "build", "test"],
  requires: function ()
  {
    return needs(["cmake", "ctest", process.platform === "win32" ? "msvc" : "cxx"] );
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "CMakeLists.txt", CMAKELISTS, { eol: "crlf" });
    fx.write(dir, "src/stats.h", STATS_H, { eol: "crlf" });
    fx.write(dir, "src/stats.cpp", STATS_CPP, { eol: "crlf" });
    fx.write(dir, "src/main.cpp", MAIN_CPP, { eol: "crlf" });
    fx.write(dir, "tests/test_stats.cpp", TEST_CPP, { eol: "crlf" });
    cmakeState.testHash = hash(TEST_CPP);
  },
  prompts:
  [
    "이 CMake 프로젝트가 지금 빌드부터 실패한다. build_project 로 확인해서 컴파일 에러를 고치고, " +
      "그 다음 test_project 로 테스트를 돌려서 실패하는 케이스까지 전부 통과시켜줘. 테스트 파일은 수정하지 마."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("project detected as cmake",
      ctx.detected && ctx.detected.kind === "cmake",
      ctx.detected ? ctx.detected.kind : "nothing detected"));

    out.push(check("used build_project instead of guessing a shell command",
      countTool(ctx.tools, "build_project") > 0,
      "build_project x" + countTool(ctx.tools, "build_project") +
        ", run_command x" + countTool(ctx.tools, "run_command")));

    out.push(check("used test_project",
      countTool(ctx.tools, "test_project") > 0,
      "test_project x" + countTool(ctx.tools, "test_project")));

    out.push(check("build diagnostics reached the model",
      toolSaid(ctx.tools, ["error C", "algorithm", "sort"]),
      "no compiler diagnostic seen in any tool result"));

    const testUnchanged = ctx.exists("tests/test_stats.cpp") && hash(ctx.read("tests/test_stats.cpp")) === cmakeState.testHash;
    out.push(check("test file was not edited to make it pass", testUnchanged,
      testUnchanged ? "" : "tests/test_stats.cpp changed"));

    const build = ctx.sh("cmake -S . -B verify -DCMAKE_BUILD_TYPE=Debug >/dev/null 2>&1; cmake --build verify --config Debug 2>&1", { timeoutMs: 300000 });
    out.push(check("independent cmake build succeeds", build.code === 0,
      build.code === 0 ? "" : ("exit " + build.code + "\n" + build.out.split("\n").slice(-12).join("\n"))));

    if (build.code === 0)
    {
      const test = ctx.sh("ctest --test-dir verify -C Debug --output-on-failure --timeout 60 2>&1", { timeoutMs: 180000 });
      out.push(check("independent ctest passes", test.code === 0,
        test.code === 0 ? "" : ("exit " + test.code + "\n" + test.out.split("\n").slice(-15).join("\n"))));
    }
    else
    {
      out.push(check("independent ctest passes", false, "skipped, build failed"));
    }

    return out;
  }
};

const CRASH_CPP = [
  "#include <cstdio>",
  "#include <cstring>",
  "",
  "struct Record",
  "{",
  "  char name[16];",
  "  int score;",
  "};",
  "",
  "static Record* FindRecord(Record* records, int count, const char* name)",
  "{",
  "  for (int i = 0; i < count; i++)",
  "  {",
  "    if (strcmp(records[i].name, name) == 0)",
  "    {",
  "      return &records[i];",
  "    }",
  "  }",
  "  return nullptr;",
  "}",
  "",
  "static void Fill(Record& record, const char* name, int score)",
  "{",
  "  memset(record.name, 0, sizeof(record.name));",
  "  memcpy(record.name, name, strlen(name));",
  "  record.score = score;",
  "}",
  "",
  "int main(void)",
  "{",
  "  Record records[3];",
  "  Fill(records[0], \"alpha\", 10);",
  "  Fill(records[1], \"beta\", 20);",
  "  Fill(records[2], \"gamma\", 30);",
  "",
  "  const char* wanted[] = { \"beta\", \"delta\" };",
  "",
  "  for (int i = 0; i < 2; i++)",
  "  {",
  "    Record* hit = FindRecord(records, 3, wanted[i]);",
  "    printf(\"%s -> %d\\n\", wanted[i], hit->score);",
  "  }",
  "",
  "  return 0;",
  "}",
  ""
].join("\n");

const msvcCrashFix =
{
  name: "msvc-crash-fix",
  title: "Bare MSVC sources that crash with an access violation",
  tags: ["cpp", "msvc", "runtime"],
  requires: function ()
  {
    return needs(["msvc"]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "main.cpp", CRASH_CPP, { eol: "crlf" });
    fx.write(dir, "notes.txt", "lookup table demo\n", { eol: "crlf" });
  },
  prompts:
  [
    "이 프로그램을 먼저 그대로 빌드하고 실행해서 무슨 일이 일어나는지 확인해줘. " +
      "문제가 있으면 원인을 정확히 짚고 고친 다음, 다시 빌드·실행해서 정상 종료하는지 확인해줘."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("project detected as msvc-direct",
      ctx.detected && ctx.detected.kind === "msvc-direct",
      ctx.detected ? ctx.detected.kind : "nothing detected"));

    out.push(check("crash was reported as ACCESS_VIOLATION, not a bare exit code",
      toolSaid(ctx.tools, ["ACCESS_VIOLATION", "0xC0000005"]),
      "no NTSTATUS name in any tool result"));

    out.push(check("model explained the null dereference",
      saidAny(ctx.turns, ["nullptr", "null", "널", "NULL"]),
      "final answer never mentions the null pointer"));

    const build = ctx.sh("cl /nologo /EHsc /W4 /Zi /Fe:verify.exe main.cpp", { msvc: true, timeoutMs: 240000 });
    out.push(check("fixed source still compiles", build.code === 0,
      build.code === 0 ? "" : ("exit " + build.code + "\n" + (build.out + build.err).split("\n").slice(-10).join("\n"))));

    if (build.code === 0)
    {
      const run = ctx.sh(".\\verify.exe", { timeoutMs: 60000 });
      out.push(check("fixed program exits cleanly", run.code === 0,
        "exit " + run.code + " out=" + JSON.stringify(run.out.slice(0, 200))));
      out.push(check("known record still resolves", /beta\s*->\s*20/.test(run.out),
        JSON.stringify(run.out.slice(0, 200))));
    }
    else
    {
      out.push(check("fixed program exits cleanly", false, "skipped, build failed"));
      out.push(check("known record still resolves", false, "skipped, build failed"));
    }

    return out;
  }
};

module.exports = [cmakeFixAndTest, msvcCrashFix];
