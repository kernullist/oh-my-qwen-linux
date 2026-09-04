"use strict";

// Minimal LM Studio client built on the OpenAI-compatible endpoints.
// Uses the native REST API (/api/v0/models) when available because it also
// reports load state and capabilities such as tool_use.

function normalizeBase(baseUrl)
{
  let base = String(baseUrl || "").trim();
  if (!base)
  {
    base = "http://localhost:1234";
  }
  if (!/^https?:\/\//i.test(base))
  {
    base = "http://" + base;
  }
  base = base.replace(/\/+$/, "");
  base = base.replace(/\/v1$/i, "");
  base = base.replace(/\/api\/v0$/i, "");
  return base;
}

async function fetchJson(url, options, timeoutMs)
{
  const controller = new AbortController();
  const timer = setTimeout(function ()
  {
    controller.abort();
  }, timeoutMs || 8000);

  try
  {
    const res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    const text = await res.text();
    let json = null;
    try
    {
      json = JSON.parse(text);
    }
    catch (err)
    {
      json = null;
    }
    if (!res.ok)
    {
      const detail = (json && json.error && (json.error.message || json.error)) || text.slice(0, 400);
      throw new Error("HTTP " + res.status + ": " + detail);
    }
    return json;
  }
  finally
  {
    clearTimeout(timer);
  }
}

// Turns low level fetch failures into something a user can act on.
function friendlyError(err, base)
{
  const raw = String((err && err.message) || err);
  const cause = err && err.cause ? String(err.cause.code || err.cause.message || "") : "";
  const blob = raw + " " + cause;

  if (/ECONNREFUSED/i.test(blob) || /fetch failed/i.test(raw))
  {
    return base + " 에 연결할 수 없습니다. LM Studio의 Developer 탭에서 Local Server를 실행했는지, 주소와 포트가 맞는지 확인하세요.";
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(blob))
  {
    return base + " 호스트를 찾을 수 없습니다. 주소를 확인하세요.";
  }
  if (/aborted|timeout/i.test(blob))
  {
    return base + " 응답이 없습니다 (타임아웃). LM Studio가 응답 가능한 상태인지 확인하세요.";
  }
  if (/terminated|ECONNRESET|socket hang up|premature close/i.test(blob))
  {
    return base + " 와의 연결이 응답 중에 끊어졌습니다. LM Studio가 종료되었거나 모델이 언로드되었는지 확인하세요.";
  }
  return raw;
}

// Returns { baseUrl, detailed, models: [ ... ] }
async function listModels(baseUrl)
{
  const base = normalizeBase(baseUrl);
  let models = [];
  let detailed = false;

  try
  {
    const rich = await fetchJson(base + "/api/v0/models", { method: "GET" }, 8000);
    if (rich && Array.isArray(rich.data))
    {
      detailed = true;
      models = rich.data.map(function (m)
      {
        return {
          id: m.id,
          state: m.state || "unknown",
          type: m.type || "llm",
          publisher: m.publisher || "",
          quantization: m.quantization || "",
          maxContext: m.max_context_length || 0,
          loadedContext: m.loaded_context_length || 0,
          capabilities: Array.isArray(m.capabilities) ? m.capabilities : []
        };
      });
    }
  }
  catch (err)
  {
    detailed = false;
  }

  if (!detailed)
  {
    let plain = null;
    try
    {
      plain = await fetchJson(base + "/v1/models", { method: "GET" }, 8000);
    }
    catch (err)
    {
      throw new Error(friendlyError(err, base));
    }
    const data = (plain && Array.isArray(plain.data)) ? plain.data : [];
    models = data.map(function (m)
    {
      return {
        id: m.id,
        state: "unknown",
        type: "llm",
        publisher: m.owned_by || "",
        quantization: "",
        maxContext: 0,
        loadedContext: 0,
        capabilities: []
      };
    });
  }

  models = models.filter(function (m)
  {
    return m.type !== "embeddings";
  });

  // Loaded models first, then alphabetical.
  models.sort(function (a, b)
  {
    const aLoaded = a.state === "loaded" ? 0 : 1;
    const bLoaded = b.state === "loaded" ? 0 : 1;
    if (aLoaded !== bLoaded)
    {
      return aLoaded - bLoaded;
    }
    return String(a.id).localeCompare(String(b.id));
  });

  return { baseUrl: base, detailed: detailed, models: models };
}

// Fallback parser for templates that leak tool calls into content.
// Qwen templates also leak the XML-ish form:
//
//   <function=edit_file>
//   <parameter=path>
//   src/lookup.h
//   </parameter>
//   </function>
//
// Values sit on their own lines, so exactly one leading and one trailing
// newline is removed. Trimming further would break edit_file, whose old_string
// has to match the file's indentation byte for byte.
function parseXmlToolCall(block)
{
  const nameMatch = block.match(/<function=([A-Za-z0-9_.-]+)\s*>/);
  if (!nameMatch)
  {
    return null;
  }

  const args = {};
  const re = /<parameter=([A-Za-z0-9_.-]+)\s*>([\s\S]*?)<\/parameter>/g;
  let m = re.exec(block);

  while (m)
  {
    args[m[1]] = String(m[2]).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    m = re.exec(block);
  }

  return { name: nameMatch[1], arguments: JSON.stringify(args) };
}

function parseJsonToolCall(block)
{
  try
  {
    const parsed = JSON.parse(block);
    const name = parsed.name || parsed.function;
    if (!name)
    {
      return null;
    }
    const args = parsed.arguments || parsed.parameters || {};
    return { name: name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
  }
  catch (err)
  {
    return null;
  }
}

// Fallback for templates that put the tool call in the content instead of in
// tool_calls. Returns { content, call } for a usable call, or
// { content, truncated: true } when the block was cut off mid-way.
function recoverInlineToolCall(text)
{
  if (!text)
  {
    return null;
  }

  const OPEN = "<tool_call>";
  const CLOSE = "</tool_call>";
  const open = text.indexOf(OPEN);
  if (open < 0)
  {
    return null;
  }

  const close = text.indexOf(CLOSE, open);
  if (close < 0)
  {
    // Cut off by the token limit. The arguments are incomplete, so running it
    // could truncate a file instead of editing it. Take the debris out of the
    // visible answer and let the caller report a truncated call.
    return { content: text.slice(0, open).trim(), call: null, truncated: true };
  }

  const block = text.slice(open + OPEN.length, close).trim();
  const rest = (text.slice(0, open) + text.slice(close + CLOSE.length)).trim();
  const parsed = parseJsonToolCall(block) || parseXmlToolCall(block);

  if (!parsed)
  {
    return null;
  }

  return {
    content: rest,
    call:
    {
      id: "call_inline_" + Date.now(),
      type: "function",
      function: { name: parsed.name, arguments: parsed.arguments }
    }
  };
}

// Streams one assistant turn.
// onEvent({ type: "reasoning" | "content", text }) fires for every delta.
// Resolves with { content, reasoning, toolCalls, finishReason, usage }.
async function streamChat(opts, onEvent)
{
  const base = normalizeBase(opts.baseUrl);

  // Loading a cold model can take a while, so allow a long wait for the first
  // byte, then a shorter one between deltas. Without this a server that opens
  // the stream and stops (unloaded model, hung backend) keeps the turn busy
  // forever and the app looks dead.
  const firstByteMs = Number.isFinite(opts.firstByteTimeoutMs) ? opts.firstByteTimeoutMs : 300000;
  const idleMs = Number.isFinite(opts.idleTimeoutMs) ? opts.idleTimeoutMs : 90000;

  const inner = new AbortController();
  let timedOutIdle = false;
  let sawAnyByte = false;

  const onOuterAbort = function ()
  {
    inner.abort();
  };

  if (opts.signal)
  {
    if (opts.signal.aborted)
    {
      inner.abort();
    }
    else
    {
      // Removed in the finally below: one listener per round would otherwise
      // pile up on the session's signal for the whole turn.
      opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
  }

  function releaseOuter()
  {
    if (opts.signal)
    {
      try
      {
        opts.signal.removeEventListener("abort", onOuterAbort);
      }
      catch (err)
      {
        // nothing to release
      }
    }
  }

  let idleTimer = null;
  function armIdleTimer()
  {
    if (idleTimer)
    {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(function ()
    {
      timedOutIdle = true;
      inner.abort();
    }, sawAnyByte ? idleMs : firstByteMs);
  }
  function disarmIdleTimer()
  {
    if (idleTimer)
    {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }
  const body =
  {
    model: opts.model,
    messages: opts.messages,
    temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.3,
    max_tokens: Number.isFinite(opts.maxTokens) ? opts.maxTokens : 4096,
    stream: true,
    // Without this a streamed response carries no token counts at all, so the
    // app cannot tell the user how close a turn came to the context limit.
    stream_options: { include_usage: true }
  };

  if (Array.isArray(opts.tools) && opts.tools.length > 0)
  {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }

  let res = null;
  armIdleTimer();
  try
  {
    res = await fetch(base + "/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: inner.signal
    });
  }
  catch (err)
  {
    disarmIdleTimer();
    releaseOuter();

    if (timedOutIdle)
    {
      throw new Error(base + " did not answer within " + Math.round(firstByteMs / 1000) +
        "s. If a model is still loading, wait and retry; otherwise check that LM Studio is running and responsive.");
    }
    // Let a real cancellation through untouched; the agent loop detects it.
    if (err && (err.name === "AbortError" || /abort/i.test(String(err.message))))
    {
      throw err;
    }
    throw new Error(friendlyError(err, base));
  }

  if (!res.ok || !res.body)
  {
    const text = await res.text().catch(function () { return ""; });
    let detail = text.slice(0, 600);
    try
    {
      const j = JSON.parse(text);
      detail = (j.error && (j.error.message || j.error)) || detail;
    }
    catch (err)
    {
      // keep the raw text
    }
    throw new Error("LM Studio request failed (HTTP " + res.status + "): " + detail);
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();

  let buffer = "";
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let usage = null;
  let chunkCount = 0;
  const toolCalls = [];

  function applyToolDelta(deltaList)
  {
    for (let i = 0; i < deltaList.length; i++)
    {
      const d = deltaList[i];
      const idx = Number.isFinite(d.index) ? d.index : 0;
      if (!toolCalls[idx])
      {
        toolCalls[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
      }
      const slot = toolCalls[idx];
      if (d.id)
      {
        slot.id = d.id;
      }
      if (d.type)
      {
        slot.type = d.type;
      }
      if (d.function)
      {
        if (d.function.name)
        {
          slot.function.name += d.function.name;
        }
        if (typeof d.function.arguments === "string")
        {
          slot.function.arguments += d.function.arguments;
        }
      }
    }
  }

  function handleChunk(payload)
  {
    let obj = null;
    try
    {
      obj = JSON.parse(payload);
    }
    catch (err)
    {
      return;
    }

    chunkCount++;

    if (obj.usage)
    {
      usage = obj.usage;
    }

    const choice = obj.choices && obj.choices[0];
    if (!choice)
    {
      return;
    }
    if (choice.finish_reason)
    {
      finishReason = choice.finish_reason;
    }

    const delta = choice.delta || {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0)
    {
      reasoning += delta.reasoning_content;
      onEvent({ type: "reasoning", text: delta.reasoning_content });
    }
    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0)
    {
      reasoning += delta.reasoning;
      onEvent({ type: "reasoning", text: delta.reasoning });
    }
    if (typeof delta.content === "string" && delta.content.length > 0)
    {
      content += delta.content;
      onEvent({ type: "content", text: delta.content });
    }
    if (Array.isArray(delta.tool_calls))
    {
      applyToolDelta(delta.tool_calls);
    }
  }

  armIdleTimer();

  try
  {
    for (;;)
    {
      let step = null;
      try
      {
        step = await reader.read();
      }
      catch (err)
      {
        if (timedOutIdle)
        {
          throw new Error("LM Studio opened the stream but stopped sending data for " +
            Math.round((sawAnyByte ? idleMs : firstByteMs) / 1000) + "s. " +
            "The model may have been unloaded or the server is stuck; check LM Studio and try again.");
        }
        if (opts.signal && opts.signal.aborted)
        {
          throw err;
        }
        throw new Error(friendlyError(err, base));
      }

      if (step.done)
      {
        break;
      }

      sawAnyByte = true;
      armIdleTimer();

      buffer += decoder.decode(step.value, { stream: true });

      let cut = buffer.indexOf("\n");
      while (cut >= 0)
      {
        const line = buffer.slice(0, cut).replace(/\r$/, "");
        buffer = buffer.slice(cut + 1);

        if (line.startsWith("data:"))
        {
          const payload = line.slice(5).trim();
          if (payload && payload !== "[DONE]")
          {
            handleChunk(payload);
          }
        }
        cut = buffer.indexOf("\n");
      }
    }
  }
  finally
  {
    disarmIdleTimer();
    releaseOuter();
  }

  // A stream that carried no usable delta means the endpoint is not speaking the
  // OpenAI streaming protocol; saying "empty response" would send the model and
  // the user looking in the wrong place.
  if (chunkCount === 0)
  {
    throw new Error("The response from " + base + " contained no usable data. " +
      "Check that the address points at LM Studio's OpenAI-compatible server (/v1) and that a chat model is loaded.");
  }

  let cleaned = toolCalls
    .filter(function (t)
    {
      return t && t.function && t.function.name;
    })
    .map(function (t, i)
    {
      return {
        id: t.id || ("call_" + Date.now() + "_" + i),
        type: "function",
        function: { name: t.function.name, arguments: t.function.arguments || "{}" }
      };
    });

  if (cleaned.length === 0)
  {
    const recovered = recoverInlineToolCall(content);
    if (recovered && recovered.call)
    {
      cleaned = [recovered.call];
      content = recovered.content;
      finishReason = "tool_calls";
    }
    else if (recovered && recovered.truncated)
    {
      // Leaving the half written block in the answer showed the user a broken
      // XML fragment as prose. Report it as the length problem it is.
      content = recovered.content;
      finishReason = "length";
    }
  }

  return {
    content: content,
    reasoning: reasoning,
    toolCalls: cleaned,
    finishReason: finishReason || (cleaned.length > 0 ? "tool_calls" : "stop"),
    usage: usage
  };
}

module.exports =
{
  normalizeBase: normalizeBase,
  friendlyError: friendlyError,
  listModels: listModels,
  streamChat: streamChat,
  // Exported for the regression tests: a template leaking its tool call into
  // the answer text is a real failure mode worth pinning down.
  recoverInlineToolCall: recoverInlineToolCall
};
