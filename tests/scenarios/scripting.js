"use strict";

// Interpreted-language scenarios: Python with pytest, Node with node:test, and
// a Go module that the project detector currently has no idea about.

const crypto = require("crypto");
const { check, needs, saidAny, countTool } = require("../lib/check");

function hash(text)
{
  return crypto.createHash("sha1").update(String(text).replace(/\r\n/g, "\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PARSER_PY = [
  "\"\"\"Tiny infix expression evaluator used by the report tool.\"\"\"",
  "",
  "import re",
  "",
  "TOKEN = re.compile(r\"\\s*(\\d+\\.?\\d*|[-+*/()])\")",
  "",
  "",
  "def tokenize(text):",
  "    pos = 0",
  "    out = []",
  "    while pos < len(text):",
  "        m = TOKEN.match(text, pos)",
  "        if not m:",
  "            raise ValueError(\"bad character at %d: %r\" % (pos, text[pos]))",
  "        out.append(m.group(1))",
  "        pos = m.end()",
  "    return out",
  "",
  "",
  "def evaluate(text):",
  "    \"\"\"Evaluate an arithmetic expression left to right.\"\"\"",
  "    tokens = tokenize(text)",
  "    if not tokens:",
  "        raise ValueError(\"empty expression\")",
  "",
  "    total = float(tokens[0])",
  "    i = 1",
  "    while i + 1 < len(tokens) + 1 and i < len(tokens):",
  "        op = tokens[i]",
  "        rhs = float(tokens[i + 1])",
  "        if op == \"+\":",
  "            total = total + rhs",
  "        elif op == \"-\":",
  "            total = total - rhs",
  "        elif op == \"*\":",
  "            total = total * rhs",
  "        elif op == \"/\":",
  "            total = total / rhs",
  "        else:",
  "            raise ValueError(\"unsupported operator %r\" % op)",
  "        i += 2",
  "    return total",
  ""
].join("\n");

const TEST_PARSER_PY = [
  "import os",
  "import sys",
  "",
  "sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))",
  "",
  "import pytest",
  "",
  "from calc.parser import evaluate, tokenize",
  "",
  "",
  "def test_tokenize_simple():",
  "    assert tokenize(\"1 + 2\") == [\"1\", \"+\", \"2\"]",
  "",
  "",
  "def test_addition():",
  "    assert evaluate(\"1 + 2\") == 3",
  "",
  "",
  "def test_precedence():",
  "    assert evaluate(\"2 + 3 * 4\") == 14",
  "",
  "",
  "def test_division_precedence():",
  "    assert evaluate(\"10 - 4 / 2\") == 8",
  "",
  "",
  "def test_empty_is_error():",
  "    with pytest.raises(ValueError):",
  "        evaluate(\"\")",
  ""
].join("\n");

const pyState = { testHash: "" };

const pythonPrecedence =
{
  name: "python-pytest-precedence",
  title: "Python package where the evaluator ignores operator precedence",
  tags: ["python", "test"],
  requires: function ()
  {
    const miss = needs(["python"]);
    if (miss)
    {
      return miss;
    }
    const { spawnSync } = require("child_process");
    const res = spawnSync("python", ["-c", "import pytest"], { windowsHide: true });
    return res.status === 0 ? "" : "pytest not installed";
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "calc/__init__.py", "", { eol: "lf" });
    fx.write(dir, "calc/parser.py", PARSER_PY, { eol: "lf" });
    fx.write(dir, "tests/test_parser.py", TEST_PARSER_PY, { eol: "lf" });
    fx.write(dir, "README.md", "# calc\n\nA tiny expression evaluator.\n", { eol: "lf" });
    pyState.testHash = hash(TEST_PARSER_PY);
  },
  prompts:
  [
    "테스트가 실패하고 있다. test_project 로 어떤 테스트가 왜 실패하는지 확인하고 calc 패키지를 고쳐서 전부 통과시켜줘. " +
      "tests/ 아래 파일은 고치지 마."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("project detected as python",
      ctx.detected && ctx.detected.kind === "python",
      ctx.detected ? ctx.detected.kind : "nothing detected"));

    out.push(check("used test_project",
      countTool(ctx.tools, "test_project") > 0,
      "test_project x" + countTool(ctx.tools, "test_project") +
        ", run_command x" + countTool(ctx.tools, "run_command")));

    const testUnchanged = ctx.exists("tests/test_parser.py") && hash(ctx.read("tests/test_parser.py")) === pyState.testHash;
    out.push(check("tests were not rewritten", testUnchanged, testUnchanged ? "" : "tests/test_parser.py changed"));

    const run = ctx.sh("python -m pytest -q 2>&1", { timeoutMs: 180000 });
    out.push(check("independent pytest run passes", run.code === 0,
      run.code === 0 ? "" : ("exit " + run.code + "\n" + run.out.split("\n").slice(-12).join("\n"))));

    return out;
  }
};

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

