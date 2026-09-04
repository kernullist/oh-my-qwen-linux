"use strict";

// Style checkers for the house-rules scenarios.
//
// The coding rules are a shipped feature: the settings pane has a box for them
// and src/agent.js injects them into the system prompt. Nothing ever checked
// whether the model obeys them, so these give the scenarios a mechanical
// answer. They run on real generated C, so they have to leave ordinary code
// alone: initializer lists, braces inside strings and comments, conditions
// split over several lines.

// Blanks out comments and string literals so a brace inside either one does
// not read as code. Rough on purpose - it only has to stop false positives.
function stripNoise(line)
{
  let out = "";
  let i = 0;
  const s = String(line);

  while (i < s.length)
  {
    const two = s.slice(i, i + 2);

    if (two === "//")
    {
      break;
    }
    if (two === "/*")
    {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (s[i] === "\"" || s[i] === "'")
    {
      const quote = s[i];
      i++;
      while (i < s.length && s[i] !== quote)
      {
        i += s[i] === "\\" ? 2 : 1;
      }
      i++;
      out += " ";
      continue;
    }

    out += s[i];
    i++;
  }

  // A regex quantifier is not a block. Only JavaScript sources hit this, but
  // the checkers are pointed at this repo's own code as a canary and a false
  // positive there is indistinguishable from a real one.
  return out.replace(/\{\s*\d+\s*(,\s*\d*)?\s*\}/g, " ");
}

function lines(text)
{
  return String(text === undefined || text === null ? "" : text).split(/\r?\n/);
}

const CONTROL = /^\s*(\}\s*)?(else\b|if\b|for\b|while\b|switch\b|do\b)/;

// "Opening brace on the next line" and "else on its own line". Deliberately
// narrow: it fires on a control statement that carries a brace, and on a
// declaration whose brace sits at the end of the signature. Anything else
// that mentions a brace is left alone, because an object literal, a compound
// literal and a brace initializer are not brace style violations and guessing
// at them invents failures in correct code.
const SIGNATURE = /\)\s*(const\s*)?\{\s*$/;
const DECL = /(struct|union|enum|class|namespace)[^;]*\{\s*$/;

// True when a control statement's line carries the brace that opens its body.
// Only a brace after the condition's closing parenthesis counts: a brace
// inside the condition belongs to an expression, not to the block.
function opensBlock(code)
{
  let depth = 0;
  let closed = false;

  for (let i = 0; i < code.length; i++)
  {
    const ch = code[i];
    if (ch === "(")
    {
      depth++;
      continue;
    }
    if (ch === ")")
    {
      depth--;
      if (depth <= 0)
      {
        closed = true;
      }
      continue;
    }
    if (ch === "{" && depth <= 0 && (closed || !/\(/.test(code)))
    {
      return true;
    }
  }

  return false;
}

function braceViolations(text)
{
  const out = [];
  const all = lines(text);

  for (let i = 0; i < all.length; i++)
  {
    const code = stripNoise(all[i]);
    if (code.indexOf("{") < 0)
    {
      continue;
    }
    if (/^\s*\{\s*$/.test(code))
    {
      continue;
    }

    if (CONTROL.test(code))
    {
      if (opensBlock(code))
      {
        out.push({ line: i + 1, text: all[i].trim(), why: "brace shares the line with a control statement" });
      }
      continue;
    }

    if (/=\s*\{/.test(code))
    {
      continue;
    }

    if (SIGNATURE.test(code) || DECL.test(code))
    {
      out.push({ line: i + 1, text: all[i].trim(), why: "brace shares the line with a declaration" });
    }
  }

  return out;
}

// "Always use braces for if, else, for and while." A condition split over
// several lines is skipped: its parentheses do not balance on the first line,
// so there is nothing to judge yet.
function bracelessControls(text)
{
  const out = [];
  const all = lines(text);

  for (let i = 0; i < all.length; i++)
  {
    const code = stripNoise(all[i]);

    if (!/^\s*(if|for|while)\s*\(/.test(code))
    {
      continue;
    }
    if (code.indexOf("{") >= 0)
    {
      continue;
    }

    const opens = (code.match(/\(/g) || []).length;
    const closes = (code.match(/\)/g) || []).length;
    if (opens !== closes)
    {
      continue;
    }

    // The tail of do { ... } while (0); is not a braceless loop. It is the
    // single-exit pattern the house rules ask for.
    if (/^\s*while\s*\(/.test(code))
    {
      let back = i - 1;
      while (back >= 0 && !stripNoise(all[back]).trim())
      {
        back--;
      }
      if (back >= 0 && /\}\s*$/.test(stripNoise(all[back])))
      {
        continue;
      }
    }

    if (/;\s*$/.test(code))
    {
      out.push({ line: i + 1, text: all[i].trim(), why: "body on the same line without braces" });
      continue;
    }

    let j = i + 1;
    while (j < all.length && !stripNoise(all[j]).trim())
    {
      j++;
    }
    if (j < all.length && !/^\s*\{/.test(stripNoise(all[j])))
    {
      out.push({ line: i + 1, text: all[i].trim(), why: "next line is not an opening brace" });
    }
  }

  return out;
}

// "else must be on its own line."
function elseViolations(text)
{
  const out = [];
  const all = lines(text);

  for (let i = 0; i < all.length; i++)
  {
    const code = stripNoise(all[i]).trim();
    if (!/\belse\b/.test(code))
    {
      continue;
    }
    if (/^else$/.test(code) || /^else\s+if\s*\(/.test(code))
    {
      continue;
    }
    out.push({ line: i + 1, text: all[i].trim(), why: "else is not alone on its line" });
  }

  return out;
}

function nonAsciiLines(text)
{
  const out = [];
  const all = lines(text);

  for (let i = 0; i < all.length; i++)
  {
    if (/[^\x00-\x7F]/.test(all[i]))
    {
      out.push({ line: i + 1, text: all[i].trim(), why: "non-ASCII character" });
    }
  }

  return out;
}

function tabLines(text)
{
  const out = [];
  const all = lines(text);

  for (let i = 0; i < all.length; i++)
  {
    if (/^[ ]*\t/.test(all[i]))
    {
      out.push({ line: i + 1, text: all[i].trim(), why: "tab used for indentation" });
    }
  }

  return out;
}

// Only the two things that are never right in a YAML file written to a
// two-space convention: a tab in the indentation, and an odd indent. Anything
// cleverer would invent failures in valid YAML.
function yamlIssues(text)
{
  const out = [];
  const all = lines(text);

  for (let i = 0; i < all.length; i++)
  {
    const line = all[i];
    if (!line.trim() || /^\s*#/.test(line))
    {
      continue;
    }
    if (/^[ ]*\t/.test(line))
    {
      out.push({ line: i + 1, text: line.trim(), why: "tab in YAML indentation" });
      continue;
    }
    const indent = line.length - line.replace(/^[ ]*/, "").length;
    if (indent % 2 !== 0)
    {
      out.push({ line: i + 1, text: line.trim(), why: "indent of " + indent + " is not a multiple of two" });
    }
  }

  return out;
}

function describe(list)
{
  return list.slice(0, 4).map(function (v)
  {
    return "L" + v.line + " " + v.why + ": " + v.text.slice(0, 60);
  }).join(" | ");
}

module.exports =
{
  stripNoise: stripNoise,
  braceViolations: braceViolations,
  bracelessControls: bracelessControls,
  elseViolations: elseViolations,
  nonAsciiLines: nonAsciiLines,
  tabLines: tabLines,
  yamlIssues: yamlIssues,
  describe: describe
};
