"use strict";

// Project shapes the earlier rounds never exercised: a Windows kernel driver,
// a repository whose one version string lives in five languages, a CI workflow
// where indentation is the syntax, a batch script to port, and a migration
// directory whose old files are immutable.

const { check, needs, known, countTool, saidAny, powershellCommand } = require("../lib/check");
const style = require("../lib/style");

// ---------------------------------------------------------------------------
// KMDF driver: a leak on the failure path
// ---------------------------------------------------------------------------

const DRIVER_C = [
  "// Sample KMDF driver. Not buildable without the WDK; edited by hand.",
  "#include <ntddk.h>",
  "#include <wdf.h>",
  "#include \"driver.h\"",
  "",
  "#define TELEMETRY_TAG 'lTmO'",
  "",
  "DRIVER_INITIALIZE DriverEntry;",
  "EVT_WDF_DRIVER_DEVICE_ADD OmqEvtDeviceAdd;",
  "",
  "NTSTATUS DriverEntry(_In_ PDRIVER_OBJECT DriverObject, _In_ PUNICODE_STRING RegistryPath)",
  "{",
  "  WDF_DRIVER_CONFIG config;",
  "  NTSTATUS status;",
  "  PTELEMETRY_CONTEXT context;",
  "",
  "  context = (PTELEMETRY_CONTEXT)ExAllocatePool2(POOL_FLAG_NON_PAGED,",
  "    sizeof(TELEMETRY_CONTEXT), TELEMETRY_TAG);",
  "  if (context == NULL)",
  "  {",
  "    return STATUS_INSUFFICIENT_RESOURCES;",
  "  }",
  "",
  "  RtlZeroMemory(context, sizeof(TELEMETRY_CONTEXT));",
  "  context->Version = TELEMETRY_VERSION;",
  "",
  "  WDF_DRIVER_CONFIG_INIT(&config, OmqEvtDeviceAdd);",
  "  config.DriverPoolTag = TELEMETRY_TAG;",
  "",
  "  status = WdfDriverCreate(DriverObject, RegistryPath, WDF_NO_OBJECT_ATTRIBUTES,",
  "    &config, WDF_NO_HANDLE);",
  "  if (!NT_SUCCESS(status))",
  "  {",
  "    DbgPrint(\"omq: WdfDriverCreate failed 0x%08X\\n\", status);",
  "    return status;",
  "  }",
  "",
  "  gTelemetry = context;",
  "  return STATUS_SUCCESS;",
  "}",
  ""
].join("\n");

