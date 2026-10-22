# oh-my-qwen for Ubuntu

An Ubuntu port of oh-my-qwen: a local web UI that turns a tool-capable Qwen model in LM Studio into a coding agent for one registered workspace.

## Requirements and startup

- Ubuntu 22.04 or newer; 24.04 is recommended
- Node.js 20 or newer
- LM Studio 0.4.8 or newer with a tool-capable model (older versions work, but ignore the reasoning setting)
- Optional folder dialog: zenity or kdialog
- For C/C++: build-essential, plus cmake and ninja-build when needed

    sudo apt update
    sudo apt install -y build-essential cmake ninja-build zenity
    ./start.sh

The UI listens on http://127.0.0.1:8787/. Use ./start.sh --no-open on a headless machine or ./start.sh --port 9000 to select another port.

Load a model and start Developer > Local Server in LM Studio. Select the endpoint and model in settings, then register a workspace such as /home/user/projects/my-app. To reach LM Studio on another machine, enter its address, for example http://192.168.1.28:1234, and enable "Serve on Local Network" there.

## Model settings

Defaults follow Qwen's thinking-mode sampling for the Qwen3.8 class: temperature 0.6, top_p 0.95, top_k 20, presence_penalty 0, an 8192-token reply and a 65536-token conversation budget. Keep the budget plus the reply below the context length LM Studio actually loaded; the settings screen checks this against the loaded model.

The reasoning setting is sent as reasoning_effort. LM Studio accepts none, minimal, low, medium, high and xhigh, but Qwen3.8 reports its reasoning as on/off only, so "none" (끄기) is the only value that changes anything: it switches thinking off for fast, cheap turns. Within one request the model's reasoning is passed back between tool rounds, as Qwen's templates expect for interleaved thinking, and dropped at the next request.

## Web search

Enter a Tavily API key (from tavily.com) in settings to give the model two more tools: web_search returns titles, URLs and snippets, and web_fetch reads pages, optionally only the parts relevant to a question. The "키 확인" button checks a key with one search. Without a key the tools are not offered at all, so they cost nothing.

The key is stored in config.json, which is written with owner-only permissions (0600), and is never sent back to the browser; the settings screen only shows a hint such as tvly-dev-…1234. Leave the field empty to keep the saved key, or use "키 삭제" to remove it.

Searching needs no approval because it changes nothing on the machine, but queries do leave it, so the model is told never to put secrets or private code into a query. Web results are labelled as untrusted data, and the model is told to cite its sources and never follow instructions found in a page. OMQ_TAVILY_URL points the client at a different endpoint, for a proxy or for tests.

## Context and history

Each request carries the system prompt, the tool schema and as much of the conversation as fits the conversation budget. The app learns how many real tokens its estimate corresponds to from the prompt_tokens LM Studio reports, so code-heavy turns, which tokenize far more densely than prose, still stay inside the budget. Hover over a reply's time to see its real input, output and reasoning token counts.

When a long turn no longer fits, the oldest tool results go first, but the request that started the turn is always kept, and the model is told that earlier steps were dropped. Tool call arguments that were cut off by the reply limit are sent back as an empty object, so one truncated reply cannot make LM Studio reject the rest of the conversation.

Configuration is stored under XDG_CONFIG_HOME/oh-my-qwen, or ~/.config/oh-my-qwen when XDG_CONFIG_HOME is unset. OMQ_DATA_DIR overrides it.

## Ubuntu behavior

- Commands run in a fresh non-interactive /bin/bash with pipefail. Git prompts and pagers are disabled.
- A command that leaves a job in the background returns as soon as the shell exits; the job keeps running.
- A crash is reported by signal (SIGSEGV, SIGABRT, SIGFPE, ...) with a short diagnosis instead of an unknown exit code.
- Timeout and cancellation kill the complete child process group.
- CMake uses Ninja when available and Unix Makefiles otherwise.
- Source-only C/C++ folders use GCC or Clang, and built ELF files can be found and run.
- Bash build scripts, Make, Node.js, Python, Go, Rust, .NET, and CMake projects are detected. Python runs through python3 when there is no python command, which is the Ubuntu default.
- GNU ld failures (undefined reference, cannot find -lfoo) and CMake errors are listed as build errors.
- POSIX absolute paths, parent traversal, HOME references, and tilde paths outside the workspace are surfaced on approval cards.
- Filesystem roots, system trees, and the home directory produce a workspace-scope warning.
- New Linux files do not receive a Windows-oriented UTF-8 BOM; existing encoding, BOM, and line endings remain preserved.
- The folder picker uses zenity and then kdialog. Paths can always be typed manually.
- Browser opening uses xdg-open; failure does not stop the server.

