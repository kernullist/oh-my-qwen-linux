"use strict";

// One chat room per working folder. Keeps the raw OpenAI message array used for
// requests and a UI transcript used to repaint the room after a reload.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");

const MAX_TRANSCRIPT_ITEMS = 600;
const MAX_MESSAGES = 400;
// Tool output is the bulk of a transcript and the model already has it in full,
// so the saved copy is an excerpt. What the user and the model said is the
// conversation itself: clipping it at 4,000 characters meant a long answer came
// back cut in half after a restart, or even after a page reload.
const MAX_TOOL_TEXT = 4000;
const MAX_CHAT_TEXT = 200000;
const MAX_REASONING_TEXT = 20000;

function sessionsDir()
{
  return path.join(config.appDir(), "sessions");
}

function keyFor(workspace)
{
  const resolved = path.resolve(workspace || "no-workspace");
  const norm = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = crypto.createHash("sha1").update(norm).digest("hex").slice(0, 12);
  const base = path.basename(norm).replace(/[^a-z0-9._-]/gi, "_").slice(0, 40) || "ws";
  return base + "-" + hash;
}

function fileFor(workspace)
{
  return path.join(sessionsDir(), keyFor(workspace) + ".json");
}

class Session
{
  constructor(workspace)
  {
    this.workspace = workspace || "";
    this.messages = [];
    this.transcript = [];
    this.pending = new Map();
    this.busy = false;
    this.abort = null;
    this.seq = 1;
    // Bumped by reset(): a turn that was cancelled by "clear" must not write
    // its trailing notices into the freshly emptied room.
    this.epoch = 1;
    // Real prompt tokens per estimated token, learned from LM Studio's usage
    // reports. 0 until the first round has been measured.
    this.tokenRatio = 0;
    // Change counters rather than a dirty flag: a save in flight when the
    // process exits has not landed, so "a save started" must not count as
    // saved. The exit flush writes whenever saved lags behind changes.
    this.changes = 0;
    this.saved = 0;
  }

  markChanged()
  {
    this.changes++;
  }

  nextId(prefix)
  {
    const id = (prefix || "id") + "_" + Date.now().toString(36) + "_" + (this.seq++);
    return id;
  }

  pushTranscript(item, epoch)
  {
    if (epoch !== undefined && epoch !== this.epoch)
    {
      return;
    }

    const chat = item && (item.kind === "user" || item.kind === "assistant");
    const limit = chat ? MAX_CHAT_TEXT : MAX_TOOL_TEXT;
    if (item && typeof item.text === "string" && item.text.length > limit)
    {
      const dropped = item.text.length - limit;
      item = Object.assign({}, item,
      {
        text: item.text.slice(0, limit) + "\n... [" + dropped + " chars trimmed from the saved log]"
      });
    }
    if (item && typeof item.reasoning === "string" && item.reasoning.length > MAX_REASONING_TEXT)
    {
      item = Object.assign({}, item,
      {
        reasoning: item.reasoning.slice(0, MAX_REASONING_TEXT) + "\n... [" +
          (item.reasoning.length - MAX_REASONING_TEXT) + " chars of reasoning trimmed from the saved log]"
      });
    }

    this.markChanged();

    this.transcript.push(item);
    if (this.transcript.length > MAX_TRANSCRIPT_ITEMS)
    {
      this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT_ITEMS);
    }
  }

  // Caps stored history without splitting an assistant tool_calls / tool pair.
  trimMessages()
  {
    if (this.messages.length <= MAX_MESSAGES)
    {
      return;
    }

    this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    while (this.messages.length > 0 && this.messages[0].role === "tool")
    {
      this.messages.shift();
    }
  }

  reset()
  {
    this.epoch++;
    this.cancel("reset");
    this.messages = [];
    this.transcript = [];
    this.pending.clear();
    this.markChanged();
  }

  cancel(reason)
  {
    if (this.abort)
    {
      try
      {
        // No reason argument: a string reason would be thrown verbatim by fetch
        // instead of the AbortError the agent loop expects.
        this.abort.abort();
      }
      catch (err)
      {
        // already aborted
      }
    }

    const ids = Array.from(this.pending.keys());
    for (let i = 0; i < ids.length; i++)
    {
      const entry = this.pending.get(ids[i]);
      this.pending.delete(ids[i]);
      if (entry && typeof entry.resolve === "function")
      {
        entry.resolve({ approved: false, cancelled: true });
      }
    }
  }

  toJSON()
  {
    return {
      workspace: this.workspace,
      messages: this.messages,
      transcript: this.transcript,
      savedAt: new Date().toISOString()
    };
  }
}

