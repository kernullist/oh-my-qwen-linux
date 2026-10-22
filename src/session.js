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
const MAX_TRANSCRIPT_TEXT = 4000;

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

    // The UI only needs a readable excerpt; the full text still goes to the model.
    if (item && typeof item.text === "string" && item.text.length > MAX_TRANSCRIPT_TEXT)
    {
      const dropped = item.text.length - MAX_TRANSCRIPT_TEXT;
      item = Object.assign({}, item,
      {
        text: item.text.slice(0, MAX_TRANSCRIPT_TEXT) + "\n... [" + dropped + " chars trimmed from the saved log]"
      });
    }

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

function get(workspace)
{
  const key = keyFor(workspace);
  if (store.has(key))
  {
    return store.get(key);
  }

  const session = new Session(workspace);
  try
  {
    const raw = JSON.parse(fs.readFileSync(fileFor(workspace), "utf8"));
    if (raw && Array.isArray(raw.messages))
    {
      session.messages = raw.messages;
    }
    if (raw && Array.isArray(raw.transcript))
    {
      session.transcript = raw.transcript;
    }
  }
  catch (err)
  {
    // fresh room
  }

  store.set(key, session);
  return session;
}

async function persist(session)
{
  try
  {
    session.trimMessages();
    await fsp.mkdir(sessionsDir(), { recursive: true });
    await fsp.writeFile(fileFor(session.workspace), JSON.stringify(session.toJSON()), "utf8");
  }
  catch (err)
  {
    console.error("[session] persist failed:", err.message);
  }
}

// One debounce timer per session: a shared timer would drop the pending write
// of the previous room when the user switches working folders quickly.
const saveTimers = new Map();

function persistSoon(session)
{
  session.trimMessages();

  const key = keyFor(session.workspace);
  const existing = saveTimers.get(key);
  if (existing)
  {
    clearTimeout(existing);
  }

  saveTimers.set(key, setTimeout(function ()
  {
    saveTimers.delete(key);
    persist(session);
  }, 700));
}

module.exports =
{
  Session: Session,
  get: get,
  persist: persist,
  persistSoon: persistSoon,
  sessionsDir: sessionsDir
};