## Approvals and safety

Listing, reading, searching and web search always run immediately. Everything that changes the machine follows the permission mode, chosen next to the message box or in settings:

| Mode | Runs without asking | Still asks |
|---|---|---|
| 확인 (ask, default) | nothing | every write, edit, delete, build, run, test and command |
| 편집 자동 (edits) | write, edit, bulk replace and create_dir inside the folder | delete, commands, build, run, test |
| 자동 (auto) | everything inside the working folder | a command that reaches outside the folder or rewrites a binary file through the shell |
| 전체 자동 (full) | everything | nothing; choosing it asks for confirmation once |

The mode applies from the next action on, even in the middle of a turn: switching to a more permissive mode also releases an approval card that the new mode would not have shown. The system prompt tells the model which mode it is in; in full mode it is told that nobody checks its actions first. A config saved with the old autoApprove checkbox becomes auto.

In every mode the file tools refuse paths that leave the workspace, including through symbolic links. When an approval is denied, later state-changing calls from the same batch are not run either: they were planned on the denied call succeeding, so the model has to re-plan from what actually happened.

## Tests

These suites do not require LM Studio:

    npm test
    npm run test:native
    npm run test:http

The scenario suite drives the real agent loop against LM Studio on throwaway projects and then checks the files on disk:

    npm run test:scenarios
    node tests/run.js --list
    node tests/run.js --base http://192.168.1.28:1234 --model qwen3.8-27b --only approval-denied,cleanup-delete --repeat 3

Other options: --tags, --rounds, --max-tokens, --context, --turn-timeout, --keep, --verbose, --out, --save-baseline and --no-baseline. Scenarios whose tools are missing are skipped, for example cmake, go, dotnet, pytest (python3 -m pytest) or pwsh for the PowerShell checks. Results are judged against tests/reports/baseline.json, so a scenario that is known to be flaky does not turn the run red.

## Portable build

Build the portable folder and Node SEA executable with a native Linux Node.js runtime:

    ./build.sh

Options:

    ./build.sh --folder
    ./build.sh --exe
    ./build.sh --no-archive
    ./build.sh --out /tmp/omq-dist

The build launches each artifact on a temporary port and verifies the API plus HTML, CSS, and JavaScript assets. Outputs are written under dist/ as a portable folder, a single executable, and linux-x64 tar.gz archives.

The portable marker stores configuration and sessions in a sibling data/ directory. Remove portable.txt and data/ to use the normal XDG configuration directory.

## Troubleshooting

- node not found: install Node.js 20 or newer.
- No xdg-open: start with --no-open and open the printed URL yourself.
- No folder dialog: install zenity or kdialog, or type the path.
- Cannot reach LM Studio: check that the Local Server is running, the port, and that a model is loaded. For another machine, enable "Serve on Local Network" in LM Studio.
- Web search fails: "키 확인" in settings names the cause. 401 means a wrong key, 429 a rate limit, 432 or 433 a used-up credit limit.
- Empty replies that used the whole token limit on thinking: set the reasoning setting to off (none) rather than raising the limit; a larger limit mostly produces more thinking.
- pytest missing: Ubuntu blocks pip in the system Python. Install python3-pytest with apt or use a virtual environment; the model is told when pytest is absent and verifies with plain Python instead.
- No C/C++ compiler: sudo apt install build-essential.
- Permission denied on start.sh or build.sh: run chmod +x on them, or start with bash start.sh.
- Logs: ~/.config/oh-my-qwen/oh-my-qwen.log, or data/oh-my-qwen.log in a portable build.

## Layout

    server.js          local HTTP/SSE server
    src/agent.js       agent loop, history trimming and the system prompt
    src/lmstudio.js    LM Studio client, streaming and inline tool call recovery
    src/tools.js       file tools, Bash execution and path protection
    src/websearch.js   Tavily client for web_search and web_fetch
    src/project.js     project detection and build/run/test commands
    src/toolchain.js   GCC/Clang/CMake/Ninja/Make detection
    src/session.js     per-workspace chat history
    src/config.js      settings, XDG and portable data paths
    src/picker.js      zenity/kdialog folder picker
    public/            web UI
    tests/             unit, HTTP, native and scenario tests
    build.js           portable folder and Node SEA build

See README.ko.md for the Korean guide.
