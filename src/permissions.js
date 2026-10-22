"use strict";

// Permission modes: how much the agent may do before it stops to ask.
//
//   ask    every action that changes the machine shows an approval card
//   edits  file edits inside the working folder run on their own; deleting,
//          commands, build, run and test still ask
//   auto   everything inside the working folder runs on its own; a command
//          that reaches outside it, or rewrites a binary through the shell,
//          still asks
//   full   nothing asks. The file tools still refuse paths outside the
//          folder, but run_command is not held back at all
//
// "auto" is what the old autoApprove checkbox did, so a saved autoApprove:
// true becomes "auto".

const MODES = ["ask", "edits", "auto", "full"];

// Tools that only change files inside the working folder through the file
// tools' own sandbox. delete_path is left out: losing a tree is the one file
// change that cannot be read back and fixed.
const EDIT_TOOLS = new Set(["write_file", "edit_file", "replace_in_files", "create_dir"]);

function isMode(value)
{
  return MODES.indexOf(value) >= 0;
}

// The mode a config asks for, accepting the pre-mode autoApprove flag.
function modeOf(cfg)
{
  if (cfg && isMode(cfg.permissionMode))
  {
    return cfg.permissionMode;
  }
  return cfg && cfg.autoApprove === true ? "auto" : "ask";
}

// risk = { mutating, outsidePaths, binaryWrites }, as the agent computed it
// for one call. Read-only tools never ask, whatever the mode.
function needsApproval(mode, name, risk)
{
  const r = risk || {};
  if (!r.mutating)
  {
    return false;
  }

  const outside = (r.outsidePaths && r.outsidePaths.length > 0) || (r.binaryWrites && r.binaryWrites.length > 0);

  if (mode === "full")
  {
    return false;
  }
  if (mode === "auto")
  {
    return !!outside;
  }
  if (mode === "edits")
  {
    return !EDIT_TOOLS.has(name) || !!outside;
  }
  return true;
}

module.exports =
{
  MODES: MODES,
  isMode: isMode,
  modeOf: modeOf,
  needsApproval: needsApproval
};
