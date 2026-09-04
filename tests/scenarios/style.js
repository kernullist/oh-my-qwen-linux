"use strict";

// House rules and project instructions.
//
// Both are shipped features. The settings pane has a coding-rules box, and
// src/agent.js drops its content into the system prompt under "House rules for
// the code you write", with the user's own project instructions appended last.
// Nothing ever measured whether the model obeys either one, so a rule that is
// silently ignored looks exactly like a rule that works.

const { check, needs, known } = require("../lib/check");
const style = require("../lib/style");

// The style the operator of this repo actually requires.
const HOUSE_STYLE = [
  "ASCII-only comments and log output.",
  "The opening brace { must be on the next line, never at the end of a statement.",
  "The closing brace } must be on its own line.",
  "Always use braces for if, else, for and while, even for a single statement.",
  "Never put executable code on the same line as a brace.",
  "else must be on its own line, followed by { on the next line.",
  "Indent with two spaces. Never use tabs."
].join("\n");

function styleChecks(label, text)
{
  const out = [];
  const brace = style.braceViolations(text);
  const bare = style.bracelessControls(text);
  const els = style.elseViolations(text);
  const wide = style.nonAsciiLines(text);
  const tabs = style.tabLines(text);

  out.push(check(label + ": opening brace on its own line", brace.length === 0, style.describe(brace)));
  out.push(check(label + ": every if/for/while has braces", bare.length === 0, style.describe(bare)));
  out.push(check(label + ": else alone on its line", els.length === 0, style.describe(els)));
  out.push(check(label + ": ASCII only", wide.length === 0, style.describe(wide)));
  out.push(check(label + ": no tab indentation", tabs.length === 0, style.describe(tabs)));

  return out;
}

// ---------------------------------------------------------------------------
// Writing new C code under an explicit house style
// ---------------------------------------------------------------------------

const RETRY_BODY = [
  "int RetryBudget(int attempts)",
  "{",
  "  int budget = attempts;",
  "  if (budget < 1)",
  "  {",
  "    budget = 1;",
  "  }",
  "  return budget;",
  "}"
].join("\n");

