"use strict";

// Agent loop: streams one assistant turn, runs the tool calls it asks for,
// feeds the results back, and repeats until the model stops calling tools.

const os = require("os");
const lmstudio = require("./lmstudio");
const tools = require("./tools");
const toolchain = require("./toolchain");
const project = require("./project");
const sessionStore = require("./session");

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

// Duplicate tool call handling: refuse at the third identical call, give up on
// the turn at the fifth.
const REPEAT_REFUSE_AT = 3;
const REPEAT_ABORT_AT = 5;

// Upper bound on one tool result. Taken from the tool layer so the two cannot
// drift apart.
const MAX_TOOL_RESULT_CHARS = tools.MAX_RESULT_CHARS;

function estimateTokens(text)
{
  // Rough mixed Korean/English estimate; only used for history trimming.
  return Math.ceil(String(text || "").length / 3.0);
}

function messageTokens(msg)
{
  let total = 8;
  total += estimateTokens(msg.content || "");
  if (Array.isArray(msg.tool_calls))
  {
    for (let i = 0; i < msg.tool_calls.length; i++)
    {
      const c = msg.tool_calls[i];
      total += estimateTokens(c.function && c.function.name) + estimateTokens(c.function && c.function.arguments) + 8;
    }
  }
  return total;
}

function buildSystemPrompt(cfg)
{
  const ws = cfg.workspace || "(not set)";
  const shell = "/bin/bash";
  const lines =
  [
    "You are oh-my-qwen, a hands-on software engineering agent running locally against a Qwen model in LM Studio.",
    "You work directly on the user's registered working folder through tools.",
    "",
    "Working folder: " + ws,
    "Host OS: " + os.type() + " " + os.release() + " (" + process.platform + "), shell for run_command: " + shell,
    "",
    "Operating rules:",
    "1. Every path argument is relative to the working folder. Paths outside it are rejected, so never pass absolute system paths.",
    "1b. run_command is not a way around rule 1. If a file tool refuses a path, the answer is that the file is out of scope, not that you should read it with Get-Content. Tell the user instead.",
    "2. Look before you touch: use list_dir, find_files, search_text and read_file to learn the real state of the project.",
    "3. Never invent file contents. Call read_file before edit_file, and make old_string match the file byte for byte including indentation.",
    "4. When the user asks for code or a document, actually create or modify the files with write_file / edit_file. Do not paste a whole file into chat as a substitute for writing it.",
    "4b. For the same change across many files use replace_in_files once. Never loop edit_file over dozens of files, and never do bulk edits through the shell: shell rewrites can change line endings, permissions, or encodings across the whole tree.",
    "5. Chain tool calls until the task is really done. Do not stop after only reading.",
    "5b. A request with several parts is finished only when every part is. Before your final reply, walk the request part by part and say what you did for each one. If a part is not done, do it instead of reporting.",
    "6. Build with build_project, run with run_project, test with test_project. They already know this project's build system. Use run_command only for things they do not cover (git, ad-hoc inspection, custom scripts).",
    "7. write_file, edit_file, create_dir, delete_path and run_command need the user's approval. If an approval is denied, stop that action and ask what to do instead.",
    "8. Keep chat replies short and concrete: what you inspected, what you changed, which files, what to do next. Do not dump entire files back into the chat.",
    "9. Reply in Korean by default. Keep code, identifiers, file paths and log strings in English.",
    "10. If a tool fails, read the error, fix the cause, and retry with a corrected call instead of repeating the same call.",
    "11. Never repeat a tool call that already failed with the same arguments. The runtime refuses duplicates and aborts the turn after a few of them.",
    "",
    "run_command notes (Bash):",
    "- Quote paths containing spaces, parentheses, wildcard characters, or a leading dash. Prefer single quotes for literal paths.",
    "- Redirect with 2>/dev/null only when the diagnostic is genuinely irrelevant; otherwise keep errors visible.",
    "- Use test, find, command -v, and grep/rg for inspection. Do not use PowerShell or cmd.exe syntax.",
    "- Chain dependent commands with && so a failed configure or build step stops the sequence."
  ];

  const chain = toolchain.promptLines();
  if (chain.length > 0)
  {
    lines.push("");
    lines.push("Build environment:");
    for (let i = 0; i < chain.length; i++)
    {
      lines.push(chain[i]);
    }
  }

  if (cfg.workspace)
  {
    const proj = project.promptLines(cfg.workspace);
    if (proj.length > 0)
    {
      lines.push("");
      lines.push("This project:");
      for (let i = 0; i < proj.length; i++)
      {
        lines.push(proj[i]);
      }
    }
  }

  if (cfg.codingRules && String(cfg.codingRules).trim())
  {
    lines.push("");
    lines.push("House rules for the code you write. They apply to every file you create AND to " +
      "every file you edit, including a file that did not follow them before:");
    const rules = String(cfg.codingRules).trim().split("\n");
    for (let i = 0; i < rules.length; i++)
    {
      const rule = rules[i].trim();
      if (rule)
      {
        lines.push(/^[-*\d]/.test(rule) ? rule : ("- " + rule));
      }
    }
  }

  if (cfg.systemPrompt && String(cfg.systemPrompt).trim())
  {
    lines.push("");
    lines.push("Additional project instructions from the user. They apply to everything you " +
      "produce, whether you create a file or edit one that already exists:");
    lines.push(String(cfg.systemPrompt).trim());
  }

  return lines.join("\n");
}

// Length of the note clipForContext inserts, so the shrink math can pay for it
// instead of overshooting the budget it was given.
const NOTE_CHARS = 180;

// Keeps both ends of an oversized message. The head carries what was asked for
// and the tail carries the verdict, and a build log is useless without either.
function clipForContext(text, maxChars)
{
  const s = String(text || "");
  if (s.length <= maxChars)
  {
    return s;
  }

  const head = Math.floor(maxChars * 0.55);
  const tail = Math.max(0, maxChars - head);
  return s.slice(0, head) +
    "\n... [" + (s.length - maxChars) + " chars dropped here to fit the conversation context. " +
    "Ask for a narrower slice if you need what was cut.] ...\n" +
    s.slice(s.length - tail);
}

