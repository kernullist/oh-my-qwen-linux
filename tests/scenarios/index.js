"use strict";

// Scenario registry. Each module exports an array of scenario objects:
//
//   {
//     name, title, tags,
//     requires()        -> "" to run, or a reason string to skip
//     setup(dir, fx)    -> writes the throwaway project
//     prompts           -> one user message per turn
//     approve(info)     -> optional, decides an approval card (default: yes)
//     config            -> optional per-scenario config overrides
//     check(ctx)        -> array of { label, ok, detail }
//   }

const groups =
[
  require("./cpp"),
  require("./scripting"),
  require("./encoding"),
  require("./scale"),
  require("./workflow"),
  require("./windows"),
  require("./more"),
  require("./realworld"),
  require("./maintenance"),
  require("./style"),
  require("./diverse")
];

function all()
{
  const out = [];
  const seen = new Set();

  for (let i = 0; i < groups.length; i++)
  {
    for (let j = 0; j < groups[i].length; j++)
    {
      const s = groups[i][j];
      if (seen.has(s.name))
      {
        throw new Error("duplicate scenario name: " + s.name);
      }
      seen.add(s.name);
      out.push(s);
    }
  }

  return out;
}

module.exports = { all: all };