const houseStyleC =
{
  name: "house-style-c",
  title: "New C code obeys the configured house style",
  tags: ["prompt", "style"],
  config: { codingRules: HOUSE_STYLE },
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "src/retry.h", [
      "#pragma once",
      "",
      "int RetryBudget(int attempts);",
      ""
    ].join("\n"), { eol: "lf" });

    fx.write(dir, "src/retry.c", [
      "// Retry budget helpers. Kept deliberately small.",
      "#include \"retry.h\"",
      "",
      "int RetryBudget(int attempts)",
      "{",
      "  int budget = attempts;",
      "  if (budget < 1)",
      "  {",
      "    budget = 1;",
      "  }",
      "  return budget;",
      "}",
      ""
    ].join("\n"), { eol: "lf" });

    fx.write(dir, "README.md", "# retry\n\nPlain C, no build system yet.\n", { eol: "lf" });
  },
  prompts:
  [
    "src/retry.c 에 ClampRetry(int value, int lo, int hi) 함수를 추가해줘. value 가 lo 보다 작으면 lo, " +
      "hi 보다 크면 hi, 아니면 value 를 돌려주면 돼. src/retry.h 에도 선언을 추가해줘."
  ],
  check: async function (ctx)
  {
    const out = [];
    const c = ctx.read("src/retry.c") || "";
    const h = ctx.read("src/retry.h") || "";

    out.push(check("ClampRetry is defined in retry.c", /\bClampRetry\s*\(/.test(c), c.slice(0, 120)));
    out.push(check("ClampRetry is declared in retry.h", /\bClampRetry\s*\(/.test(h), h));
    out.push(check("the existing RetryBudget survived", /int\s+RetryBudget\s*\(/.test(c),
      "RetryBudget is gone from retry.c"));

    // Emphasising the rules must not turn "add a function" into "rewrite the
    // file". The old function already complied, so it should be untouched.
    out.push(check("the existing function was not reformatted",
      c.replace(/\r\n/g, "\n").indexOf(RETRY_BODY) >= 0,
      "RetryBudget's body was rewritten"));
    out.push(check("the original comment header survived",
      /Retry budget helpers/.test(c), "the file's first comment is gone"));

    const all = styleChecks("retry.c", c).concat(styleChecks("retry.h", h));
    for (let i = 0; i < all.length; i++)
    {
      out.push(all[i]);
    }

    return out;
  }
};

// ---------------------------------------------------------------------------
// The project-instructions slot, which sits last in the system prompt
// ---------------------------------------------------------------------------

const BANNER = "/* (c) internal - do not distribute */";

const projectInstructions =
{
  name: "project-instructions-banner",
  title: "Project instructions in the last prompt slot are obeyed",
  tags: ["prompt", "style"],
  config:
  {
    systemPrompt: "Every source file you create or modify must start with this exact first line:\n" +
      BANNER + "\n" +
      "Indent every source file with two spaces. Never use a tab for indentation."
  },
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    // No banner anywhere, and the existing file is indented with tabs, so
    // copying the surrounding style and following the instruction disagree.
    fx.write(dir, "src/util.c", [
      "#include \"util.h\"",
      "",
      "int Double(int v)",
      "{",
      "\treturn v * 2;",
      "}",
      ""
    ].join("\n"), { eol: "lf" });

    fx.write(dir, "src/util.h", [
      "#pragma once",
      "",
      "int Double(int v);",
      ""
    ].join("\n"), { eol: "lf" });

    // Without an entry point the build can only fail, which costs a round and
    // logs friction that says nothing about the app.
    fx.write(dir, "src/main.c", [
      "#include <stdio.h>",
      "#include \"util.h\"",
      "",
      "int main(void)",
      "{",
      "  printf(\"%d\\n\", Double(21));",
      "  return 0;",
      "}",
      ""
    ].join("\n"), { eol: "lf" });
  },
  prompts:
  [
    "src/util.c 에 Triple(int v) 함수를 추가하고 src/util.h 에도 선언해줘. " +
      "그리고 src/parse.c 를 새로 만들어서 ParseDigit(char c) 함수를 넣어줘. " +
      "숫자 문자면 그 숫자 값을, 아니면 -1 을 돌려주면 돼."
  ],
  check: async function (ctx)
  {
    const out = [];
    const util = ctx.read("src/util.c") || "";
    const header = ctx.read("src/util.h") || "";
    const parse = ctx.read("src/parse.c") || "";

    out.push(check("Triple was added to util.c", /\bTriple\s*\(/.test(util), util.slice(0, 120)));
    out.push(check("the existing Double was left working",
      /int\s+Double\s*\(\s*int\s+v\s*\)/.test(util) && /v\s*\*\s*2/.test(util),
      "Double was rewritten or removed"));
    out.push(check("Triple was declared in util.h", /\bTriple\s*\(/.test(header), header));
    out.push(check("parse.c was created", !!parse, "src/parse.c missing"));
    out.push(check("ParseDigit is in parse.c", /\bParseDigit\s*\(/.test(parse), parse.slice(0, 120)));

    const firstLine = function (text)
    {
      return String(text || "").split(/\r?\n/)[0].trim();
    };

    out.push(check("the banner is the first line of the modified file",
      firstLine(util) === BANNER, "util.c line 1: " + firstLine(util)));
    out.push(check("the banner is the first line of the new file",
      firstLine(parse) === BANNER, "parse.c line 1: " + firstLine(parse)));

    // Measured over ten runs: the banner rule, which asks for one literal line,
    // is followed every time. The indentation rule sits in the same instruction
    // block and is followed sometimes. A rule about how every line looks is not
    // the same kind of instruction as a rule that inserts a line, and no amount
    // of prompt scaffolding closed the gap. The app cannot check it either: the
    // rules are free text, so it has no way to know that this one was about tabs.
    const tabsInParse = style.tabLines(parse);
    out.push(known("the new file uses spaces, not tabs",
      tabsInParse.length === 0, style.describe(tabsInParse),
      "this model applies a formatting rule less reliably than a literal-insertion rule"));

    return out;
  }
};

// ---------------------------------------------------------------------------
// The default rules, unmodified, applied without being asked
// ---------------------------------------------------------------------------

const defaultRulesHygiene =
{
  name: "default-rules-test-hygiene",
  title: "A new test follows the shipped default rules unprompted",
  tags: ["prompt", "style"],
  requires: function ()
  {
    return needs([]);
  },
  setup: async function (dir, fx)
  {
    // Reports failures by printing and returning non-zero, and removes what it
    // wrote. Both are default rules, so the added case has a local precedent
    // as well as a prompt rule telling it what to do.
    fx.write(dir, "tests/test_parse.c", [
      "#include <stdio.h>",
      "#include <string.h>",
      "#include \"../src/parse.h\"",
      "",
      "static int CheckLine(void)",
      "{",
      "  FILE *f = fopen(\"parse_case.txt\", \"wb\");",
      "  if (f == NULL)",
      "  {",
      "    printf(\"FAIL CheckLine: cannot create parse_case.txt\\n\");",
      "    return 1;",
      "  }",
      "  fputs(\"key=value\\n\", f);",
      "  fclose(f);",
      "",
      "  char value[32];",
      "  int rc = ParseFile(\"parse_case.txt\", value, sizeof(value));",
      "  remove(\"parse_case.txt\");",
      "",
      "  if (rc != 0 || strcmp(value, \"value\") != 0)",
      "  {",
      "    printf(\"FAIL CheckLine: expected rc 0 and 'value', got rc %d and '%s'\\n\", rc, value);",
      "    return 1;",
      "  }",
      "  return 0;",
      "}",
      "",
      "int main(void)",
      "{",
      "  int bad = 0;",
      "  bad += CheckLine();",
      "  if (bad != 0)",
      "  {",
      "    printf(\"%d test(s) failed\\n\", bad);",
      "    return 1;",
      "  }",
      "  printf(\"all tests passed\\n\");",
      "  return 0;",
      "}",
      ""
    ].join("\n"), { eol: "lf" });

    fx.write(dir, "src/parse.h", [
      "#pragma once",
      "",
      "int ParseFile(const char *path, char *out, int outSize);",
      ""
    ].join("\n"), { eol: "lf" });

    fx.write(dir, "src/parse.c", [
      "#include <stdio.h>",
      "#include <string.h>",
      "#include \"parse.h\"",
      "",
      "int ParseFile(const char *path, char *out, int outSize)",
      "{",
      "  FILE *f = fopen(path, \"rb\");",
      "  if (f == NULL)",
      "  {",
      "    return -1;",
      "  }",
      "",
      "  char line[256];",
      "  if (fgets(line, sizeof(line), f) == NULL)",
      "  {",
      "    fclose(f);",
      "    out[0] = 0;",
      "    return -2;",
      "  }",
      "  fclose(f);",
      "",
      "  char *eq = strchr(line, '=');",
      "  if (eq == NULL)",
      "  {",
      "    out[0] = 0;",
      "    return -3;",
      "  }",
      "",
      "  char *value = eq + 1;",
      "  int n = (int)strlen(value);",
      "  while (n > 0 && (value[n - 1] == '\\n' || value[n - 1] == '\\r'))",
      "  {",
      "    n--;",
      "  }",
      "  if (n >= outSize)",
      "  {",
      "    n = outSize - 1;",
      "  }",
      "  memcpy(out, value, (size_t)n);",
      "  out[n] = 0;",
      "  return 0;",
      "}",
      ""
    ].join("\n"), { eol: "lf" });

    fx.write(dir, "README.md", "# parse\n\nBuild by hand: cl src/parse.c tests/test_parse.c\n", { eol: "lf" });
  },
  prompts:
  [
    "tests/test_parse.c 에 '=' 가 없는 한 줄을 넣었을 때 ParseFile 이 -3 을 돌려주는지 검사하는 " +
      "테스트 케이스를 추가해줘. main 에서도 호출되게 해줘."
  ],
  check: async function (ctx)
  {
    const out = [];
    const t = ctx.read("tests/test_parse.c") || "";

    const funcs = t.match(/^static\s+int\s+\w+\s*\(\s*void\s*\)/gm) || [];
    out.push(check("a second check function was added", funcs.length >= 2,
      "found " + funcs.length + ": " + funcs.join(", ")));

    const calls = t.match(/bad\s*\+=\s*\w+\s*\(/g) || [];
    out.push(check("main calls the new case", calls.length >= 2, "calls: " + calls.join(", ")));

    out.push(check("the new case exercises the missing '=' path", /-\s*3/.test(t),
      "no reference to the -3 return anywhere in the test"));

    // Neither of these was mentioned in the prompt. They are default rules.
    out.push(check("no assert() was introduced", !/\bassert\s*\(/.test(t),
      "assert appears in the test file"));
    out.push(check("assert.h was not included", !/include\s*<assert\.h>/.test(t), ""));

    const creates = (t.match(/fopen\s*\(\s*[^,]+,\s*"w/g) || []).length;
    const removes = (t.match(/\bremove\s*\(/g) || []).length;
    out.push(check("every file the test writes is removed again", removes >= creates,
      "fopen-for-write x" + creates + ", remove x" + removes));

    out.push(check("failures still report a non-zero exit", /return\s+1\s*;/.test(t), ""));

    return out;
  }
};

module.exports = [houseStyleC, projectInstructions, defaultRulesHygiene];