// An assistant message that made tool calls and the tool results answering it
// are one unit. Keeping half of the pair leaves a dangling tool_call, which
// most chat templates render as a broken turn.
function groupBlocks(messages)
{
  const blocks = [];

  for (let i = 0; i < messages.length; i++)
  {
    const msg = messages[i];
    const last = blocks[blocks.length - 1];

    if (msg.role === "tool" && last && last.expectsTools)
    {
      last.messages.push(msg);
      continue;
    }

    blocks.push({
      expectsTools: msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0,
      messages: [msg]
    });
  }

  return blocks;
}

function blockTokens(block)
{
  let total = 0;
  for (let i = 0; i < block.messages.length; i++)
  {
    total += messageTokens(block.messages[i]);
  }
  return total;
}

// Shrinks the newest block so it fits on its own. Tool results are cut first
// because they are the bulk; the request that produced them is left alone.
function shrinkBlock(block, budgetTokens)
{
  const copies = block.messages.map(function (m)
  {
    return Object.assign({}, m);
  });

  const toolIndexes = [];
  let fixed = 0;

  for (let i = 0; i < copies.length; i++)
  {
    if (copies[i].role === "tool")
    {
      toolIndexes.push(i);
      fixed += messageTokens(Object.assign({}, copies[i], { content: "" }));
    }
    else
    {
      fixed += messageTokens(copies[i]);
    }
  }

  if (toolIndexes.length > 0)
  {
    const share = Math.max(200, Math.floor((budgetTokens - fixed) / toolIndexes.length));
    for (let i = 0; i < toolIndexes.length; i++)
    {
      const idx = toolIndexes[i];
      copies[idx].content = clipForContext(copies[idx].content, Math.max(300, share * 3 - NOTE_CHARS));
    }
  }

  // Still too big means the non-tool part is the problem, usually a pasted log.
  let total = 0;
  for (let i = 0; i < copies.length; i++)
  {
    total += messageTokens(copies[i]);
  }

  if (total > budgetTokens)
  {
    for (let i = 0; i < copies.length; i++)
    {
      if (copies[i].role !== "tool")
      {
        copies[i].content = clipForContext(copies[i].content, Math.max(600, Math.floor(budgetTokens * 3 / copies.length) - NOTE_CHARS));
      }
    }
  }

  return copies;
}

// Returns { messages, droppedBlocks, shrunk }. The caller needs to know when it
// had to cut, because a turn that silently loses its own tool output looks to
// the user like the model just went quiet.
function trimHistoryDetailed(messages, budgetTokens)
{
  const blocks = groupBlocks(messages);
  const kept = [];
  let used = 0;
  let firstKept = blocks.length;
  let shrunk = false;

  for (let i = blocks.length - 1; i >= 0; i--)
  {
    const cost = blockTokens(blocks[i]);

    if (used + cost > budgetTokens)
    {
      if (kept.length > 0)
      {
        break;
      }

      // The newest block does not fit by itself. Dropping it would send the
      // model an empty conversation, so cut it down instead.
      const shrunkMessages = shrinkBlock(blocks[i], budgetTokens);
      for (let j = shrunkMessages.length - 1; j >= 0; j--)
      {
        kept.unshift(shrunkMessages[j]);
      }
      firstKept = i;
      shrunk = true;
      break;
    }

    used += cost;
    for (let j = blocks[i].messages.length - 1; j >= 0; j--)
    {
      kept.unshift(blocks[i].messages[j]);
    }
    firstKept = i;
  }

  // Defensive: history that already starts on a tool result (an old session
  // trimmed mid-pair) would still confuse the template.
  while (kept.length > 0 && kept[0].role === "tool")
  {
    kept.shift();
  }

  // Sending nothing but the system prompt makes the model answer about nothing,
  // which is indistinguishable from a broken turn. Always carry the request.
  if (kept.length === 0 && messages.length > 0)
  {
    for (let i = messages.length - 1; i >= 0; i--)
    {
      if (messages[i].role === "user")
      {
        kept.push(Object.assign({}, messages[i],
        {
          content: clipForContext(messages[i].content, Math.max(600, budgetTokens * 3 - NOTE_CHARS))
        }));
        shrunk = true;
        break;
      }
    }
  }

  return { messages: kept, droppedBlocks: firstKept, shrunk: shrunk };
}

function trimHistory(messages, budgetTokens)
{
  return trimHistoryDetailed(messages, budgetTokens).messages;
}

// Tools that change files on disk. run_command is deliberately not here: it is
// how a check gets run, so counting it as a change would never let the turn end.
const FILE_CHANGING_TOOLS = new Set(["write_file", "edit_file", "replace_in_files", "create_dir", "delete_path"]);
const VERIFY_TOOLS = new Set(["build_project", "test_project", "run_project", "run_command"]);

// Never on the last rounds: there would be no budget left to act on the nudge,
// so it would only cost the user an extra request.
const MAX_VERIFY_NUDGES = 2;

function shouldAskForVerification(cfg, root, state, round)
{
  if (state.nudges >= MAX_VERIFY_NUDGES || state.changedAt <= state.verifiedAt || round >= cfg.maxToolRounds - 2)
  {
    return false;
  }

  // A second nudge is only fair if the first one actually made the model run
  // something. Otherwise it is the same reminder into the same void.
  if (state.nudges > 0 && state.verifiedAt <= state.lastNudgeAt)
  {
    return false;
  }

  const info = project.detect(root);
  if (!info)
  {
    return false;
  }

  // native-direct means no build system was found and a compiler command was invented
  // from the source list. A library folder with no main() fails that command for
  // reasons that have nothing to do with the change, and chasing it wastes the
  // rest of the turn. Only hold the model to a build the project really defines.
  if (info.kind === "native-direct")
  {
    return false;
  }

  const hasTest = !!(info.tasks.test && info.tasks.test.command);
  const hasBuild = !!(info.tasks.build && info.tasks.build.command);
  return hasTest || hasBuild;
}

