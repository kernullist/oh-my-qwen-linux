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
    chmod +x start.sh build.sh
    ./start.sh

The UI listens on http://127.0.0.1:8787/. Use ./start.sh --no-open on a headless machine or ./start.sh --port 9000 to select another port.

Load a model and start Developer > Local Server in LM Studio. Select the endpoint and model in settings, then register a workspace such as /home/user/projects/my-app. To reach LM Studio on another machine, enter its address, for example http://192.168.1.28:1234, and enable "Serve on Local Network" there.

## Model settings

Defaults follow Qwen's thinking-mode sampling for the Qwen3.8 class: temperature 0.6, top_p 0.95, top_k 20, presence_penalty 0, an 8192-token reply and a 65536-token conversation budget. Keep the budget plus the reply below the context length LM Studio actually loaded; the settings screen checks this against the loaded model.

The reasoning setting is sent as reasoning_effort. LM Studio accepts none, minimal, low, medium, high and xhigh, but Qwen3.8 reports its reasoning as on/off only, so "none" (끄기) is the only value that changes anything: it switches thinking off for fast, cheap turns. Within one request the model's reasoning is passed back between tool rounds, as Qwen's templates expect for interleaved thinking, and dropped at the next request.

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

## Tests

These suites do not require LM Studio:

    npm test
    npm run test:native
    npm run test:http

The scenario suite does use LM Studio:

    npm run test:scenarios

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

See README.ko.md for the Korean guide.