const store = new Map();

// A room saved in the middle of a turn - the app was killed, or shut down while
// a command ran - holds tool calls that never got an answer, and tool cards that
// would spin as "running" forever. Close both so the reloaded room reads as an
// interrupted turn rather than a live one.
function repairInterrupted(session)
{
  const answered = new Set();
  for (let i = 0; i < session.messages.length; i++)
  {
    if (session.messages[i].role === "tool")
    {
      answered.add(session.messages[i].tool_call_id);
    }
  }

  const repaired = [];
  let interrupted = false;
  for (let i = 0; i < session.messages.length; i++)
  {
    repaired.push(session.messages[i]);
    const calls = session.messages[i].tool_calls || [];
    for (let j = 0; j < calls.length; j++)
    {
      if (!answered.has(calls[j].id))
      {
        interrupted = true;
        repaired.push({
          role: "tool",
          tool_call_id: calls[j].id,
          name: calls[j].function ? calls[j].function.name : "tool",
          content: "This call did not finish: the app stopped while it was running. Its effect is unknown; " +
            "check the files before relying on it."
        });
      }
    }
  }
  session.messages = repaired;

  const results = new Set();
  for (let i = 0; i < session.transcript.length; i++)
  {
    if (session.transcript[i].kind === "tool")
    {
      results.add(session.transcript[i].callId);
    }
  }
  const at = new Date().toISOString();
  const open = session.transcript.filter(function (item)
  {
    return item.kind === "tool_call" && !results.has(item.callId);
  });
  for (let i = 0; i < open.length; i++)
  {
    session.transcript.push({
      id: "t_restored_" + i, kind: "tool", callId: open[i].callId, name: open[i].name, label: open[i].label,
      ok: false, summary: "중단됨", text: "앱이 종료되어 이 작업이 끝나지 않았습니다.", at: at
    });
  }

  if (interrupted || open.length > 0)
  {
    session.transcript.push({
      id: "n_restored", kind: "notice", level: "warn",
      text: "앱이 종료될 때 진행 중이던 작업이 있었습니다. 마지막 작업은 끝나지 않았을 수 있으니 결과를 확인해 주세요.",
      at: at
    });
    session.markChanged();
  }
}

function get(workspace)
{
  const key = keyFor(workspace);
  if (store.has(key))
  {
    return store.get(key);
  }

  const session = new Session(workspace);
  const file = fileFor(workspace);
  let text = null;
  try
  {
    text = fs.readFileSync(file, "utf8");
  }
  catch (err)
  {
    // fresh room
  }

  if (text !== null)
  {
    try
    {
      const raw = JSON.parse(text);
      if (raw && Array.isArray(raw.messages))
      {
        session.messages = raw.messages;
      }
      if (raw && Array.isArray(raw.transcript))
      {
        session.transcript = raw.transcript;
      }
      repairInterrupted(session);
    }
    catch (err)
    {
      // An unreadable file used to become an empty room in silence, and the
      // next save overwrote it, so the history was gone for good. Keep it.
      const aside = file.replace(/\.json$/, "") + ".corrupt-" + Date.now() + ".json";
      try
      {
        fs.renameSync(file, aside);
      }
      catch (e)
      {
        // left where it is; it will not be read again either way
      }
      console.error("[session] could not read " + file + ": " + err.message + "; kept as " + aside);
      session.markChanged();
      session.transcript.push({
        id: "n_corrupt", kind: "notice", level: "error",
        text: "저장된 대화 파일을 읽을 수 없어 새 대화로 시작합니다. 원본은 " + aside + " 에 보관했습니다.",
        at: new Date().toISOString()
      });
    }
  }

  store.set(key, session);
  return session;
}

// Written to a private temporary file and renamed over the old one, so a crash
// or a full disk in the middle of a save leaves the previous version intact
// instead of a truncated file the next start cannot parse. Writes for one room
// are chained: a shutdown save racing the debounced one used to have two
// writers truncating the same file at once.
const writeChains = new Map();