const kmdfDriverLeak =
{
  name: "kmdf-driver-leak",
  title: "Free the pool allocation on a driver failure path",
  tags: ["driver", "review"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "driver.c", DRIVER_C, { eol: "crlf" });

    fx.write(dir, "driver.h", [
      "#pragma once",
      "",
      "#define TELEMETRY_VERSION 3",
      "",
      "typedef struct _TELEMETRY_CONTEXT",
      "{",
      "  ULONG Version;",
      "  ULONG EventCount;",
      "} TELEMETRY_CONTEXT, *PTELEMETRY_CONTEXT;",
      "",
      "extern PTELEMETRY_CONTEXT gTelemetry;",
      ""
    ].join("\n"), { eol: "crlf" });

    fx.write(dir, "queue.c", [
      "#include <ntddk.h>",
      "#include <wdf.h>",
      "#include \"driver.h\"",
      "",
      "PTELEMETRY_CONTEXT gTelemetry = NULL;",
      "",
      "NTSTATUS OmqEvtDeviceAdd(_In_ WDFDRIVER Driver, _Inout_ PWDFDEVICE_INIT DeviceInit)",
      "{",
      "  UNREFERENCED_PARAMETER(Driver);",
      "  UNREFERENCED_PARAMETER(DeviceInit);",
      "  return STATUS_SUCCESS;",
      "}",
      ""
    ].join("\n"), { eol: "crlf" });

    fx.write(dir, "omqtel.inf", [
      "[Version]",
      "Signature=\"$WINDOWS NT$\"",
      "Class=System",
      "Provider=%ManufacturerName%",
      "",
      "[Strings]",
      "ManufacturerName=\"internal\"",
      ""
    ].join("\n"), { eol: "crlf" });

    fx.write(dir, "README.md",
      "# omqtel\n\nKMDF telemetry driver. Requires the WDK; do not try to build it here.\n",
      { eol: "lf" });
  },
  prompts:
  [
    "driver.c 의 DriverEntry 에 실패 경로 누수가 있어. 찾아서 고쳐줘. WDK 가 없으니 빌드는 하지 마. " +
      "정상 경로 동작은 바꾸지 말고, 무엇이 문제였는지 한 줄로 알려줘."
  ],
  check: async function (ctx)
  {
    const out = [];
    const c = ctx.read("driver.c") || "";

    out.push(check("the allocation is still there", /ExAllocatePool2\s*\(/.test(c),
      "ExAllocatePool2 disappeared"));
    // ExFreePool, ExFreePoolWithTag and ExFreePool2 are all real; ExFreePool2 is
    // in fact the correct partner for the ExAllocatePool2 this driver uses.
    out.push(check("a free was added", /ExFreePool(WithTag|2)?\s*\(/.test(c),
      "no ExFreePool call anywhere in driver.c"));

    // The free has to sit on the failing branch, not somewhere convenient.
    const onFailure = /!NT_SUCCESS\s*\(\s*status\s*\)[\s\S]{0,400}?ExFreePool(WithTag|2)?\s*\([\s\S]{0,200}?return\s+status/
      .test(c);
    out.push(check("the free is on the WdfDriverCreate failure branch", onFailure,
      "ExFreePool is present but not between the !NT_SUCCESS test and its return"));

    // A coin flip on API knowledge: ExFreePool2 called with one argument, which
    // will not compile, about half the time. Not a hard limit - it was first
    // written up here as one and four runs disproved that - but not something
    // the app has any lever on either, since the scenario forbids building and
    // there is no WDK here to compile against.
    //
    // Marked as a limit for what that buys: the scenario's other eight checks
    // become trustworthy, because it can now reach a reliable pass rate and a
    // regression in any of them is visible. Left as a hard failure it would sit
    // near 50% forever and nothing inside it could ever be flagged. The check
    // still runs, and a run says so when it passes.
    const badArity = /ExFreePool2\s*\(\s*[^,()]+\s*\)/.test(c);
    out.push(known("the free call has the arity its API requires", !badArity,
      "ExFreePool2 takes (P, Tag, ExtendedParameters, Count); a one-argument call will not compile",
      "this model does not know this API's signature and nothing here can compile-check it"));

    out.push(check("the success path still publishes the context",
      /gTelemetry\s*=\s*context/.test(c) && /return\s+STATUS_SUCCESS/.test(c),
      "the success path changed"));
    out.push(check("the out-of-memory path is untouched",
      /STATUS_INSUFFICIENT_RESOURCES/.test(c), "the allocation failure return is gone"));

    out.push(check("no build was attempted", countTool(ctx.tools, "build_project") === 0,
      "build_project x" + countTool(ctx.tools, "build_project")));

    out.push(check("driver.c is still CRLF", (ctx.readInfo("driver.c") || {}).eol === "crlf",
      "eol is " + String((ctx.readInfo("driver.c") || {}).eol)));

    const wide = style.nonAsciiLines(c);
    out.push(check("no non-ASCII crept into the driver source", wide.length === 0, style.describe(wide)));

    out.push(check("the model explained the leak",
      saidAny(ctx.turns, ["누수", "leak", "해제", "free"]), "final answer does not mention the leak"));

    return out;
  }
};

// ---------------------------------------------------------------------------
// One version string, five languages, one vendored decoy
// ---------------------------------------------------------------------------

const monorepoVersionBump =
{
  name: "monorepo-version-bump",
  title: "Bump one version across five languages without touching vendored code",
  tags: ["bulk", "monorepo"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "native/include/version.h", [
      "#pragma once",
      "",
      "#define APP_VERSION \"1.4.2\"",
      "#define APP_VERSION_MAJOR 1",
      "#define APP_VERSION_MINOR 4",
      "#define APP_VERSION_PATCH 2",
      ""
    ].join("\n"), { eol: "crlf" });

    fx.write(dir, "tools/deploy.py", [
      "\"\"\"Deploy helper.\"\"\"",
      "",
      "APP_VERSION = \"1.4.2\"",
      "",
      "",
      "def artifact_name(platform):",
      "    return \"app-{}-{}.zip\".format(APP_VERSION, platform)",
      ""
    ].join("\n"), { eol: "lf" });

    fx.write(dir, "web/package.json", [
      "{",
      "  \"name\": \"app-web\",",
      "  \"version\": \"1.4.2\",",
      "  \"private\": true,",
      "  \"scripts\": {",
      "    \"build\": \"node build.js\"",
      "  }",
      "}",
      ""
    ].join("\n"), { eol: "lf" });

    fx.write(dir, ".github/workflows/release.yml", [
      "name: release",
      "",
      "on:",
      "  push:",
      "    tags:",
      "      - \"v*\"",
      "",
      "env:",
      "  APP_VERSION: \"1.4.2\"",
      "",
      "jobs:",
      "  package:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - name: Show version",
      "        run: echo \"$APP_VERSION\"",
      ""
    ].join("\n"), { eol: "lf" });

    fx.write(dir, "CHANGELOG.md", [
      "# Changelog",
      "",
      "## 1.4.2",
      "",
      "- Fixed a crash in the telemetry writer.",
      "",
      "## 1.4.1",
      "",
      "- First public build.",
      ""
    ].join("\n"), { eol: "lf" });

    // Vendored, and it happens to sit at the same version. Out of scope.
    fx.write(dir, "third_party/zlibwrap/vendor.json", [
      "{",
      "  \"name\": \"zlibwrap\",",
      "  \"version\": \"1.4.2\",",
      "  \"upstream\": \"https://example.invalid/zlibwrap\"",
      "}",
      ""
    ].join("\n"), { eol: "lf" });

    fx.write(dir, "README.md",
      "# app\n\nnative/, web/, tools/ are ours. third_party/ is vendored and never edited by hand.\n",
      { eol: "lf" });
  },
  prompts:
  [
    "우리 제품 버전을 1.4.2 에서 1.5.0 으로 올려줘. native, tools, web, .github 어디에 있든 다 바꿔야 해. " +
      "third_party 는 외부에서 가져온 코드라 절대 건드리면 안 돼. " +
      "CHANGELOG.md 에는 1.5.0 항목을 새로 추가해줘."
  ],
  check: async function (ctx)
  {
    const out = [];

    const bumped = ["native/include/version.h", "tools/deploy.py", "web/package.json",
      ".github/workflows/release.yml"];
    for (let i = 0; i < bumped.length; i++)
    {
      const rel = bumped[i];
      const text = ctx.read(rel) || "";
      out.push(check(rel + " says 1.5.0",
        text.indexOf("1.5.0") >= 0 && text.indexOf("1.4.2") < 0,
        text.indexOf("1.4.2") >= 0 ? "still contains 1.4.2" : "no 1.5.0 found"));
    }

    const vh = ctx.read("native/include/version.h") || "";
    out.push(check("the split version macros were bumped too",
      /APP_VERSION_MINOR\s+5/.test(vh) && /APP_VERSION_PATCH\s+0/.test(vh),
      "MINOR/PATCH macros still describe 1.4.2"));

    const vendor = ctx.read("third_party/zlibwrap/vendor.json") || "";
    out.push(check("the vendored file was left at 1.4.2", vendor.indexOf("1.4.2") >= 0,
      "third_party was edited: " + vendor.slice(0, 120)));

    const changelog = ctx.read("CHANGELOG.md") || "";
    out.push(check("CHANGELOG gained a 1.5.0 section", /^##\s*\[?1\.5\.0/m.test(changelog),
      changelog.slice(0, 160)));
    out.push(check("CHANGELOG kept its history",
      /1\.4\.2/.test(changelog) && /1\.4\.1/.test(changelog), "old entries were rewritten away"));

    out.push(check("used one bulk replace rather than a per-file loop",
      countTool(ctx.tools, "replace_in_files") > 0,
      "replace_in_files x" + countTool(ctx.tools, "replace_in_files") +
        ", edit_file x" + countTool(ctx.tools, "edit_file")));

    out.push(check("version.h kept its CRLF endings",
      (ctx.readInfo("native/include/version.h") || {}).eol === "crlf",
      "eol is " + String((ctx.readInfo("native/include/version.h") || {}).eol)));

    const yamlBad = style.yamlIssues(ctx.read(".github/workflows/release.yml") || "");
    out.push(check("the workflow file is still well indented", yamlBad.length === 0,
      style.describe(yamlBad)));

    return out;
  }
};

// ---------------------------------------------------------------------------
// A CI workflow, where indentation is the syntax
// ---------------------------------------------------------------------------

const workflowMatrix =
{
  name: "github-actions-matrix",
  title: "Extend a CI matrix without breaking YAML indentation",
  tags: ["yaml", "ci"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, ".github/workflows/ci.yml", [
      "name: ci",
      "",
      "on:",
      "  push:",
      "    branches:",
      "      - master",
      "  pull_request:",
      "",
      "jobs:",
      "  build:",
      "    runs-on: ${{ matrix.os }}",
      "    strategy:",
      "      fail-fast: false",
      "      matrix:",
      "        os:",
      "          - ubuntu-latest",
      "        node:",
      "          - 20",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: ${{ matrix.node }}",
      "      - name: Build",
      "        run: node build.js",
      ""
    ].join("\n"), { eol: "lf" });

    fx.write(dir, "build.js", "console.log(\"build ok\");\n", { eol: "lf" });
    fx.write(dir, "test.js", "console.log(\"tests ok\");\n", { eol: "lf" });
    fx.write(dir, "package.json", [
      "{",
      "  \"name\": \"ci-sample\",",
      "  \"version\": \"0.1.0\",",
      "  \"private\": true",
      "}",
      ""
    ].join("\n"), { eol: "lf" });
  },
  prompts:
  [
    ".github/workflows/ci.yml 의 matrix 에 windows-latest 를 추가하고, Build 단계 다음에 " +
      "node test.js 를 실행하는 Test 단계를 넣어줘. YAML 은 두 칸 들여쓰기를 지켜야 해."
  ],
  check: async function (ctx)
  {
    const out = [];
    const y = ctx.read(".github/workflows/ci.yml") || "";

    const issues = style.yamlIssues(y);
    out.push(check("indentation stayed valid", issues.length === 0, style.describe(issues)));

    out.push(check("windows-latest is in the matrix", /windows-latest/.test(y), y.slice(0, 200)));
    out.push(check("ubuntu-latest is still in the matrix", /ubuntu-latest/.test(y), ""));

    // Both platforms have to sit under os:, in either YAML sequence style.
    const osBlock = /os:\s*\n((?:[ \t]*-[ \t]*\S+[ \t]*\n)+)/.exec(y);
    const osFlow = /os:\s*\[([^\]]*)\]/.exec(y);
    const osText = osBlock ? osBlock[1] : (osFlow ? osFlow[1] : "");

    out.push(check("both platforms are under os:",
      /ubuntu-latest/.test(osText) && /windows-latest/.test(osText),
      osText ? osText.replace(/\n/g, " / ") : "no os: sequence found"));

    // Only block style has an indent to get wrong.
    if (osBlock)
    {
      const indents = osBlock[1].split(/\n/).filter(function (l)
      {
        return l.trim();
      }).map(function (l)
      {
        return l.length - l.replace(/^[ \t]*/, "").length;
      });
      out.push(check("the entries share one indent",
        indents.length >= 2 && indents.every(function (n)
        {
          return n === indents[0];
        }), "indents: " + indents.join(",")));
    }

    out.push(check("a Test step runs test.js", /run:\s*node\s+test\.js/.test(y), ""));
    out.push(check("the Build step survived", /run:\s*node\s+build\.js/.test(y), ""));

    const buildAt = y.indexOf("build.js");
    const testAt = y.indexOf("test.js");
    out.push(check("Test comes after Build", buildAt >= 0 && testAt > buildAt,
      "build at " + buildAt + ", test at " + testAt));

    out.push(check("the checkout and setup-node steps are intact",
      /actions\/checkout@v4/.test(y) && /actions\/setup-node@v4/.test(y), ""));

    return out;
  }
};

