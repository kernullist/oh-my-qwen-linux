"use strict";

// oh-my-qwen chat room front end.
// Talks to the local server over fetch + SSE; keeps no state on the model side.

(function ()
{
  const el = function (id)
  {
    return document.getElementById(id);
  };

  // The server API this page was written for; see API_VERSION in server.js.
  const SERVER_API = 4;

  // Filled from /api/config so "restore defaults" always matches the server.
  let defaultCodingRules = "";

  const chatScroll = el("chatScroll");
  const chatList = el("chatList");
  const input = el("input");
  const btnSend = el("btnSend");
  const btnStop = el("btnStop");
  const typingBar = el("typingBar");
  const typingText = el("typingText");
  const statusStrip = el("statusStrip");
  const statusText = el("statusText");

  const state =
  {
    config: null,
    workspace: null,
    busy: false,
    lastDay: "",
    streams: new Map(),
    models: [],
    connected: false
  };

  const TOOL_ICONS =
  {
    list_dir: "📂",
    read_file: "📄",
    write_file: "📝",
    edit_file: "✏️",
    create_dir: "📁",
    delete_path: "🗑️",
    find_files: "🔍",
    search_text: "🔎",
    replace_in_files: "🧹",
    build_project: "🔨",
    run_project: "▶️",
    test_project: "🧪",
    run_command: "⚙️",
    web_search: "🌐",
    web_fetch: "📰"
  };

  const TOOL_TITLES =
  {
    write_file: "파일을 새로 쓰려고 합니다",
    edit_file: "파일을 수정하려고 합니다",
    replace_in_files: "여러 파일을 일괄 수정하려고 합니다",
    create_dir: "폴더를 만들려고 합니다",
    delete_path: "경로를 삭제하려고 합니다",
    build_project: "프로젝트를 빌드하려고 합니다",
    run_project: "프로젝트를 실행하려고 합니다",
    test_project: "테스트를 실행하려고 합니다",
    run_command: "명령을 실행하려고 합니다"
  };

  // ------------------------------------------------------------------ utils

  function escapeHtml(text)
  {
    return String(text === undefined || text === null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function timeLabel(iso)
  {
    const d = iso ? new Date(iso) : new Date();
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, "0");
    const ampm = h < 12 ? "오전" : "오후";
    h = h % 12;
    if (h === 0)
    {
      h = 12;
    }
    return ampm + " " + h + ":" + m;
  }

  function dayLabel(iso)
  {
    const d = iso ? new Date(iso) : new Date();
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    return d.getFullYear() + "년 " + (d.getMonth() + 1) + "월 " + d.getDate() + "일 " + days[d.getDay()] + "요일";
  }

  // Local date, like dayLabel. toISOString() is UTC, so in Korea every message
  // between midnight and 9 a.m. landed under the previous day's divider.
  function dayKey(iso)
  {
    const d = iso ? new Date(iso) : new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }

  function nearBottom()
  {
    return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 140;
  }

  function scrollToBottom(force)
  {
    if (!force && !nearBottom())
    {
      return;
    }

    // Set it now: requestAnimationFrame does not fire while the tab is hidden.
    chatScroll.scrollTop = chatScroll.scrollHeight;
    requestAnimationFrame(function ()
    {
      chatScroll.scrollTop = chatScroll.scrollHeight;
    });
  }

  function setStatus(text, tone)
  {
    if (!text)
    {
      statusStrip.hidden = true;
      return;
    }
    statusStrip.hidden = false;
    statusStrip.style.background = tone === "error" ? "#fdecea" : "#fff4c2";
    statusStrip.style.color = tone === "error" ? "#8d2418" : "#6b5300";
    statusStrip.style.borderBottomColor = tone === "error" ? "#f0c4bd" : "#e6d692";
    statusText.textContent = text;
  }

  // -------------------------------------------------------------- markdown

  function renderInline(text)
  {
    let out = escapeHtml(text);
    out = out.replace(/`([^`\n]+)`/g, function (m, code)
    {
      return "<code>" + code + "</code>";
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    out = out.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
    return out;
  }

  function isTableRow(line)
  {
    return /^\s*\|.*\|\s*$/.test(String(line || ""));
  }

  function isTableDelimiter(line)
  {
    return /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(String(line || ""));
  }

  function splitTableRow(line)
  {
    let text = String(line || "").trim();
    text = text.replace(/^\|/, "").replace(/\|$/, "");
    // Keep escaped pipes inside a cell.
    return text.split(/(?<!\\)\|/).map(function (cell)
    {
      return cell.split("\\|").join("|");
    });
  }

  function renderMarkdown(src)
  {
    const text = String(src || "");
    const blocks = [];
    const lines = text.split(/\r?\n/);

    let i = 0;
    let listType = null;
    let listItems = [];
    let paragraph = [];

    function flushParagraph()
    {
      if (paragraph.length > 0)
      {
        blocks.push("<p>" + renderInline(paragraph.join("\n")).replace(/\n/g, "<br />") + "</p>");
        paragraph = [];
      }
    }

    function flushList()
    {
      if (listItems.length > 0)
      {
        const tag = listType === "ol" ? "ol" : "ul";
        blocks.push("<" + tag + ">" + listItems.map(function (it)
        {
          return "<li>" + renderInline(it) + "</li>";
        }).join("") + "</" + tag + ">");
        listItems = [];
        listType = null;
      }
    }

    while (i < lines.length)
    {
      const line = lines[i];
      const fence = line.match(/^\s*```([\w+#.-]*)\s*$/);

      if (fence)
      {
        flushParagraph();
        flushList();

        const lang = fence[1] || "";
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i]))
        {
          body.push(lines[i]);
          i++;
        }
        i++;

        const code = escapeHtml(body.join("\n"));
        blocks.push(
          '<div class="code-head"><span>' + escapeHtml(lang || "code") + '</span>' +
          '<button class="copy-btn" type="button" data-copy="1">복사</button></div>' +
          '<pre><code>' + code + '</code></pre>');
        continue;
      }

      // GFM table: a header row followed by a delimiter row.
      if (isTableRow(line) && i + 1 < lines.length && isTableDelimiter(lines[i + 1]))
      {
        flushParagraph();
        flushList();

        const header = splitTableRow(line);
        const aligns = splitTableRow(lines[i + 1]).map(function (cell)
        {
          const trimmed = cell.trim();
          const left = trimmed.charAt(0) === ":";
          const right = trimmed.charAt(trimmed.length - 1) === ":";
          if (left && right)
          {
            return "center";
          }
          if (right)
          {
            return "right";
          }
          return "left";
        });

        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i]))
        {
          rows.push(splitTableRow(lines[i]));
          i++;
        }

        const head = "<thead><tr>" + header.map(function (cell, idx)
        {
          return '<th style="text-align:' + (aligns[idx] || "left") + '">' + renderInline(cell.trim()) + "</th>";
        }).join("") + "</tr></thead>";

        const body = rows.map(function (cells)
        {
          const tds = [];
          for (let c = 0; c < header.length; c++)
          {
            const value = cells[c] === undefined ? "" : cells[c];
            tds.push('<td style="text-align:' + (aligns[c] || "left") + '">' + renderInline(value.trim()) + "</td>");
          }
          return "<tr>" + tds.join("") + "</tr>";
        }).join("");

        blocks.push('<div class="table-wrap"><table>' + head + "<tbody>" + body + "</tbody></table></div>");
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading)
      {
        flushParagraph();
        flushList();
        const level = Math.min(3, heading[1].length);
        blocks.push("<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">");
        i++;
        continue;
      }

      const quote = line.match(/^>\s?(.*)$/);
      if (quote)
      {
        flushParagraph();
        flushList();
        blocks.push("<blockquote>" + renderInline(quote[1]) + "</blockquote>");
        i++;
        continue;
      }

      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

      if (bullet || numbered)
      {
        flushParagraph();
        const kind = bullet ? "ul" : "ol";
        if (listType && listType !== kind)
        {
          flushList();
        }
        listType = kind;
        listItems.push((bullet ? bullet[1] : numbered[1]));
        i++;
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line))
      {
        flushParagraph();
        flushList();
        blocks.push("<hr />");
        i++;
        continue;
      }

      if (line.trim() === "")
      {
        flushParagraph();
        flushList();
        i++;
        continue;
      }

      flushList();
      paragraph.push(line);
      i++;
    }

    flushParagraph();
    flushList();
    return blocks.join("");
  }

  // ------------------------------------------------------------ rendering

  function ensureDay(iso)
  {
    const key = dayKey(iso);
    if (state.lastDay === key)
    {
      return;
    }
    state.lastDay = key;
    const div = document.createElement("div");
    div.className = "day-divider";
    div.textContent = dayLabel(iso);
    chatList.appendChild(div);
  }

  function makeUserMessage(item)
  {
    ensureDay(item.at);

    const wrap = document.createElement("div");
    wrap.className = "msg mine";
    wrap.dataset.id = item.id;

    const col = document.createElement("div");
    col.className = "msg-col";

    const row = document.createElement("div");
    row.className = "bubble-row";

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = timeLabel(item.at);

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = renderMarkdown(item.text);

    row.appendChild(time);
    row.appendChild(bubble);
    col.appendChild(row);
    wrap.appendChild(col);
    chatList.appendChild(wrap);
    return wrap;
  }

  function makeAssistantShell(item)
  {
    ensureDay(item.at);

    const wrap = document.createElement("div");
    wrap.className = "msg other";
    wrap.dataset.id = item.id;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "Q";

    const col = document.createElement("div");
    col.className = "msg-col";

    const sender = document.createElement("div");
    sender.className = "sender";
    sender.textContent = modelShortName();

    const think = document.createElement("div");
    think.className = "think";
    think.hidden = true;
    think.innerHTML = '<div class="think-head"><span class="chev">▶</span><span class="think-title">생각 정리 중...</span></div>' +
      '<div class="think-body"></div>';
    think.querySelector(".think-head").addEventListener("click", function ()
    {
      think.classList.toggle("open");
    });

    const row = document.createElement("div");
    row.className = "bubble-row";

    const bubble = document.createElement("div");
    bubble.className = "bubble streaming";

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = timeLabel(item.at);

    row.appendChild(bubble);
    row.appendChild(time);

    col.appendChild(sender);
    col.appendChild(think);
    col.appendChild(row);
    wrap.appendChild(avatar);
    wrap.appendChild(col);
    chatList.appendChild(wrap);

    return { wrap: wrap, bubble: bubble, think: think, row: row, time: time };
  }

  function modelShortName()
  {
    const model = state.config && state.config.model ? state.config.model : "Qwen";
    const parts = String(model).split("/");
    return parts[parts.length - 1] || "Qwen";
  }

  function renderAssistantFinal(shell, item)
  {
    const hasText = item.text && item.text.trim().length > 0;

    if (item.reasoning && item.reasoning.trim() && state.config && state.config.showThinking)
    {
      shell.think.hidden = false;
      shell.think.querySelector(".think-body").textContent = item.reasoning.trim();
      shell.think.querySelector(".think-title").textContent = "생각 과정 (" + item.reasoning.trim().length + "자)";
    }
    else if (!item.reasoning || !item.reasoning.trim())
    {
      shell.think.hidden = true;
    }

    if (hasText)
    {
      shell.bubble.innerHTML = renderMarkdown(item.text) +
        (item.partial ? '<div class="partial-tag">중단된 응답입니다</div>' : "");
      shell.row.hidden = false;
    }
    else
    {
      shell.row.hidden = true;
    }

    shell.bubble.classList.remove("streaming");
    shell.time.textContent = timeLabel(item.at);

    // What the round really cost, from the server's own count. The settings
    // screen can only estimate; this is where the context limit shows up.
    const usage = item.usage;
    if (usage && usage.prompt_tokens)
    {
      const limit = state.config && state.config.contextTokens;
      shell.time.title = "입력 " + usage.prompt_tokens.toLocaleString() + " · 출력 " +
        (usage.completion_tokens || 0).toLocaleString() + " 토큰" +
        (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens
          ? " (생각 " + usage.completion_tokens_details.reasoning_tokens.toLocaleString() + ")" : "") +
        (limit ? " · 대화 예산 " + limit.toLocaleString() : "");
    }

    if (!hasText && shell.think.hidden)
    {
      shell.wrap.remove();
    }
  }

  function makeToolCard(item)
  {
    ensureDay(item.at);

    const card = document.createElement("div");
    card.className = "tool-card";
    card.dataset.callId = item.callId || "";

    const icon = TOOL_ICONS[item.name] || "🔧";
    card.innerHTML =
      '<div class="tool-head">' +
        '<span class="tool-icon">' + icon + '</span>' +
        '<span class="tool-name">' + escapeHtml(item.name) + '</span>' +
        '<span class="tool-label">' + escapeHtml(item.label || "") + '</span>' +
        '<span class="tool-state run">실행 중</span>' +
      '</div>' +
      '<div class="tool-body"><pre></pre></div>';

    card.querySelector(".tool-head").addEventListener("click", function ()
    {
      card.classList.toggle("open");
    });

    chatList.appendChild(card);
    return card;
  }

  function applyToolResult(item)
  {
    let card = null;
    if (item.callId)
    {
      const found = chatList.querySelectorAll('.tool-card[data-call-id="' + CSS.escape(item.callId) + '"]');
      card = found.length > 0 ? found[found.length - 1] : null;
    }
    if (!card)
    {
      card = makeToolCard(item);
    }

    const stateEl = card.querySelector(".tool-state");
    stateEl.className = "tool-state " + (item.ok ? "ok" : "fail");
    stateEl.textContent = item.ok ? (item.summary || "완료") : (item.summary || "실패");
    card.querySelector(".tool-body pre").textContent = item.text || "";
    if (!item.ok)
    {
      card.classList.add("open");
    }
  }

  function makeNotice(item)
  {
    ensureDay(item.at);
    const div = document.createElement("div");
    div.className = "notice " + (item.level || "info");
    div.textContent = item.text;
    chatList.appendChild(div);
  }

  function makeApproval(info)
  {
    ensureDay(info.at);

    const card = document.createElement("div");
    card.className = "approval";
    card.dataset.approvalId = info.id;

    const title = TOOL_TITLES[info.name] || (info.name + " 실행을 요청했습니다");
    const preview = info.preview ? '<div class="approval-preview">' + escapeHtml(info.preview) + "</div>" : "";

    // The label repeats the preview for run_command, so show it only once.
    const label = (info.label && info.preview && info.preview.indexOf(info.label) === 0) ? "" : (info.label || "");

    // A shell command is the only way out of the working folder, and the path
    // is easy to miss inside a long shell command. Call it out separately.
    const outside = Array.isArray(info.outsidePaths) ? info.outsidePaths : [];
    let warning = outside.length > 0
      ? '<div class="approval-warning">작업 폴더 밖 경로를 사용합니다: ' +
          escapeHtml(outside.slice(0, 4).join("  ")) +
          (outside.length > 4 ? " 외 " + (outside.length - 4) + "건" : "") + "</div>"
      : "";

    // The file tools refuse to rewrite these, so the shell doing it by hand
    // deserves its own line rather than a path buried in a long command.
    const binaries = Array.isArray(info.binaryWrites) ? info.binaryWrites : [];
    if (binaries.length > 0)
    {
      warning += '<div class="approval-warning">바이너리 파일을 셸로 덮어씁니다(파일 도구는 거부하는 작업입니다): ' +
        escapeHtml(binaries.slice(0, 4).join("  ")) +
        (binaries.length > 4 ? " 외 " + (binaries.length - 4) + "건" : "") + "</div>";
    }

    card.innerHTML =
      '<div class="approval-title"><span>' + (TOOL_ICONS[info.name] || "🔧") + '</span><span>' + escapeHtml(title) + '</span></div>' +
      '<div class="approval-target">' + escapeHtml(info.name) + (label ? "  " + escapeHtml(label) : "") + '</div>' +
      warning +
      preview +
      '<div class="approval-actions">' +
        '<button class="btn-allow" type="button">허용</button>' +
        '<button class="btn-deny" type="button">거부</button>' +
      '</div>';

    card.querySelector(".btn-allow").addEventListener("click", function ()
    {
      resolveApproval(info.id, true);
    });
    card.querySelector(".btn-deny").addEventListener("click", function ()
    {
      resolveApproval(info.id, false);
    });

    chatList.appendChild(card);
    scrollToBottom(true);
    return card;
  }

  function markApprovalResolved(id, approved, reason)
  {
    const card = chatList.querySelector('.approval[data-approval-id="' + CSS.escape(id) + '"]');
    // The first verdict wins: the agent repeats it after the server already
    // said why, for example "allowed because the mode changed".
    if (!card || card.classList.contains("resolved"))
    {
      return;
    }
    card.classList.add("resolved");
    const actions = card.querySelector(".approval-actions");
    if (actions)
    {
      let label = approved ? "허용했습니다" : "거부했습니다";
      if (reason === "timeout")
      {
        label = "시간이 초과되어 자동 거부되었습니다";
      }
      else if (reason === "mode")
      {
        label = "권한 모드가 바뀌어 자동으로 허용했습니다";
      }
      actions.innerHTML = '<span class="approval-result" style="color:' + (approved ? "#1f7a4d" : "#c0392b") + '">' +
        escapeHtml(label) + "</span>";
    }
  }

  function renderTranscript(items)
  {
    chatList.innerHTML = "";
    state.lastDay = "";
    state.streams.clear();

    for (let i = 0; i < items.length; i++)
    {
      const item = items[i];
      if (item.kind === "user")
      {
        makeUserMessage(item);
      }
      else if (item.kind === "assistant")
      {
        const shell = makeAssistantShell(item);
        renderAssistantFinal(shell, item);
      }
      else if (item.kind === "tool_call")
      {
        makeToolCard(item);
      }
      else if (item.kind === "tool")
      {
        applyToolResult(item);
      }
      else if (item.kind === "notice")
      {
        makeNotice(item);
      }
    }

    if (items.length === 0)
    {
      showWelcome();
    }

    scrollToBottom(true);
  }

  function showWelcome()
  {
    const div = document.createElement("div");
    div.className = "notice";
    div.innerHTML = "작업 폴더를 등록하고 설정에서 모델을 선택하면 바로 시작할 수 있습니다.<br />" +
      "예: <b>이 폴더 구조 살펴보고 README.md 만들어줘</b>";
    chatList.appendChild(div);
  }

  // ------------------------------------------------------------------ api

  async function api(path, options)
  {
    const res = await fetch(path, Object.assign(
    {
      headers: { "Content-Type": "application/json" }
    }, options || {}));

    let json = null;
    try
    {
      json = await res.json();
    }
    catch (err)
    {
      json = null;
    }

    if (!res.ok)
    {
      const message = (json && json.error) || ("HTTP " + res.status);
      throw new Error(message);
    }
    return json || {};
  }

  async function resolveApproval(id, approved)
  {
    markApprovalResolved(id, approved);
    try
    {
      await api("/api/approve", { method: "POST", body: JSON.stringify({ id: id, approved: approved }) });
    }
    catch (err)
    {
      setStatus("승인 처리 실패: " + err.message, "error");
    }
  }

  function updateHeader()
  {
    const cfg = state.config || {};
    const ws = state.workspace || {};

    el("roomModel").textContent = cfg.model ? modelShortName() : "모델 미선택";
    el("workspaceLabel").textContent = ws.path ? ws.path : "작업 폴더 미등록";
    el("roomName").textContent = ws.name ? ws.name : "oh-my-qwen";

    const problems = [];
    // A server started before an update keeps running the old code while the
    // page is already the new one, and every new feature fails in odd ways.
    if (state.config && state.config.apiVersion !== SERVER_API)
    {
      problems.push("서버가 이전 버전의 코드로 실행 중입니다. 서버를 종료(Ctrl+C 또는 설정의 '서버 종료')한 뒤 " +
        "./start.sh 로 다시 실행하고 이 페이지를 새로고침해 주세요.");
    }
    if (!ws.path)
    {
      problems.push("작업 폴더가 등록되지 않았습니다.");
    }
    else if (!ws.valid)
    {
      problems.push("작업 폴더를 찾을 수 없습니다: " + ws.path);
    }
    if (!cfg.model)
    {
      problems.push("설정에서 모델을 선택해 주세요.");
    }

    if (problems.length > 0)
    {
      setStatus(problems.join(" "), "error");
    }
    else if (ws.risk)
    {
      // Every path protection is relative to this folder, so picking a drive
      // root or the profile root silently turns all of them off. That has to
      // stay on screen, not scroll past once.
      setStatus(ws.risk.message, "warn");
    }
    else
    {
      setStatus(state.connected ? "" : "서버 연결이 끊어졌습니다. 재연결 중...", "error");
    }

    syncModePill();
    updateSendEnabled();
  }

  // ------------------------------------------------------- permission mode

  const PERMISSION_HINTS =
  {
    ask: "파일 쓰기, 수정, 삭제, 빌드, 실행, 명령은 매번 승인 카드를 띄웁니다.",
    edits: "작업 폴더 안의 파일 쓰기와 수정은 바로 실행합니다. 삭제, 명령, 빌드, 실행, 테스트는 묻습니다.",
    auto: "작업 폴더 안의 작업은 모두 묻지 않고 실행합니다. 폴더 밖 경로를 건드리거나 바이너리를 셸로 덮어쓰는 명령만 묻습니다.",
    full: "어떤 작업도 묻지 않습니다. 폴더 밖을 건드리는 명령도 바로 실행되니 신뢰하는 작업에서만 쓰세요."
  };

  function showPermissionHint(mode)
  {
    const hint = el("permissionHint");
    hint.textContent = PERMISSION_HINTS[mode] || "";
    hint.className = "hint" + (mode === "full" ? " err" : "");
  }

  function syncModePill()
  {
    const pill = el("selModeQuick");
    const mode = (state.config && state.config.permissionMode) || "ask";
    pill.value = mode;
    pill.dataset.mode = mode;
    pill.title = "권한 모드: " + (PERMISSION_HINTS[mode] || "");
  }

  // "full" removes the last check on commands that leave the folder, so it is
  // confirmed once each time it is chosen.
  function confirmFull(mode)
  {
    return mode !== "full" ||
      window.confirm("전체 자동 모드에서는 폴더 밖을 건드리는 명령까지 묻지 않고 실행합니다. 계속할까요?");
  }

  el("selModeQuick").addEventListener("change", async function ()
  {
    const mode = el("selModeQuick").value;
    if (!confirmFull(mode))
    {
      syncModePill();
      return;
    }
    try
    {
      const data = await api("/api/config", { method: "POST", body: JSON.stringify({ permissionMode: mode }) });
      state.config = data.config;
      syncModePill();
    }
    catch (err)
    {
      setStatus("권한 모드 변경 실패: " + err.message, "error");
      syncModePill();
    }
  });

  el("selPermissionMode").addEventListener("change", function ()
  {
    const sel = el("selPermissionMode");
    if (!confirmFull(sel.value))
    {
      sel.value = (state.config && state.config.permissionMode) || "ask";
    }
    showPermissionHint(sel.value);
  });

  function updateSendEnabled()
  {
    const ready = !!(state.config && state.config.model && state.workspace && state.workspace.path);
    btnSend.disabled = state.busy || !ready || input.value.trim() === "";
  }

  function setBusy(busy, text)
  {
    state.busy = busy;
    typingBar.hidden = !busy;
    if (busy)
    {
      typingText.textContent = text || "응답 생성 중...";
    }
    updateSendEnabled();
  }

  async function loadState()
  {
    try
    {
      const data = await api("/api/state");
      state.config = data.config;
      state.workspace = data.workspace;
      renderTranscript(data.transcript || []);

      const pending = data.pendingApprovals || [];
      for (let i = 0; i < pending.length; i++)
      {
        if (pending[i] && pending[i].id)
        {
          makeApproval(pending[i]);
        }
      }

      setBusy(!!data.busy, pending.length > 0 ? "승인을 기다리는 중..." : "응답 생성 중...");
      updateHeader();
    }
    catch (err)
    {
      setStatus("서버 상태를 가져오지 못했습니다: " + err.message, "error");
    }
  }

  // ------------------------------------------------------------------ sse

  function connectEvents()
  {
    const source = new EventSource("/api/events");

    source.addEventListener("open", function ()
    {
      state.connected = true;
      updateHeader();
    });

    // The browser reconnects on its own after the server restarts or the
    // network blips, but everything broadcast in between is gone: a finished
    // turn kept its typing bar and an approval card never appeared. A hello
    // after the first one means "reconnected", so repaint from the server.
    let hellos = 0;
    source.addEventListener("hello", function ()
    {
      state.connected = true;
      hellos++;
      if (hellos > 1)
      {
        loadState();
      }
      updateHeader();
    });

    source.addEventListener("error", function ()
    {
      state.connected = false;
      setStatus("서버 연결이 끊어졌습니다. 재연결 중...", "error");
    });

    function on(name, handler)
    {
      source.addEventListener(name, function (ev)
      {
        let data = {};
        try
        {
          data = JSON.parse(ev.data);
        }
        catch (err)
        {
          data = {};
        }

        // A turn started in the previous folder keeps streaming after a switch.
        // Those events belong to another room: showing them here would put its
        // messages, and its approval cards, in front of the wrong folder.
        // Only per-turn events carry a path here; the "workspace" event carries
        // an object describing the new room and must never be filtered out.
        if (data && typeof data.workspace === "string" && data.workspace &&
            state.workspace && state.workspace.path &&
            data.workspace !== state.workspace.path)
        {
          return;
        }

        handler(data);
      });
    }

    on("config", function (cfg)
    {
      state.config = cfg;
      updateHeader();
    });

    on("workspace", function (data)
    {
      state.workspace = data.workspace;
      state.config = data.config;
      renderTranscript(data.transcript || []);
      // The old room's turn was cancelled by the switch, and its turn_end is
      // filtered out as another room's event, so the typing bar stayed up.
      setBusy(!!data.busy);
      updateHeader();
    });

    on("cleared", function ()
    {
      renderTranscript([]);
    });

    on("user_message", function (item)
    {
      const exists = chatList.querySelector('.msg[data-id="' + CSS.escape(item.id) + '"]');
      if (!exists)
      {
        makeUserMessage(item);
      }
      setBusy(true, "응답 생성 중...");
      scrollToBottom(true);
    });

    on("assistant_start", function (data)
    {
      const shell = makeAssistantShell({ id: data.id, at: new Date().toISOString() });
      state.streams.set(data.id, { shell: shell, content: "", reasoning: "", timer: null, thinkTimer: null });
      setBusy(true, data.round > 1 ? ("작업 진행 중... (라운드 " + data.round + ")") : "응답 생성 중...");
      scrollToBottom();
    });

    on("reasoning_delta", function (data)
    {
      const stream = state.streams.get(data.id);
      if (!stream)
      {
        return;
      }
      stream.reasoning += data.text;

      // Rewriting the whole block on every delta is quadratic in the length of
      // the reasoning, and a long think made the tab crawl. Batch like content.
      if (state.config && state.config.showThinking && !stream.thinkTimer)
      {
        stream.thinkTimer = setTimeout(function ()
        {
          stream.thinkTimer = null;
          stream.shell.think.hidden = false;
          stream.shell.think.querySelector(".think-title").textContent = "생각 중... (" + stream.reasoning.length + "자)";
          const body = stream.shell.think.querySelector(".think-body");
          body.textContent = stream.reasoning;
          body.scrollTop = body.scrollHeight;
          scrollToBottom();
        }, 80);
      }
    });

    on("content_delta", function (data)
    {
      const stream = state.streams.get(data.id);
      if (!stream)
      {
        return;
      }
      stream.content += data.text;

      if (!stream.timer)
      {
        stream.timer = setTimeout(function ()
        {
          stream.timer = null;
          stream.shell.bubble.innerHTML = renderMarkdown(stream.content);
          scrollToBottom();
        }, 60);
      }
    });

    on("assistant_end", function (item)
    {
      const stream = state.streams.get(item.id);
      if (!stream)
      {
        const shell = makeAssistantShell(item);
        renderAssistantFinal(shell, item);
        scrollToBottom();
        return;
      }
      if (stream.timer)
      {
        clearTimeout(stream.timer);
        stream.timer = null;
      }
      if (stream.thinkTimer)
      {
        clearTimeout(stream.thinkTimer);
        stream.thinkTimer = null;
      }
      renderAssistantFinal(stream.shell, item);
      state.streams.delete(item.id);
      scrollToBottom();
    });

    on("tool_call", function (item)
    {
      makeToolCard(item);
      setBusy(true, (TOOL_ICONS[item.name] || "🔧") + " " + item.name + " 실행 중...");
      scrollToBottom();
    });

    on("tool_result", function (item)
    {
      applyToolResult(item);
      scrollToBottom();
    });

    on("approval_request", function (info)
    {
      makeApproval(info);
      setBusy(true, "승인을 기다리는 중...");
    });

    on("approval_resolved", function (data)
    {
      markApprovalResolved(data.id, data.approved, data.reason);
    });

    on("notice", function (item)
    {
      makeNotice(item);
      scrollToBottom();
    });

    on("turn_end", function ()
    {
      setBusy(false);
      const ids = Array.from(state.streams.keys());
      for (let i = 0; i < ids.length; i++)
      {
        const stream = state.streams.get(ids[i]);
        if (stream)
        {
          stream.shell.bubble.classList.remove("streaming");
        }
      }
      state.streams.clear();
      scrollToBottom();
    });
  }

  // ------------------------------------------------------------- composer

  function autoGrow()
  {
    input.style.height = "auto";
    input.style.height = Math.min(168, input.scrollHeight) + "px";
  }

  async function send()
  {
    const text = input.value.trim();
    if (!text || state.busy)
    {
      return;
    }

    input.value = "";
    autoGrow();
    updateSendEnabled();

    try
    {
      await api("/api/chat", { method: "POST", body: JSON.stringify({ text: text }) });
    }
    catch (err)
    {
      setStatus("전송 실패: " + err.message, "error");
      input.value = text;
      autoGrow();
      updateSendEnabled();
    }
  }

  input.addEventListener("input", function ()
  {
    autoGrow();
    updateSendEnabled();
  });

  input.addEventListener("keydown", function (ev)
  {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing)
    {
      ev.preventDefault();
      send();
    }
  });

  btnSend.addEventListener("click", send);

  btnStop.addEventListener("click", async function ()
  {
    try
    {
      await api("/api/cancel", { method: "POST" });
    }
    catch (err)
    {
      setStatus("중단 실패: " + err.message, "error");
    }
  });

  el("btnClear").addEventListener("click", async function ()
  {
    if (!confirm("이 작업 폴더의 대화 내용을 모두 지울까요?"))
    {
      return;
    }
    try
    {
      await api("/api/clear", { method: "POST" });
    }
    catch (err)
    {
      setStatus("초기화 실패: " + err.message, "error");
    }
  });

  // -------------------------------------------------------------- settings

  const settingsOverlay = el("settingsOverlay");
  const folderOverlay = el("folderOverlay");

  function openSettings()
  {
    const cfg = state.config || {};
    el("inpBaseUrl").value = cfg.baseUrl || "http://localhost:1234";
    el("inpTemperature").value = cfg.temperature;
    el("inpMaxTokens").value = cfg.maxTokens;
    el("inpContextTokens").value = cfg.contextTokens;
    el("inpMaxRounds").value = cfg.maxToolRounds;
    el("inpTopP").value = cfg.topP;
    el("inpTopK").value = cfg.topK;
    el("inpPresencePenalty").value = cfg.presencePenalty;
    const effortSel = el("selReasoningEffort");
    effortSel.value = cfg.reasoningEffort || "default";
    // A value the select does not know lands as an empty selection; fall back
    // to the model default instead of saving an empty string.
    if (!effortSel.value)
    {
      effortSel.value = "default";
    }
    el("selPermissionMode").value = cfg.permissionMode || "ask";
    showPermissionHint(el("selPermissionMode").value);
    el("chkShowThinking").checked = !!cfg.showThinking;
    el("inpCodingRules").value = (typeof cfg.codingRules === "string") ? cfg.codingRules : "";
    defaultCodingRules = cfg.defaultCodingRules || defaultCodingRules;
    el("inpSystemPrompt").value = cfg.systemPrompt || "";
    el("inpTavilyKey").value = "";
    tavilyCleared = false;
    showTavilyState(cfg.webSearch);
    el("dataDirLabel").textContent = (cfg.dataDir || "-") + (cfg.portable ? "  (포터블)" : "");
    el("logPathHint").textContent = cfg.logPath ? ("로그: " + cfg.logPath) : "";
    updateContextHint();
    el("settingsState").textContent = "";
    el("settingsState").className = "save-state";

    settingsOverlay.hidden = false;
    loadModels(false);
  }

  function fillModelSelect(models, selected)
  {
    const sel = el("selModel");
    sel.innerHTML = "";

    if (models.length === 0)
    {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "사용 가능한 모델이 없습니다";
      sel.appendChild(opt);
      return;
    }

    for (let i = 0; i < models.length; i++)
    {
      const m = models[i];
      const opt = document.createElement("option");
      opt.value = m.id;

      const bits = [];
      if (m.state === "loaded")
      {
        bits.push("로드됨");
      }
      if (m.quantization)
      {
        bits.push(m.quantization);
      }
      if (m.capabilities && m.capabilities.indexOf("tool_use") >= 0)
      {
        bits.push("tool");
      }
      opt.textContent = m.id + (bits.length > 0 ? "  [" + bits.join(" / ") + "]" : "");
      sel.appendChild(opt);
    }

    const target = selected || "";
    const has = models.some(function (m)
    {
      return m.id === target;
    });
    sel.value = has ? target : models[0].id;
    updateModelHint();
  }

  function updateModelHint()
  {
    const id = el("selModel").value;
    const found = state.models.filter(function (m)
    {
      return m.id === id;
    })[0];
    const hint = el("modelHint");

    if (!found)
    {
      hint.textContent = "";
      return;
    }

    const parts = [];
    parts.push(found.state === "loaded" ? "LM Studio에 로드되어 있습니다" : "선택 시 LM Studio가 자동 로드합니다");
    if (found.capabilities && found.capabilities.indexOf("tool_use") >= 0)
    {
      parts.push("tool_use 지원");
    }
    else
    {
      parts.push("tool_use 미표기 - 파일 작업이 제한될 수 있습니다");
    }
    if (found.loadedContext)
    {
      parts.push("컨텍스트 " + found.loadedContext.toLocaleString() + " 토큰");
    }
    else if (found.maxContext)
    {
      parts.push("최대 컨텍스트 " + found.maxContext.toLocaleString() + " 토큰");
    }

    hint.textContent = parts.join(" · ");
    hint.className = "hint" + (found.state === "loaded" ? " ok" : "");
    updateContextHint();
  }

  // The conversation budget plus one reply has to fit inside the context LM
  // Studio actually loaded. Over that line the server drops the front of the
  // request, which looks exactly like the model ignoring its instructions.
  function updateContextHint()
  {
    const hint = el("contextHint");
    if (!hint)
    {
      return;
    }

    const id = el("selModel").value;
    const found = state.models.filter(function (m)
    {
      return m.id === id;
    })[0];

    const limit = found ? (found.loadedContext || found.maxContext || 0) : 0;
    const context = parseInt(el("inpContextTokens").value, 10) || 0;
    const reply = parseInt(el("inpMaxTokens").value, 10) || 0;

    if (!limit || !context)
    {
      hint.textContent = "";
      hint.className = "hint";
      return;
    }

    // The tool schema is on the wire with every request too, so leaving it out
    // of this sum showed a comfortable green while the real request was over
    // the model's context by thousands of tokens.
    const schema = (state.config && state.config.schemaTokens) || 0;
    const needed = context + reply + schema;
    if (needed > limit)
    {
      const suggested = Math.max(4000, Math.floor((limit - reply - schema) * 0.9 / 1000) * 1000);
      hint.textContent = "대화 예산 " + context.toLocaleString() + " + 응답 " + reply.toLocaleString() +
        (schema ? " + 도구 스키마 " + schema.toLocaleString() : "") +
        " = " + needed.toLocaleString() + " 토큰이 이 모델의 컨텍스트 " + limit.toLocaleString() +
        " 토큰을 넘습니다. 요청 앞부분이 잘려 나갑니다. 대화 예산을 " + suggested.toLocaleString() + " 이하로 낮춰 주세요.";
      hint.className = "hint err";
      return;
    }

    // The warning above only fires when the numbers do not fit. Leaving a large
    // part of the model's context unused is the other way to get a worse answer,
    // and it is invisible: the conversation just loses its older turns sooner.
    const spare = limit - needed;
    const roomy = spare > 2000
      ? "  " + spare.toLocaleString() + " 토큰이 남습니다. 대화 예산을 " +
        (Math.floor((context + spare * 0.9) / 1000) * 1000).toLocaleString() + " 까지 올리면 " +
        "더 긴 대화를 유지합니다."
      : "";

    hint.textContent = "대화 예산 + 응답" + (schema ? " + 스키마" : "") + " = " + needed.toLocaleString() +
      " / 모델 컨텍스트 " + limit.toLocaleString() + " 토큰" + roomy;
    hint.className = "hint ok";
  }

  async function loadModels(explicit)
  {
    const hint = el("baseUrlHint");
    const baseUrl = el("inpBaseUrl").value.trim() || "http://localhost:1234";

    hint.textContent = "모델 목록을 불러오는 중...";
    hint.className = "hint";

    try
    {
      const data = await api("/api/models?baseUrl=" + encodeURIComponent(baseUrl));
      if (!data.ok)
      {
        throw new Error(data.error || "연결 실패");
      }

      state.models = data.models || [];
      fillModelSelect(state.models, (state.config && state.config.model) || "");
      hint.textContent = "연결 성공: " + data.baseUrl + " (" + state.models.length + "개 모델)";
      hint.className = "hint ok";
    }
    catch (err)
    {
      state.models = [];
      fillModelSelect([], "");
      hint.textContent = "연결 실패: " + err.message + " - LM Studio에서 Local Server를 켜 두었는지 확인하세요.";
      hint.className = "hint err";
      if (explicit)
      {
        el("settingsState").textContent = "";
      }
    }
  }

  // The saved key never comes back to the page, so an empty box means "keep
  // what is saved" and clearing it takes the explicit button.
  let tavilyCleared = false;

  function showTavilyState(info)
  {
    const box = el("inpTavilyKey");
    const configured = !!(info && info.configured) && !tavilyCleared;
    box.placeholder = configured ? ("저장된 키: " + info.keyHint + " (바꾸려면 새 키 입력)") : "tvly-...";
    el("btnClearTavily").hidden = !configured;
    const hint = el("tavilyHint");
    hint.className = "hint" + (configured ? " ok" : "");
    hint.textContent = configured
      ? "웹 검색이 켜져 있습니다. 모델이 web_search / web_fetch 를 쓸 수 있습니다."
      : (tavilyCleared
        ? "저장하면 키가 삭제되고 웹 검색이 꺼집니다."
        : "키를 넣으면 모델이 web_search / web_fetch 로 문서와 오류 메시지를 찾아볼 수 있습니다. 키는 tavily.com 에서 발급받습니다.");
  }

  el("btnClearTavily").addEventListener("click", function ()
  {
    tavilyCleared = true;
    el("inpTavilyKey").value = "";
    showTavilyState(state.config && state.config.webSearch);
  });

  el("btnTestTavily").addEventListener("click", async function ()
  {
    const hint = el("tavilyHint");
    hint.textContent = "Tavily 에 확인하는 중...";
    hint.className = "hint";
    try
    {
      const data = await api("/api/websearch/test",
        { method: "POST", body: JSON.stringify({ tavilyApiKey: el("inpTavilyKey").value.trim() }) });
      if (data.ok)
      {
        hint.textContent = "키가 동작합니다 (" + data.keyHint + ")." +
          (el("inpTavilyKey").value.trim() ? " 저장을 눌러야 적용됩니다." : "");
        hint.className = "hint ok";
      }
      else
      {
        hint.textContent = "확인 실패: " + (data.error || "알 수 없는 오류");
        hint.className = "hint err";
      }
    }
    catch (err)
    {
      hint.textContent = "확인 실패: " + err.message;
      hint.className = "hint err";
    }
  });

  el("btnResetRules").addEventListener("click", function ()
  {
    const box = el("inpCodingRules");
    box.value = defaultCodingRules;
    box.focus();
  });
  el("btnSettings").addEventListener("click", openSettings);
  el("btnCloseSettings").addEventListener("click", function ()
  {
    settingsOverlay.hidden = true;
  });
  el("btnLoadModels").addEventListener("click", function ()
  {
    loadModels(true);
  });
  el("selModel").addEventListener("change", updateModelHint);
  el("inpContextTokens").addEventListener("input", updateContextHint);
  el("inpMaxTokens").addEventListener("input", updateContextHint);

  el("btnShutdown").addEventListener("click", async function ()
  {
    if (!window.confirm("서버를 종료할까요? 진행 중인 작업이 있으면 중단됩니다."))
    {
      return;
    }

    // Not named "state": that is the module level app state object, and
    // shadowing it here is a trap for the next edit in this handler.
    const label = el("settingsState");
    label.textContent = "종료 중...";
    label.className = "save-state";

    try
    {
      await fetch("/api/shutdown", { method: "POST" });
    }
    catch (err)
    {
      // The server can close the socket before the response lands, which is
      // exactly what a successful shutdown looks like from here.
    }

    label.textContent = "서버가 종료되었습니다. 이 탭은 닫아도 됩니다.";
    label.className = "save-state ok";
    el("btnShutdown").disabled = true;
  });

  el("btnSaveSettings").addEventListener("click", async function ()
  {
    const stateEl = el("settingsState");
    const payload =
    {
      baseUrl: el("inpBaseUrl").value.trim(),
      model: el("selModel").value,
      temperature: parseFloat(el("inpTemperature").value),
      maxTokens: parseInt(el("inpMaxTokens").value, 10),
      contextTokens: parseInt(el("inpContextTokens").value, 10),
      maxToolRounds: parseInt(el("inpMaxRounds").value, 10),
      topP: parseFloat(el("inpTopP").value),
      topK: parseInt(el("inpTopK").value, 10),
      presencePenalty: parseFloat(el("inpPresencePenalty").value),
      reasoningEffort: el("selReasoningEffort").value,
      permissionMode: el("selPermissionMode").value,
      showThinking: el("chkShowThinking").checked,
      codingRules: el("inpCodingRules").value,
      systemPrompt: el("inpSystemPrompt").value
    };

    const typedKey = el("inpTavilyKey").value.trim();
    if (typedKey)
    {
      payload.tavilyApiKey = typedKey;
    }
    else if (tavilyCleared)
    {
      payload.tavilyApiKey = "";
    }

    // An emptied field is "leave it unchanged", not zero. parseFloat/parseInt
    // give NaN there and JSON.stringify would send null, which the server would
    // otherwise clamp to the bottom of the field's range.
    const numericFields =
      ["temperature", "maxTokens", "contextTokens", "maxToolRounds", "topP", "topK", "presencePenalty"];
    for (let i = 0; i < numericFields.length; i++)
    {
      if (!Number.isFinite(payload[numericFields[i]]))
      {
        delete payload[numericFields[i]];
      }
    }

    try
    {
      const data = await api("/api/config", { method: "POST", body: JSON.stringify(payload) });
      state.config = data.config;
      updateHeader();
      stateEl.textContent = "저장했습니다";
      stateEl.className = "save-state ok";
      setTimeout(function ()
      {
        settingsOverlay.hidden = true;
      }, 500);
    }
    catch (err)
    {
      stateEl.textContent = "저장 실패: " + err.message;
      stateEl.className = "save-state err";
    }
  });

  // ---------------------------------------------------------------- folder

  function openFolder()
  {
    const ws = state.workspace || {};
    el("currentFolder").textContent = ws.path || "미등록";
    el("inpFolder").value = ws.path || "";
    el("folderState").textContent = "";
    el("folderState").className = "save-state";

    const list = el("recentList");
    list.innerHTML = "";
    const recents = (state.config && state.config.recentWorkspaces) || [];

    if (recents.length === 0)
    {
      const empty = document.createElement("div");
      empty.className = "recent-empty";
      empty.textContent = "최근 사용한 폴더가 없습니다.";
      list.appendChild(empty);
    }
    else
    {
      for (let i = 0; i < recents.length; i++)
      {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "recent-item";
        item.textContent = recents[i];
        item.addEventListener("click", function ()
        {
          el("inpFolder").value = item.textContent;
        });
        list.appendChild(item);
      }
    }

    folderOverlay.hidden = false;
  }

  async function applyFolder(dir)
  {
    const stateEl = el("folderState");
    try
    {
      const data = await api("/api/workspace", { method: "POST", body: JSON.stringify({ path: dir }) });
      state.workspace = data.workspace;
      state.config = data.config;
      renderTranscript(data.transcript || []);
      setBusy(!!data.busy);
      updateHeader();

      // A risky root is worth stopping on. Keep the sheet open so the choice is
      // made deliberately rather than dismissed by the auto close.
      if (data.workspace && data.workspace.risk)
      {
        stateEl.textContent = data.workspace.risk.message;
        stateEl.className = "save-state err";
        return;
      }

      stateEl.textContent = "설정했습니다";
      stateEl.className = "save-state ok";
      setTimeout(function ()
      {
        folderOverlay.hidden = true;
      }, 400);
    }
    catch (err)
    {
      stateEl.textContent = err.message;
      stateEl.className = "save-state err";
    }
  }

  el("btnFolder").addEventListener("click", openFolder);
  el("workspaceChip").addEventListener("click", openFolder);
  el("btnCloseFolder").addEventListener("click", function ()
  {
    folderOverlay.hidden = true;
  });

  el("btnBrowse").addEventListener("click", async function ()
  {
    const hint = el("folderHint");
    hint.textContent = "폴더 선택 창을 여는 중입니다...";
    hint.className = "hint";

    try
    {
      const data = await api("/api/workspace/pick", { method: "POST" });
      if (data.ok && data.path)
      {
        el("inpFolder").value = data.path;
        hint.textContent = "선택됨: " + data.path;
        hint.className = "hint ok";
      }
      else if (data.reason === "cancelled")
      {
        hint.textContent = "선택이 취소되었습니다. 경로를 직접 입력할 수도 있습니다.";
        hint.className = "hint";
      }
      else if (data.reason === "already_open")
      {
        hint.textContent = data.message;
        hint.className = "hint";
      }
      else
      {
        hint.textContent = "폴더 선택 창을 열 수 없습니다: " + (data.message || data.reason) + " 경로를 직접 입력할 수도 있습니다.";
        hint.className = "hint err";
      }
    }
    catch (err)
    {
      hint.textContent = "폴더 선택 실패: " + err.message;
      hint.className = "hint err";
    }
  });

  el("btnApplyFolder").addEventListener("click", function ()
  {
    applyFolder(el("inpFolder").value.trim());
  });

  el("inpFolder").addEventListener("keydown", function (ev)
  {
    if (ev.key === "Enter")
    {
      ev.preventDefault();
      applyFolder(el("inpFolder").value.trim());
    }
  });

  [settingsOverlay, folderOverlay].forEach(function (overlay)
  {
    overlay.addEventListener("click", function (ev)
    {
      if (ev.target === overlay)
      {
        overlay.hidden = true;
      }
    });
  });

  document.addEventListener("keydown", function (ev)
  {
    if (ev.key === "Escape")
    {
      settingsOverlay.hidden = true;
      folderOverlay.hidden = true;
    }
  });

  // Copy buttons are created by re-rendered markdown, so delegate instead of binding.
  chatList.addEventListener("click", function (ev)
  {
    const btn = ev.target.closest(".copy-btn");
    if (!btn)
    {
      return;
    }

    const head = btn.closest(".code-head");
    const pre = head ? head.nextElementSibling : null;
    const code = pre ? pre.querySelector("code") : null;
    if (!code)
    {
      return;
    }

    navigator.clipboard.writeText(code.textContent).then(function ()
    {
      btn.textContent = "복사됨";
      setTimeout(function ()
      {
        btn.textContent = "복사";
      }, 1200);
    }).catch(function ()
    {
      btn.textContent = "실패";
    });
  });

  // ------------------------------------------------------------------ boot

  loadState().then(function ()
  {
    connectEvents();
  });
})();