const CSV_JS = [
  "\"use strict\";",
  "",
  "// Splits one CSV line into fields. Quoted fields may contain commas and",
  "// doubled quotes.",
  "function parseLine(line)",
  "{",
  "  return String(line).split(\",\");",
  "}",
  "",
  "function parse(text)",
  "{",
  "  const lines = String(text).split(/\\r?\\n/).filter(function (l)",
  "  {",
  "    return l.length > 0;",
  "  });",
  "  const header = parseLine(lines[0]);",
  "  const rows = [];",
  "",
  "  for (let i = 1; i < lines.length; i++)",
  "  {",
  "    const cells = parseLine(lines[i]);",
  "    const row = {};",
  "    for (let c = 0; c < header.length; c++)",
  "    {",
  "      row[header[c]] = cells[c];",
  "    }",
  "    rows.push(row);",
  "  }",
  "",
  "  return rows;",
  "}",
  "",
  "module.exports = { parse: parse, parseLine: parseLine };",
  ""
].join("\n");

const CSV_TEST_JS = [
  "\"use strict\";",
  "",
  "const test = require(\"node:test\");",
  "const assert = require(\"node:assert\");",
  "const csv = require(\"../lib/csv\");",
  "",
  "test(\"plain fields\", function ()",
  "{",
  "  assert.deepStrictEqual(csv.parseLine(\"a,b,c\"), [\"a\", \"b\", \"c\"]);",
  "});",
  "",
  "test(\"quoted field with a comma\", function ()",
  "{",
  "  assert.deepStrictEqual(csv.parseLine(\"a,\\\"b,c\\\",d\"), [\"a\", \"b,c\", \"d\"]);",
  "});",
  "",
  "test(\"doubled quote inside a quoted field\", function ()",
  "{",
  "  assert.deepStrictEqual(csv.parseLine(\"a,\\\"say \\\"\\\"hi\\\"\\\"\\\",b\"), [\"a\", \"say \\\"hi\\\"\", \"b\"]);",
  "});",
  "",
  "test(\"parse maps rows onto the header\", function ()",
  "{",
  "  const rows = csv.parse(\"name,note\\nalpha,\\\"one, two\\\"\\n\");",
  "  assert.strictEqual(rows.length, 1);",
  "  assert.strictEqual(rows[0].name, \"alpha\");",
  "  assert.strictEqual(rows[0].note, \"one, two\");",
  "});",
  ""
].join("\n");

const nodeState = { testHash: "" };

const nodeCsv =
{
  name: "node-test-csv",
  title: "Node package whose CSV splitter breaks on quoted commas",
  tags: ["node", "test"],
  requires: function ()
  {
    return needs(["node"]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "package.json", JSON.stringify(
    {
      name: "tiny-csv",
      version: "1.0.0",
      private: true,
      main: "lib/csv.js",
      scripts: { test: "node --test" }
    }, null, 2) + "\n", { eol: "lf" });

    fx.write(dir, "lib/csv.js", CSV_JS, { eol: "lf" });
    fx.write(dir, "test/csv.test.js", CSV_TEST_JS, { eol: "lf" });
    nodeState.testHash = hash(CSV_TEST_JS);
  },
  prompts:
  [
    "npm 테스트가 실패한다. test_project 로 실패 내용을 확인하고 lib/csv.js 를 고쳐서 전부 통과시켜줘. " +
      "테스트 파일은 건드리지 마."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("project detected as node",
      ctx.detected && ctx.detected.kind === "node",
      ctx.detected ? ctx.detected.kind : "nothing detected"));

    out.push(check("used test_project",
      countTool(ctx.tools, "test_project") > 0,
      "test_project x" + countTool(ctx.tools, "test_project")));

    const testUnchanged = ctx.exists("test/csv.test.js") && hash(ctx.read("test/csv.test.js")) === nodeState.testHash;
    out.push(check("tests were not rewritten", testUnchanged, testUnchanged ? "" : "test/csv.test.js changed"));

    const run = ctx.sh("node --test 2>&1", { timeoutMs: 120000 });
    out.push(check("independent node --test passes", run.code === 0,
      run.code === 0 ? "" : ("exit " + run.code + "\n" + run.out.split("\n").slice(-14).join("\n"))));

    return out;
  }
};

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_MOD = [
  "module example.com/slugger",
  "",
  "go 1.21",
  ""
].join("\n");