function serialize(session)
{
  session.trimMessages();
  return { body: JSON.stringify(session.toJSON()), version: session.changes };
}

// pid and a counter: the exit flush can run while an earlier save of the same
// room is still writing, and the two must not share a temporary file.
let tempSeq = 0;

function tempFor(file)
{
  tempSeq++;
  return file + "." + process.pid + "." + tempSeq + ".tmp";
}

// A process that exits in the middle of an asynchronous save leaves its
// temporary file behind. Remove the ones whose writer is gone.
function cleanStaleTemps()
{
  let names = [];
  try
  {
    names = fs.readdirSync(sessionsDir());
  }
  catch (err)
  {
    return;
  }
  for (let i = 0; i < names.length; i++)
  {
    const m = /\.(\d+)\.\d+\.tmp$/.exec(names[i]);
    if (!m || Number(m[1]) === process.pid)
    {
      continue;
    }
    let alive = false;
    try
    {
      process.kill(Number(m[1]), 0);
      alive = true;
    }
    catch (err)
    {
      alive = err && err.code === "EPERM";
    }
    if (!alive)
    {
      try
      {
        fs.unlinkSync(path.join(sessionsDir(), names[i]));
      }
      catch (err)
      {
        // already gone
      }
    }
  }
}

function persist(session)
{
  const file = fileFor(session.workspace);
  const previous = writeChains.get(file) || Promise.resolve();
  const next = previous.then(async function ()
  {
    const temp = tempFor(file);
    try
    {
      const snapshot = serialize(session);
      await fsp.mkdir(sessionsDir(), { recursive: true });
      await fsp.writeFile(temp, snapshot.body, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temp, file);
      session.saved = Math.max(session.saved, snapshot.version);
    }
    catch (err)
    {
      fsp.unlink(temp).catch(function () {});
      console.error("[session] persist failed:", err.message);
    }
  });
  writeChains.set(file, next);
  return next;
}

// For process exit, where nothing asynchronous runs any more.
function persistSync(session)
{
  const file = fileFor(session.workspace);
  const temp = tempFor(file);
  try
  {
    const snapshot = serialize(session);
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(temp, snapshot.body, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
    session.saved = Math.max(session.saved, snapshot.version);
  }
  catch (err)
  {
    try
    {
      fs.unlinkSync(temp);
    }
    catch (e)
    {
      // nothing was written
    }
    console.error("[session] final save failed:", err.message);
  }
}

// Every room with unsaved changes, not just the open one: a room left a moment
// ago can still have its debounced save pending.
function flushAllSync()
{
  saveTimers.forEach(function (timer)
  {
    clearTimeout(timer);
  });
  saveTimers.clear();
  pendingSince.clear();
  store.forEach(function (session)
  {
    if (session.saved < session.changes)
    {
      persistSync(session);
    }
  });
}

// One debounce timer per session: a shared timer would drop the pending write
// of the previous room when the user switches working folders quickly.
const saveTimers = new Map();

// Debounced, but never postponed past MAX_SAVE_DELAY_MS: a turn that keeps
// changing the room would otherwise keep pushing its own save away.
const SAVE_DELAY_MS = 700;
const MAX_SAVE_DELAY_MS = 3000;
const pendingSince = new Map();

function persistSoon(session)
{
  session.markChanged();

  const key = keyFor(session.workspace);
  const now = Date.now();
  if (!pendingSince.has(key))
  {
    pendingSince.set(key, now);
  }
  const existing = saveTimers.get(key);
  if (existing)
  {
    clearTimeout(existing);
  }

  const delay = Math.max(0, Math.min(SAVE_DELAY_MS, pendingSince.get(key) + MAX_SAVE_DELAY_MS - now));
  saveTimers.set(key, setTimeout(function ()
  {
    saveTimers.delete(key);
    pendingSince.delete(key);
    persist(session);
  }, delay));
}

module.exports =
{
  Session: Session,
  get: get,
  persist: persist,
  persistSoon: persistSoon,
  persistSync: persistSync,
  all: function ()
  {
    return Array.from(store.values());
  },
  flushAllSync: flushAllSync,
  cleanStaleTemps: cleanStaleTemps,
  sessionsDir: sessionsDir
};