// A turn that was cancelled or that failed can leave an assistant message whose
// tool_calls were never answered: the call is recorded before the tool runs, so
// stopping in between saves a request with no reply. LM Studio tolerates that,
// but a stricter OpenAI compatible server rejects it outright, and either way
// the next turn shows the model calls it made with no idea whether they ran.
function closeUnansweredToolCalls(messages, reason)
{
  const out = [];
  let inserted = 0;

  for (let i = 0; i < messages.length; i++)
  {
    out.push(messages[i]);

    const calls = messages[i].tool_calls || [];
    if (calls.length === 0)
    {
      continue;
    }

    // Only the tool messages directly following this one can answer it.
    const answered = new Set();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool")
    {
      answered.add(messages[j].tool_call_id);
      out.push(messages[j]);
      j++;
    }

    for (let k = 0; k < calls.length; k++)
    {
      if (!answered.has(calls[k].id))
      {
        out.push({
          role: "tool",
          tool_call_id: calls[k].id,
          name: calls[k].function ? calls[k].function.name : "tool",
          content: reason
        });
        inserted++;
      }
    }

    i = j - 1;
  }

  return { messages: out, inserted: inserted };
}

// The tool schema rides along with every single request and used to be
// invisible to this arithmetic. Measured: 8,412 characters of JSON, about 2,800
// tokens, against a 1,000 token slack that was meant to cover it. The app
// therefore believed it had 183% of the history room it really had, so trimming
// could not actually make a request smaller - a round computed a 3,173 token
// budget and went out at 5,332 - and a small-context model could be handed more
// than it holds while the settings screen showed the numbers as fine.
//
// Counting it takes real room away from history, so it was checked for a
// behavioural cost rather than assumed harmless: the three scenarios whose
// checks are about recalling earlier tool output scored 10 of 12 with the schema
// counted and 10 of 12 without, four runs each. The arithmetic is honest and
// the model does not notice.
let schemaTokensCache = 0;

function toolSchemaTokens()
{
  if (schemaTokensCache === 0)
  {
    schemaTokensCache = estimateTokens(JSON.stringify(tools.SPECS));
  }
  return schemaTokensCache;
}

// Tokens left for the conversation once the system prompt, the tool schema and
// the reply the model is about to write are paid for. The floor is deliberately
// small: a large fixed floor would happily send more than a 4k-context model
// can hold.
function historyBudget(cfg, systemPrompt, replyTokens)
{
  const reply = replyTokens > 0 ? replyTokens : cfg.maxTokens;
  const room = cfg.contextTokens - estimateTokens(systemPrompt) - toolSchemaTokens() - reply - 1000;
  return Math.max(1500, Math.min(room, cfg.contextTokens));
}

// What NOT to do when a reply comes back empty, kept here because the obvious
// move is the wrong one and someone will try it again.
//
// The obvious move: the reply ran out of room, so give it more room. That is
// what this used to do. Measuring it, same scenario, three context sizes:
//
//   ceiling 3072  ->  6,335 characters of reasoning, no answer
//   ceiling 3704  ->  5,298 characters of reasoning, no answer
//   ceiling 6144  -> 14,119 characters of reasoning, no answer
//   ceiling 6144  -> 15,791 characters of reasoning, no answer
//
// The ceiling is a target this model fills, not a limit it bumps into. Measured
// with the widening as the only difference, six runs each on binary-asset-guard:
//
//   widening on   mean 10,003 output tokens, 119s   (9581 .. 11156)
//   widening off  mean  7,724 output tokens, 103s   (6479 .. 9974)
//
// The on-arm minimum sits above the off-arm median; U = 4 against a critical 5
// for six and six, so p < 0.05. Three runs each had suggested a bigger gap than
// that and could not have shown it: within one arm the spread reaches 3,500
// tokens, so a three-run mean says nothing.
//
// The other obvious move, shrinking the request instead, was built and dropped:
// it changed nothing. At a 12,000 token budget the tool schema is about 2,800
// tokens and the system prompt about 1,745, so roughly 4,550 of a 5,300 token
// request is fixed cost and history is the last 780. There is nothing there to
// cut. Reducing the fixed cost is the only lever that would move this, and the
// schema descriptions are carrying guidance that measured well on its own.

// How much of a single tool result may reach the model. Fixed caps were the
// problem: 16k characters of build log is more than a 16k-context model can
// hold, and the trimmer then dropped the entire conversation to make room.
function resultCharBudget(historyTokens)
{
  return Math.max(2000, Math.min(MAX_TOOL_RESULT_CHARS, Math.floor(historyTokens * 3 * 0.45)));
}

// Text of the newest assistant message in the current turn, if any.
function lastAssistantText(messages)
{
  for (let i = messages.length - 1; i >= 0; i--)
  {
    if (messages[i].role === "assistant")
    {
      return String(messages[i].content || "").trim();
    }
    if (messages[i].role === "user")
    {
      return "";
    }
  }
  return "";
}

function safeParseArgs(raw)
{
  if (!raw || typeof raw !== "string")
  {
    return { ok: true, value: {} };
  }

  const text = raw.trim();
  if (text === "")
  {
    return { ok: true, value: {} };
  }

  try
  {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object")
    {
      return { ok: true, value: parsed };
    }
    return { ok: false, error: "arguments must be a JSON object" };
  }
  catch (err)
  {
    // Some templates double-encode the arguments string.
    try
    {
      const once = JSON.parse(JSON.parse(text));
      if (once && typeof once === "object")
      {
        return { ok: true, value: once };
      }
    }
    catch (err2)
    {
      // fall through
    }
    return { ok: false, error: "invalid JSON arguments: " + err.message };
  }
}