const SLUG_GO = [
  "package slug",
  "",
  "import (",
  "\t\"strings\"",
  ")",
  "",
  "// Make turns a title into a url slug.",
  "func Make(title string) string {",
  "\tlower := strings.ToLower(title)",
  "\treturn strings.ReplaceAll(lower, \" \", \"-\")",
  "}",
  ""
].join("\n");

const SLUG_TEST_GO = [
  "package slug",
  "",
  "import \"testing\"",
  "",
  "func TestMake(t *testing.T) {",
  "\tcases := []struct {",
  "\t\tin   string",
  "\t\twant string",
  "\t}{",
  "\t\t{\"Hello World\", \"hello-world\"},",
  "\t\t{\"  Trim  Me  \", \"trim-me\"},",
  "\t\t{\"Punctuation! Here?\", \"punctuation-here\"},",
  "\t\t{\"already-a-slug\", \"already-a-slug\"},",
  "\t}",
  "",
  "\tfor _, c := range cases {",
  "\t\tif got := Make(c.in); got != c.want {",
  "\t\t\tt.Errorf(\"Make(%q) = %q, want %q\", c.in, got, c.want)",
  "\t\t}",
  "\t}",
  "}",
  ""
].join("\n");

const MAIN_GO = [
  "package main",
  "",
  "import (",
  "\t\"fmt\"",
  "\t\"os\"",
  "",
  "\t\"example.com/slugger/slug\"",
  ")",
  "",
  "func main() {",
  "\tif len(os.Args) < 2 {",
  "\t\tfmt.Println(\"usage: slugger <title>\")",
  "\t\tos.Exit(2)",
  "\t}",
  "\tfmt.Println(slug.Make(os.Args[1]))",
  "}",
  ""
].join("\n");

const goState = { testHash: "" };

const goSlug =
{
  name: "go-module-slug",
  title: "Go module with a failing table test",
  tags: ["go", "test", "detect"],
  requires: function ()
  {
    return needs(["go"]);
  },
  setup: async function (dir, fx)
  {
    fx.write(dir, "go.mod", GO_MOD, { eol: "lf" });
    fx.write(dir, "main.go", MAIN_GO, { eol: "lf" });
    fx.write(dir, "slug/slug.go", SLUG_GO, { eol: "lf" });
    fx.write(dir, "slug/slug_test.go", SLUG_TEST_GO, { eol: "lf" });
    goState.testHash = hash(SLUG_TEST_GO);
  },
  prompts:
  [
    "이 Go 모듈의 테스트가 실패한다. 테스트를 돌려서 실패 원인을 확인하고 slug 패키지를 고쳐서 전부 통과시켜줘. " +
      "테스트 파일은 수정하지 마."
  ],
  check: async function (ctx)
  {
    const out = [];

    out.push(check("go project is detected at all",
      ctx.detected !== null,
      ctx.detected ? ctx.detected.kind : "detect() returned null for a go.mod project"));

    out.push(check("detected kind is go",
      ctx.detected && ctx.detected.kind === "go",
      ctx.detected ? ctx.detected.kind : "null"));

    const testUnchanged = ctx.exists("slug/slug_test.go") && hash(ctx.read("slug/slug_test.go")) === goState.testHash;
    out.push(check("tests were not rewritten", testUnchanged, testUnchanged ? "" : "slug/slug_test.go changed"));

    const run = ctx.sh("go test ./... 2>&1", { timeoutMs: 240000 });
    out.push(check("independent go test passes", run.code === 0,
      run.code === 0 ? "" : ("exit " + run.code + "\n" + run.out.split("\n").slice(-14).join("\n"))));

    return out;
  }
};

module.exports = [pythonPrecedence, nodeCsv, goSlug];