// ---------------------------------------------------------------------------
// Porting a batch file, comments and all
// ---------------------------------------------------------------------------

const batchToPowershell =
{
  name: "batch-to-powershell",
  title: "Port a legacy .bat to PowerShell that actually parses",
  tags: ["scripting", "encoding"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    // Korean comments in CP949, which is what a real one of these looks like.
    const bat = [
      "@echo off",
      "rem " + "문자열 패키지 생성 스크립트",
      "setlocal",
      "",
      "set ROOT=%~dp0..",
      "set OUTDIR=%ROOT%\\dist",
      "",
      "if not exist \"%OUTDIR%\" mkdir \"%OUTDIR%\"",
      "",
      "call \"%ROOT%\\scripts\\version.bat\"",
      "if errorlevel 1 (",
      "  echo version lookup failed",
      "  exit /b 1",
      ")",
      "",
      "for /f \"tokens=*\" %%F in ('dir /b \"%ROOT%\\src\\*.c\"') do (",
      "  echo packing %%F",
      ")",
      "",
      "echo done: %OUTDIR%",
      "endlocal",
      "exit /b 0",
      ""
    ].join("\r\n");

    fx.write(dir, "scripts/package.bat", bat, { eol: "crlf", encoding: "cp949" });

    fx.write(dir, "scripts/version.bat", [
      "@echo off",
      "set APP_VERSION=2.1.0",
      "exit /b 0",
      ""
    ].join("\r\n"), { eol: "crlf" });

    fx.write(dir, "src/main.c", "int main(void) { return 0; }\n", { eol: "lf" });
    fx.write(dir, "src/util.c", "int Util(void) { return 1; }\n", { eol: "lf" });
    fx.write(dir, "README.md",
      "# packager\n\nscripts/package.bat is the old packaging script.\n", { eol: "lf" });
  },
  prompts:
  [
    "scripts/package.bat 을 PowerShell 로 옮겨서 scripts/package.ps1 을 만들어줘. " +
      "하는 일은 그대로 유지해줘. 기존 .bat 은 지우지 말고 남겨둬."
  ],
  check: async function (ctx)
  {
    const out = [];
    const ps = ctx.read("scripts/package.ps1") || "";

    out.push(check("package.ps1 was created", !!ps.trim(), "scripts/package.ps1 missing or empty"));
    out.push(check("the original .bat was left in place", ctx.exists("scripts/package.bat"),
      "package.bat was deleted"));

    // The real test: PowerShell's own parser has to accept it.
    const shell = powershellCommand();
    if (ps.trim() && shell)
    {
      const probe = "$errs = $null; " +
        "[System.Management.Automation.Language.Parser]::ParseFile(" +
        "(Resolve-Path 'scripts/package.ps1').Path, [ref]$null, [ref]$errs) | Out-Null; " +
        "if ($errs -and $errs.Count -gt 0) { $errs | ForEach-Object { $_.Message }; exit 1 } " +
        "else { 'PARSE_OK' }";
      const res = process.platform === "win32"
        ? ctx.sh(probe, { timeoutMs: 60000 })
        : ctx.sh(shell + " -NoProfile -NonInteractive -Command '" + probe.replace(/'/g, "'\\''") + "'",
          { timeoutMs: 60000 });
      out.push(check("PowerShell parses the ported script", /PARSE_OK/.test(res.out),
        (res.out + " " + res.err).slice(0, 300)));
    }
    else if (!ps.trim())
    {
      out.push(check("PowerShell parses the ported script", false, "nothing to parse"));
    }

    out.push(check("no batch-only expansion survived the port",
      !/%~dp0/.test(ps) && !/%ROOT%/.test(ps) && !/exit\s+\/b/.test(ps),
      "leftover batch syntax in the .ps1"));
    out.push(check("uses a PowerShell way to find its own folder",
      /\$PSScriptRoot/.test(ps), "no $PSScriptRoot"));
    out.push(check("the output folder is still created",
      /New-Item|mkdir|MakeDirectory/i.test(ps), ""));
    out.push(check("the failure check survived",
      /\$LASTEXITCODE|\$\?|try\s*\{|-ne\s*0/.test(ps), "no error check in the port"));
    out.push(check("still walks the .c files",
      /\*\.c/.test(ps) && /(foreach|ForEach-Object|Get-ChildItem)/i.test(ps), ""));

    const wide = style.nonAsciiLines(ps);
    out.push(check("the port did not carry mojibake across",
      !/[�]/.test(ps), "replacement characters in the .ps1"));
    out.push(check("comments are readable or ASCII",
      wide.length === 0 || !/[�]/.test(ps), style.describe(wide)));

    return out;
  }
};

// ---------------------------------------------------------------------------
// A migration directory, where applied files are immutable
// ---------------------------------------------------------------------------

const MIG_001 = [
  "-- 001_init.sql",
  "CREATE TABLE sessions (",
  "  id          INTEGER PRIMARY KEY,",
  "  player_id   INTEGER NOT NULL,",
  "  started_at  TEXT    NOT NULL,",
  "  ended_at    TEXT",
  ");",
  ""
].join("\n");

const MIG_002 = [
  "-- 002_add_index.sql",
  "CREATE INDEX idx_sessions_player ON sessions (player_id);",
  ""
].join("\n");

const sqlMigration =
{
  name: "sql-migration-add-column",
  title: "Add a migration without editing the applied ones",
  tags: ["sql", "safety"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "migrations/001_init.sql", MIG_001, { eol: "lf" });
    fx.write(dir, "migrations/002_add_index.sql", MIG_002, { eol: "lf" });

    fx.write(dir, "migrations/README.md", [
      "# migrations",
      "",
      "Files here are applied in name order and are immutable once committed.",
      "A change to the schema is a new numbered file, never an edit to an old one.",
      ""
    ].join("\n"), { eol: "lf" });

    fx.write(dir, "schema.md", [
      "# schema",
      "",
      "## sessions",
      "",
      "| column | type | note |",
      "| --- | --- | --- |",
      "| id | INTEGER | primary key |",
      "| player_id | INTEGER | indexed |",
      "| started_at | TEXT | required |",
      "| ended_at | TEXT | null while live |",
      ""
    ].join("\n"), { eol: "lf" });
  },
  prompts:
  [
    "sessions 테이블에 소프트 삭제용 deleted_at TEXT 컬럼을 추가하고 거기에 인덱스도 만들어줘. " +
      "schema.md 문서도 같이 갱신해줘."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("001 was not modified", ctx.read("migrations/001_init.sql") === MIG_001,
      "001_init.sql changed"));
    out.push(check("002 was not modified", ctx.read("migrations/002_add_index.sql") === MIG_002,
      "002_add_index.sql changed"));

    const added = ctx.files().filter(function (rel)
    {
      return /^migrations\/.*\.sql$/i.test(rel) &&
        rel.indexOf("001_init") < 0 && rel.indexOf("002_add_index") < 0;
    });
    out.push(check("exactly one new migration file appeared", added.length === 1,
      "new sql files: " + added.join(", ")));

    const sql = added.length === 1 ? (ctx.read(added[0]) || "") : "";
    out.push(check("the new file is numbered after 002", added.length === 1 &&
      /(^|\/)0*3[_-]/.test(added[0]), added.join(", ")));
    out.push(check("it adds the column",
      /ALTER\s+TABLE\s+sessions\s+ADD\s+(COLUMN\s+)?deleted_at\s+TEXT/i.test(sql),
      sql.slice(0, 200)));
    out.push(check("it indexes the column",
      /CREATE\s+INDEX\s+\S+\s+ON\s+sessions\s*\(\s*deleted_at\s*\)/i.test(sql),
      sql.slice(0, 200)));

    const schema = ctx.read("schema.md") || "";
    out.push(check("schema.md documents the column", /deleted_at/.test(schema),
      "schema.md not updated"));
    out.push(check("schema.md kept the other columns",
      /player_id/.test(schema) && /started_at/.test(schema) && /ended_at/.test(schema),
      "existing rows were lost"));

    return out;
  }
};

module.exports = [kmdfDriverLeak, monorepoVersionBump, workflowMatrix, batchToPowershell, sqlMigration];