// Heuristic: does this JSON fragment stop in the middle of a value?
function looksTruncated(raw)
{
  const text = String(raw || "");
  if (text.trim() === "")
  {
    return false;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++)
  {
    const c = text[i];
    if (inString)
    {
      if (escaped)
      {
        escaped = false;
      }
      else if (c === "\\")
      {
        escaped = true;
      }
      else if (c === "\"")
      {
        inString = false;
      }
      continue;
    }

    if (c === "\"")
    {
      inString = true;
    }
    else if (c === "{" || c === "[")
    {
      depth++;
    }
    else if (c === "}" || c === "]")
    {
      depth--;
    }
  }

  return inString || depth > 0;
}

function approvalPreview(name, args)
{
  if (name === "write_file")
  {
    const content = String(args.content || "");
    const head = content.split(/\r?\n/).slice(0, 24).join("\n");
    return head + (content.split(/\r?\n/).length > 24 ? "\n..." : "");
  }
  if (name === "edit_file")
  {
    const before = String(args.old_string || "").split(/\r?\n/).slice(0, 12).join("\n");
    const after = String(args.new_string || "").split(/\r?\n/).slice(0, 12).join("\n");
    return "- " + before.split("\n").join("\n- ") + "\n+ " + after.split("\n").join("\n+ ");
  }
  if (name === "replace_in_files")
  {
    return "find:    " + JSON.stringify(String(args.find || "")) + "\n" +
      "replace: " + JSON.stringify(String(args.replace || "")) + "\n" +
      "scope:   " + (args.glob ? String(args.glob) : "all text files") +
      (args.path ? " under " + String(args.path) : "") +
      (args.regex ? "  (regex)" : "") +
      (args.dry_run ? "  (dry run)" : "");
  }
  if (name === "build_project" || name === "run_project" || name === "test_project")
  {
    const extra = String(args.extra_args || args.args || args.filter || "").trim();
    return name.replace("_project", "") + (extra ? " " + extra : " (detected project command)");
  }
  if (name === "run_command")
  {
    return String(args.command || "");
  }
  if (name === "delete_path")
  {
    return String(args.path || "") + (args.recursive ? " (recursive)" : "");
  }
  if (name === "create_dir")
  {
    return String(args.path || "");
  }
  return "";
}

function requestApproval(session, emit, info)
{
  return new Promise(function (resolve)
  {
    let settled = false;

    const timer = setTimeout(function ()
    {
      if (settled)
      {
        return;
      }
      settled = true;
      session.pending.delete(info.id);
      emit("approval_resolved", { id: info.id, approved: false, reason: "timeout" });
      resolve({ approved: false, timedOut: true });
    }, APPROVAL_TIMEOUT_MS);

    session.pending.set(info.id, {
      info: info,
      resolve: function (payload)
      {
        if (settled)
        {
          return;
        }
        settled = true;
        clearTimeout(timer);
        session.pending.delete(info.id);
        resolve(payload || { approved: false });
      }
    });

    emit("approval_request", info);
  });
}

