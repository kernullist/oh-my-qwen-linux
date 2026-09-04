# oh-my-qwen for Ubuntu

An Ubuntu port of oh-my-qwen: a local web UI that turns a tool-capable Qwen model in LM Studio into a coding agent for one registered workspace.

## Requirements and startup

- Ubuntu 22.04 or newer; 24.04 is recommended
- Node.js 20 or newer
- LM Studio with a tool-capable model
- Optional folder dialog: zenity or kdialog
- For C/C++: build-essential, plus cmake and ninja-build when needed

    sudo apt update
    sudo apt install -y build-essential cmake ninja-build zenity
    chmod +x start.sh build.sh
    ./start.sh

The UI listens on http://127.0.0.1:8787/. Use ./start.sh --no-open on a headless machine or ./start.sh --port 9000 to select another port.

Load a model and start Developer > Local Server in LM Studio. Select the endpoint and model in settings, then register a workspace such as /home/user/projects/my-app.

Configuration is stored under XDG_CONFIG_HOME/oh-my-qwen, or ~/.config/oh-my-qwen when XDG_CONFIG_HOME is unset. OMQ_DATA_DIR overrides it.

## Ubuntu behavior

- Commands run in a fresh non-interactive /bin/bash with pipefail.
- Timeout and cancellation kill the complete child process group.
- CMake uses Ninja when available and Unix Makefiles otherwise.
- Source-only C/C++ folders use GCC or Clang, and built ELF files can be found and run.
- Bash build scripts, Make, Node.js, Python, Go, Rust, .NET, and CMake projects are detected.
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