// ctx = { session, cfg, userText, emit }
async function runTurn(ctx)
{
  const session = ctx.session;
  const cfg = ctx.cfg;
  const emit = ctx.emit;
  const root = cfg.workspace;

  if (session.busy)
  {
    emit("error", { message: "이미 진행 중인 작업이 있습니다. 잠시 후 다시 시도해 주세요." });
    return;
  }
  if (!cfg.model)
  {
    emit("error", { message: "설정에서 모델을 먼저 선택해 주세요." });
    return;
  }
  if (!root)
  {
    emit("error", { message: "상단의 폴더 버튼으로 작업 폴더를 먼저 등록해 주세요." });
    return;
  }

  session.busy = true;
  session.abort = new AbortController();

  // If the room is cleared (or reset) mid-turn, everything this turn still has
  // to say belongs to the old room and must be dropped.
  const myEpoch = session.epoch;
  const stale = function ()
  {
    return session.epoch !== myEpoch;
  };
  const emitLive = function (name, data)
  {
    if (!stale())
    {
      emit(name, data);
    }
  };
  const push = function (item)
  {
    session.pushTranscript(item, myEpoch);
  };

  const userItem =
  {
    id: session.nextId("u"),
    kind: "user",
    text: ctx.userText,
    at: new Date().toISOString()
  };
  session.messages.push({ role: "user", content: ctx.userText });
  push(userItem);
  emitLive("user_message", userItem);

  // Rebuilt whenever a tool changes the folder layout. Building it once meant a
  // project the model created during this very turn stayed invisible: it was
  // still told "no build system was detected" right after writing CMakeLists.txt.
  let systemPrompt = buildSystemPrompt(cfg);
  let layoutChanged = false;
  let stopReason = "stop";

  // Turn-scoped duplicate-call tracking.
  const repeatCounts = new Map();
  let loopAborted = false;

  // Everything the turn actually executed. The closing summary is grounded in
  // this, so an empty turn cannot be summarised as "I created the file".
  const performed = [];

  // Kept outside the loop so a cancelled turn can still persist what streamed in.
  let activeId = null;
  let activeContent = "";
  let activeReasoning = "";
  let warnedShrink = false;

  // Monotonic counters, not timestamps: all that matters is whether a build or
  // test came after the last file change.
  let clock = 0;
  const verifyState = { changedAt: 0, verifiedAt: 0, nudges: 0, lastNudgeAt: 0 };
  let emptyNudges = 0;

  // Bulk changes previewed with dry_run whose real counterpart never ran.
  const previewedOnly = new Map();
  let previewNudges = 0;

  try
  {
    for (let round = 0; round < cfg.maxToolRounds; round++)
    {
      if (layoutChanged)
      {
        layoutChanged = false;
        systemPrompt = buildSystemPrompt(cfg);
      }

      const replyTokens = cfg.maxTokens;
      const budget = historyBudget(cfg, systemPrompt, replyTokens);
      const trimmed = trimHistoryDetailed(session.messages, budget);
      const history = trimmed.messages;
      const request = [{ role: "system", content: systemPrompt }].concat(history);

      // A turn whose own tool output does not fit used to end with the model
      // answering about nothing at all, with no hint as to why.
      if (trimmed.shrunk && !warnedShrink)
      {
        warnedShrink = true;
        const shrinkNotice =
        {
          id: session.nextId("n"),
          kind: "notice",
          level: "warn",
          text: "도구 결과가 대화 컨텍스트 예산(" + cfg.contextTokens + " 토큰)에 담기지 않아 가운데를 잘라서 모델에 전달했습니다. " +
            "설정에서 예산을 늘리거나(LM Studio에 로드된 컨텍스트보다는 작게 유지), 더 좁은 범위로 나눠서 요청해 주세요.",
          at: new Date().toISOString()
        };
        push(shrinkNotice);
        emitLive("notice", shrinkNotice);
      }

      const messageId = session.nextId("a");
      activeId = messageId;
      activeContent = "";
      activeReasoning = "";
      emitLive("assistant_start", { id: messageId, round: round + 1 });

      const result = await lmstudio.streamChat(
      {
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        messages: request,
        tools: tools.SPECS,
        temperature: cfg.temperature,
        maxTokens: replyTokens,
        idleTimeoutMs: cfg.idleTimeoutSec * 1000,
        firstByteTimeoutMs: cfg.firstByteTimeoutSec * 1000,
        signal: session.abort.signal
      },
      function (ev)
      {
        if (ev.type === "reasoning")
        {
          activeReasoning += ev.text;
          emitLive("reasoning_delta", { id: messageId, text: ev.text });
        }
        else
        {
          activeContent += ev.text;
          emitLive("content_delta", { id: messageId, text: ev.text });
        }
      });

      activeId = null;

      const assistantMessage = { role: "assistant", content: result.content || "" };
      if (result.toolCalls.length > 0)
      {
        assistantMessage.tool_calls = result.toolCalls;
      }
      session.messages.push(assistantMessage);

      const assistantItem =
      {
        id: messageId,
        kind: "assistant",
        text: result.content || "",
        reasoning: result.reasoning || "",
        at: new Date().toISOString(),
        usage: result.usage || null,
        toolCallCount: result.toolCalls.length
      };
      push(assistantItem);
      emitLive("assistant_end", assistantItem);

      // A reply that ran into max_tokens stops mid-sentence but otherwise looks
      // like a finished answer, so the reader has no way to tell it is partial.
      const emptyReply = !String(result.content || "").trim();

      if (result.finishReason === "length" && result.toolCalls.length === 0)
      {
        const cutItem =
        {
          id: session.nextId("n"),
          kind: "notice",
          level: "warn",
          text: emptyReply
            // All of the budget went into the thinking block, so the room would
            // otherwise show a finished-looking turn with nothing in it. Raising
            // the limit is deliberately not suggested here: measured on this
            // model, a bigger ceiling produced proportionally more reasoning and
            // still no answer.
            ? "모델이 '응답 최대 토큰'(" + replyTokens + ")을 생각 과정에만 다 써서 답변이 비어 있습니다. " +
              "요청을 더 작은 단계로 나눠 주세요. 한도를 올리는 것은 이 모델에서는 도움이 되지 않았습니다. " +
              "'생각 과정 표시'는 화면 표시만 바꾸므로 토큰 소모에는 영향이 없습니다."
            : "응답이 '응답 최대 토큰'(" + replyTokens + ") 한도에 걸려 도중에 잘렸습니다. " +
              "위 내용은 완결된 답변이 아닙니다. 설정에서 한도를 늘리거나 더 좁은 범위로 다시 질문해 주세요.",
          at: new Date().toISOString()
        };
        push(cutItem);
        emitLive("notice", cutItem);
      }

      if (result.toolCalls.length === 0)
      {
        // An empty reply is not the model deciding it is finished, it is the
        // round falling over. Ask once for a concrete next step before the turn
        // collapses into a summary of work that was never done.
        if (emptyReply && emptyNudges < 1 && round < cfg.maxToolRounds - 2)
        {
          emptyNudges++;

          // Ran out of room rather than choosing to stop. The retry gets the
          // same ceiling on purpose: see the note above retryReplyTokens's
          // replacement for what widening it actually did.
          const ranOut = result.finishReason === "length";

          session.messages.push({
            role: "user",
            content: "[runtime] Your last reply was empty" +
              (ranOut ? " because it ran into the response token limit" : "") + ". " +
              "Do not reason it through again. Either take the next concrete action for the request with a tool call, " +
              "or answer the user directly in two or three sentences."
          });

          const retryItem =
          {
            id: session.nextId("n"),
            kind: "notice",
            level: "info",
            text: "모델이 빈 응답을 반환해서 다음 단계를 한 번 더 요청했습니다." +
              (ranOut
                ? " 응답 공간은 그대로 둡니다. 늘려 보니 이 모델은 늘어난 만큼 더 생각하는 데 쓰고 " +
                  "답변은 다시 비었습니다."
                : ""),
            at: new Date().toISOString()
          };
          push(retryItem);
          emitLive("notice", retryItem);
          continue;
        }

        // A dry run reports what *would* change, which reads almost exactly
        // like a result. Ending the turn on one means the work was described
        // and never done.
        if (previewedOnly.size > 0 && previewNudges < 1 && round < cfg.maxToolRounds - 2)
        {
          previewNudges++;
          const pending = Array.from(previewedOnly.values());

          session.messages.push({
            role: "user",
            content: "[runtime] You ran replace_in_files with dry_run and never ran it for real, so nothing " +
              "changed on disk:\n" + pending.map(function (label)
              {
                return "  " + label;
              }).join("\n") +
              "\nA dry run only reports what would happen. Run the same call without dry_run if that is what you " +
              "want, or say why you decided against it. Do not describe the preview as a completed change."
          });

          const previewItem =
          {
            id: session.nextId("n"),
            kind: "notice",
            level: "warn",
            text: "dry_run 으로 미리보기만 하고 실제 치환을 실행하지 않아서, 적용 여부를 다시 물었습니다.",
            at: new Date().toISOString()
          };
          push(previewItem);
          emitLive("notice", previewItem);
          continue;
        }

        // Local models routinely edit a file and stop there, then report that
        // the fix is done. If this project can be built or tested and nothing
        // was run since the last edit, send them back once to check.
        if (shouldAskForVerification(cfg, root, verifyState, round))
        {
          verifyState.nudges++;
          verifyState.lastNudgeAt = verifyState.verifiedAt;

          const info = project.detect(root);
          const what = info && info.tasks.test && info.tasks.test.command ? "test_project" : "build_project";

          session.messages.push({
            role: "user",
            content: "[runtime] You changed files in this turn and then stopped without running anything. " +
              "Call " + what + " now and read what it reports. Fix what your own change broke. " +
              "If it fails for a reason that was already there before your change, say so and stop " +
              "rather than trying to repair the whole project. " +
              "Do not tell the user the change works until you have seen it pass."
          });

          const nudge =
          {
            id: session.nextId("n"),
            kind: "notice",
            level: "info",
            text: "파일을 수정한 뒤 " + (what === "test_project" ? "테스트를" : "빌드를") + " 실행하지 않아서, 검증을 한 번 더 요청했습니다.",
            at: new Date().toISOString()
          };
          push(nudge);
          emitLive("notice", nudge);
          continue;
        }

        stopReason = "stop";
        break;
      }

      let denied = false;

      for (let i = 0; i < result.toolCalls.length; i++)
      {
        const call = result.toolCalls[i];
        const name = call.function.name;
        const parsed = safeParseArgs(call.function.arguments);

        if (!parsed.ok)
        {
          // Unparsable arguments are usually a response cut off at max_tokens
          // rather than a malformed call, so say so instead of just "bad JSON".
          let detail = parsed.error;
          if (looksTruncated(call.function.arguments))
          {
            detail += "\nThe arguments end mid-value, which means this response hit the " + cfg.maxTokens +
              " token limit. Write the file in smaller pieces: create it with a first chunk, then append the rest " +
              "with follow-up edit_file calls. Tell the user to raise the response token limit in settings if you need one big write.";
          }

          const failItem =
          {
            id: session.nextId("t"),
            kind: "tool",
            callId: call.id,
            name: name,
            label: "",
            ok: false,
            summary: looksTruncated(call.function.arguments) ? "응답이 잘려 인자가 불완전합니다" : "arguments parse error",
            text: detail,
            at: new Date().toISOString()
          };
          session.messages.push({ role: "tool", tool_call_id: call.id, name: name, content: detail });
          push(failItem);
          emitLive("tool_result", failItem);

          if (looksTruncated(call.function.arguments))
          {
            const hint =
            {
              id: session.nextId("n"),
              kind: "notice",
              level: "warn",
              text: "모델 응답이 최대 토큰(" + cfg.maxTokens + ")에 걸려 도구 인자가 잘렸습니다. 설정에서 '응답 최대 토큰'을 늘리거나, 파일을 나눠서 작성하도록 요청해 주세요.",
              at: new Date().toISOString()
            };
            push(hint);
            emitLive("notice", hint);
          }
          continue;
        }

        const args = parsed.value;
        const label = tools.describeCall(name, args);

        // Local models can lock onto a failing call and repeat it forever,
        // burning the round budget and (worse) spamming approval prompts.
        // Refuse the duplicate instead of running it again.
        const signature = name + " " + JSON.stringify(args);
        const seen = (repeatCounts.get(signature) || 0) + 1;
        repeatCounts.set(signature, seen);

        if (seen >= REPEAT_REFUSE_AT)
        {
          const note = "This exact call was already made " + (seen - 1) + " time(s) in this turn and the result will not change. " +
            "Do not repeat it. Either try a materially different approach, or stop and tell the user what you need.";

          session.messages.push({ role: "tool", tool_call_id: call.id, name: name, content: note });

          const loopItem =
          {
            id: session.nextId("t"),
            kind: "tool",
            callId: call.id,
            name: name,
            label: label,
            ok: false,
            summary: "같은 호출 반복 " + seen + "회, 실행하지 않음",
            text: note,
            at: new Date().toISOString()
          };
          push(loopItem);
          emitLive("tool_result", loopItem);

          if (seen >= REPEAT_ABORT_AT)
          {
            loopAborted = true;
          }
          continue;
        }

        // run_command is the one tool that can step outside the working folder,
        // so a command reaching outside still gets a card even on auto-approve.
        // Auto-approve means "I trust you inside my folder", not "anywhere".
        const reaching = name === "run_command" ? tools.outsidePaths(root, args.command) : [];
        // A binary rewrite through the shell is the one in-folder edit the file
        // tools refuse outright, so it raises a card even under auto-approve.
        const binaryTargets = name === "run_command" ? tools.binaryWrites(root, args.command) : [];
        const needsApproval = tools.isMutating(name) &&
          (!cfg.autoApprove || reaching.length > 0 || binaryTargets.length > 0);

        function announceCall()
        {
          const callItem =
          {
            id: session.nextId("c"),
            kind: "tool_call",
            callId: call.id,
            name: name,
            label: label,
            args: args,
            at: new Date().toISOString()
          };
          push(callItem);
          emitLive("tool_call", callItem);
        }

        // Without approval the card can appear right away; with approval it must
        // come after the verdict so the room reads in chronological order.
        if (!needsApproval)
        {
          announceCall();
        }

        if (needsApproval)
        {
          const info =
          {
            id: session.nextId("ap"),
            callId: call.id,
            name: name,
            label: label,
            preview: approvalPreview(name, args),
            outsidePaths: reaching,
            binaryWrites: binaryTargets,
            at: new Date().toISOString()
          };

          const verdict = await requestApproval(session, emitLive, info);

          if (!verdict.approved)
          {
            const reason = verdict.cancelled
              ? "User cancelled the turn."
              : (verdict.timedOut ? "Approval request timed out." : "User denied this action.");

            // The name and the target were sitting right here and only ever
            // reached the approval card. What went to the model was "User
            // denied this action", with no way to tell which action when
            // several had run, and an instruction to ask how to proceed that
            // never said to mention the block. So the turn ended with the
            // refusal invisible: the check that fails here is literally "the
            // user is told something was blocked".
            const blocked = name + (label ? " " + String(label).slice(0, 120) : "");
            const note = reason + " The blocked action was: " + blocked + ". " +
              "Do not retry it. Name that action in your reply, say what is now unfinished because of it, " +
              "and do not describe it as done.";

            session.messages.push({ role: "tool", tool_call_id: call.id, name: name, content: note });

            const deniedItem =
            {
              id: session.nextId("t"),
              kind: "tool",
              callId: call.id,
              name: name,
              label: label,
              ok: false,
              summary: verdict.cancelled ? "취소됨" : "거부됨",
              text: note,
              at: new Date().toISOString()
            };
            push(deniedItem);
            emitLive("tool_result", deniedItem);

            if (verdict.cancelled)
            {
              throw Object.assign(new Error("cancelled"), { cancelled: true });
            }
            denied = true;
            continue;
          }

          emitLive("approval_resolved", { id: info.id, approved: true });
          announceCall();
        }

        const execResult = await tools.execute(root, name, args, session.abort ? session.abort.signal : undefined,
          { maxChars: resultCharBudget(budget) });

        // A tool that was killed by the user ends the turn; continuing would
        // feed the model a half-finished result it never asked to abandon.
        if (execResult.cancelled)
        {
          session.messages.push({ role: "tool", tool_call_id: call.id, name: name, content: "The user cancelled this action." });
          throw Object.assign(new Error("cancelled"), { cancelled: true });
        }

        // A successful mutation changes the workspace, so re-running an earlier
        // read to verify the result is legitimate, not a stuck loop.
        if (execResult.ok && tools.isMutating(name))
        {
          repeatCounts.clear();
          repeatCounts.set(signature, 1);
        }

        // Creating or removing files can turn an empty folder into a CMake or
        // Go project, which changes what the model is allowed to assume. A shell
        // command only counts while nothing is detected yet: re-scanning the
        // tree after every git or test command would cost more than it buys.
        if (execResult.ok && (name === "write_file" || name === "create_dir" || name === "delete_path" ||
          (name === "run_command" && !project.detect(root))))
        {
          layoutChanged = true;
        }

        clock++;

        // A dry run changes nothing, so it must not satisfy "you edited files".
        const wasDryRun = name === "replace_in_files" && args.dry_run === true;

        if (execResult.ok && FILE_CHANGING_TOOLS.has(name) && !wasDryRun)
        {
          verifyState.changedAt = clock;
        }

        // Previewing a bulk change and never applying it is this model's
        // favourite way to finish: the preview reads like a result.
        if (execResult.ok && name === "replace_in_files")
        {
          const signature = JSON.stringify(
          {
            find: args.find,
            replace: args.replace,
            path: args.path || "",
            glob: args.glob || "",
            regex: !!args.regex
          });

          if (wasDryRun)
          {
            previewedOnly.set(signature, tools.describeCall(name, args));
          }
          else
          {
            previewedOnly.delete(signature);
          }
        }
        if (VERIFY_TOOLS.has(name))
        {
          verifyState.verifiedAt = clock;
        }

        performed.push((execResult.ok ? "ok   " : "fail ") + name + " " + (label || "") +
          (execResult.summary ? " -> " + execResult.summary : ""));

        session.messages.push({ role: "tool", tool_call_id: call.id, name: name, content: execResult.text });

        const resultItem =
        {
          id: session.nextId("t"),
          kind: "tool",
          callId: call.id,
          name: name,
          label: label,
          ok: execResult.ok,
          summary: execResult.summary,
          text: execResult.text,
          at: new Date().toISOString()
        };
        push(resultItem);
        emitLive("tool_result", resultItem);
      }

      // Tell the model how much budget is left so it wraps up the actual task
      // instead of being cut off mid-exploration.
      const roundsLeft = cfg.maxToolRounds - 1 - round;
      const warnAt = Math.max(2, Math.round(cfg.maxToolRounds * 0.2));
      if (roundsLeft > 0 && roundsLeft <= warnAt)
      {
        const last = session.messages[session.messages.length - 1];
        if (last && last.role === "tool")
        {
          last.content += "\n\n[runtime] Only " + roundsLeft + " tool round(s) left in this turn. " +
            "Stop exploring, finish the parts of the request that are still missing, and then answer the user.";
        }
      }

      if (loopAborted)
      {
        stopReason = "loop";
        const notice =
        {
          id: session.nextId("n"),
          kind: "notice",
          level: "warn",
          text: "같은 도구 호출이 " + REPEAT_ABORT_AT + "회 반복되어 턴을 중단했습니다. 요청을 더 구체적으로 나눠서 다시 시도해 주세요.",
          at: new Date().toISOString()
        };
        push(notice);
        emitLive("notice", notice);
        break;
      }

      if (denied)
      {
        // Let the model see the denial and answer, then finish.
        continue;
      }

      if (round === cfg.maxToolRounds - 1)
      {
        stopReason = "max_rounds";
        const notice =
        {
          id: session.nextId("n"),
          kind: "notice",
          level: "warn",
          text: "도구 호출 한도(" + cfg.maxToolRounds + "회)에 도달해서 턴을 종료했습니다. 이어서 진행하려면 계속 요청해 주세요.",
          at: new Date().toISOString()
        };
        push(notice);
        emitLive("notice", notice);
      }
    }

    // A turn that ends on tool calls alone leaves the room silent, which reads
    // as "nothing happened". Ask for a closing summary with tools disabled.
    if (!lastAssistantText(session.messages) && performed.length === 0)
    {
      // Nothing ran and nothing was said. Asking for a summary here is exactly
      // how a model ends up reporting work it never did.
      stopReason = stopReason === "stop" ? "empty" : stopReason;

      const item =
      {
        id: session.nextId("n"),
        kind: "notice",
        level: "warn",
        text: "모델이 도구를 실행하지 않고 빈 응답을 반환했습니다. 아무 파일도 변경되지 않았습니다. " +
          "요청을 더 작게 나누거나 설정에서 '응답 최대 토큰'을 늘린 뒤 다시 시도해 주세요.",
        at: new Date().toISOString()
      };
      push(item);
      emitLive("notice", item);
    }
    else if (!lastAssistantText(session.messages))
    {
      const facts = "Tool calls that actually executed in this turn:\n" + performed.join("\n") + "\n";
      const ask = stopReason === "stop"
        ? facts + "Tell the user in Korean what those calls accomplished, based only on that list. " +
          "Never say a file was created or changed unless the list shows it. Do not call any tool."
        : facts + "You were cut off (" + stopReason + ") before finishing. The user's request was:\n\"" + ctx.userText + "\"\n" +
          "Go through that request item by item and tell the user in Korean which parts the list above proves you completed, " +
          "and which parts are still not done. Do not claim anything works unless the list shows it. Do not call any tool.";

      const messageId = session.nextId("a");
      activeId = messageId;
      activeContent = "";
      activeReasoning = "";
      emitLive("assistant_start", { id: messageId, round: 0 });

      const budget = historyBudget(cfg, systemPrompt);
      const request = [{ role: "system", content: systemPrompt }]
        .concat(trimHistory(session.messages, budget))
        .concat([{ role: "user", content: ask }]);

      const wrap = await lmstudio.streamChat(
      {
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        messages: request,
        temperature: cfg.temperature,
        maxTokens: Math.min(2048, cfg.maxTokens),
        idleTimeoutMs: cfg.idleTimeoutSec * 1000,
        firstByteTimeoutMs: cfg.firstByteTimeoutSec * 1000,
        signal: session.abort.signal
      },
      function (ev)
      {
        if (ev.type === "reasoning")
        {
          activeReasoning += ev.text;
          emitLive("reasoning_delta", { id: messageId, text: ev.text });
        }
        else
        {
          activeContent += ev.text;
          emitLive("content_delta", { id: messageId, text: ev.text });
        }
      });

      activeId = null;

      if (wrap.content && wrap.content.trim())
      {
        session.messages.push({ role: "assistant", content: wrap.content });
      }

      const wrapItem =
      {
        id: messageId,
        kind: "assistant",
        text: wrap.content || "",
        reasoning: wrap.reasoning || "",
        at: new Date().toISOString(),
        usage: wrap.usage || null,
        toolCallCount: 0
      };
      push(wrapItem);
      emitLive("assistant_end", wrapItem);

      // The summary turn can spend its whole budget on reasoning and still say
      // nothing. The tool results are real, so list them from what actually ran
      // instead of leaving the room blank with no explanation.
      if (!wrap.content || !wrap.content.trim())
      {
        const shown = performed.slice(0, 20);
        const hidden = performed.length - shown.length;

        const fallback =
        {
          id: session.nextId("n"),
          kind: "notice",
          level: "warn",
          text: "모델이 생각 과정에만 응답 토큰을 다 쓰고 설명을 내놓지 못했습니다. " +
            "실제로 실행된 도구는 다음과 같으며, 결과는 위 도구 카드에서 확인할 수 있습니다.\n" +
            shown.map(function (line)
            {
              return "- " + line;
            }).join("\n") +
            (hidden > 0 ? ("\n- 그 외 " + hidden + "건") : "") +
            "\n설정에서 '응답 최대 토큰'을 올리거나 요청을 더 작게 나누면 개선됩니다.",
          at: new Date().toISOString()
        };
        push(fallback);
        emitLive("notice", fallback);
      }
    }
  }
  catch (err)
  {
    // A rejected fetch can surface as a DOMException, an Error or a bare string.
    const detail = (err && err.message) ? String(err.message) : String(err);
    const aborted = !!(err && (err.cancelled || err.name === "AbortError")) || /abort|cancel/i.test(detail);
    stopReason = aborted ? "cancelled" : "error";

    // Keep whatever already streamed so a long answer is not lost on cancel.
    if (activeId && (activeContent.trim() || activeReasoning.trim()))
    {
      if (activeContent.trim())
      {
        session.messages.push({ role: "assistant", content: activeContent });
      }

      const partialItem =
      {
        id: activeId,
        kind: "assistant",
        text: activeContent,
        reasoning: activeReasoning,
        at: new Date().toISOString(),
        usage: null,
        toolCallCount: 0,
        partial: true
      };
      push(partialItem);
      emitLive("assistant_end", partialItem);
    }
    activeId = null;

    const item =
    {
      id: session.nextId("n"),
      kind: "notice",
      level: aborted ? "info" : "error",
      text: aborted ? "요청을 중단했습니다." : ("오류: " + detail),
      at: new Date().toISOString()
    };
    push(item);
    emitLive("notice", item);
  }
  finally
  {
    session.busy = false;
    session.abort = null;
    session.pending.clear();

    // Close the contract before anything is saved or the next turn reads it.
    const closed = closeUnansweredToolCalls(session.messages,
      "This call did not run: the turn ended first (cancelled, or it failed). " +
      "Nothing was read, written or executed by it. Do not assume it had any effect.");

    if (closed.inserted > 0)
    {
      session.messages = closed.messages;
    }

    sessionStore.persistSoon(session);
    emitLive("turn_end", { stopReason: stopReason });
  }
}

module.exports =
{
  runTurn: runTurn,
  // Exported so the settings screen can stop being optimistic by exactly the
  // amount the tool schema costs.
  toolSchemaTokens: toolSchemaTokens,
  buildSystemPrompt: buildSystemPrompt,
  trimHistory: trimHistory,
  estimateTokens: estimateTokens,
  // Exported for the regression tests: a cancelled turn used to save an
  // assistant message whose tool_calls were never answered.
  closeUnansweredToolCalls: closeUnansweredToolCalls
};
