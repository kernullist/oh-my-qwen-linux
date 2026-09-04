# oh-my-qwen for Ubuntu

LM Studio의 Qwen 계열 모델을 로컬 코딩 에이전트로 사용하는 Ubuntu용 웹 UI다. 등록한 작업 폴더 안에서 파일을 읽고 수정하며 프로젝트를 빌드, 실행, 테스트할 수 있다.

## 요구 사항

- Ubuntu 22.04 이상(24.04 권장)
- Node.js 20 이상
- LM Studio와 tool calling을 지원하는 모델
- 선택 사항: zenity 또는 kdialog
- C/C++ 작업 시 build-essential, 필요에 따라 cmake와 ninja-build

    sudo apt update
    sudo apt install -y build-essential cmake ninja-build zenity

## 실행

    chmod +x start.sh build.sh
    ./start.sh

또는 npm start를 실행한다. 기본 주소는 http://127.0.0.1:8787/ 이다.

    ./start.sh --no-open
    ./start.sh --port 9000

LM Studio에서 모델을 불러오고 Developer > Local Server를 시작한 뒤, 앱 설정에서 서버 주소와 모델을 선택한다. 상단 폴더 버튼에서 /home/user/projects/app 형태의 작업 폴더를 등록한다.

설정은 XDG_CONFIG_HOME/oh-my-qwen에 저장된다. XDG_CONFIG_HOME이 없으면 ~/.config/oh-my-qwen을 사용한다. OMQ_DATA_DIR을 지정하면 그 경로가 우선한다.

## Ubuntu 포팅 내용

- run_command는 격리된 비대화형 /bin/bash에서 pipefail과 함께 실행된다.
- 타임아웃이나 취소 시 Bash와 그 하위 프로세스 그룹 전체를 종료한다.
- CMake는 Ninja가 있으면 Ninja를, 아니면 Unix Makefiles를 사용한다.
- 빌드 파일이 없는 C/C++ 폴더는 GCC 또는 Clang으로 빌드한다.
- 생성된 ELF 실행 파일을 찾아 run_project로 실행한다.
- build.sh, configure, autogen.sh, Make, Node.js, Python, Go, Rust, .NET을 자동 감지한다.
- /etc/passwd, 상위 폴더 탐색, HOME 아래 민감 경로 같은 작업 폴더 밖 Bash 경로를 승인 화면에 표시한다.
- /, /etc, /usr, /var, 홈 디렉터리를 작업 폴더로 선택하면 보호 범위 경고를 표시한다.
- 새 Linux 소스에는 Windows용 UTF-8 BOM을 붙이지 않으며 기존 BOM, 인코딩, 줄바꿈은 보존한다.
- zenity를 우선 사용하고 KDE에서는 kdialog로 폴더 선택 창을 연다.
- 브라우저 실행에는 xdg-open을 사용하며 headless 환경에서 실패해도 서버는 유지된다.

## 승인과 안전 장치

목록, 읽기, 검색은 바로 실행된다. 파일 쓰기, 수정, 삭제, 일괄 치환, 빌드, 실행, 테스트, 임의 Bash 명령은 승인 대상이다.

자동 승인을 켜도 작업 폴더 밖 경로나 바이너리 직접 덮어쓰기는 별도로 표시된다. 파일 도구는 심볼릭 링크를 통해 작업 폴더 밖으로 나가는 경로도 거부한다.

## 자동 빌드 감지

| 프로젝트 | 빌드 | 테스트 | 실행 |
|---|---|---|---|
| CMake | configure 후 cmake --build build | ctest | 최신 ELF |
| Make | make | make test | 최신 ELF |
| Node.js | npm run build | npm test | npm start |
| Python | 없음 | pytest | main.py 등 |
| Go | go build | go test | go run |
| Rust | cargo build | cargo test | cargo run |
| .NET | dotnet build | dotnet test | dotnet run |
| C/C++ 소스만 존재 | GCC/Clang 직접 빌드 | 없음 | 생성된 ELF |

## 테스트

LM Studio 없이 실행:

    npm test
    npm run test:native
    npm run test:http

LM Studio를 사용하는 시나리오 테스트:

    npm run test:scenarios

## Ubuntu 배포 빌드

현재 Linux 아키텍처용 포터블 폴더와 Node SEA 단일 실행 파일을 만든다.

    ./build.sh
    ./build.sh --folder
    ./build.sh --exe
    ./build.sh --no-archive
    ./build.sh --out /tmp/omq-dist

기본 결과는 dist/oh-my-qwen-portable, dist/oh-my-qwen, 두 개의 linux-x64.tar.gz 파일이다. 빌드는 두 결과물을 임시 포트에서 실행해 API와 HTML/CSS/JS 응답을 확인한다.

포터블 결과물은 portable.txt가 있는 동안 실행 파일 옆 data/에 설정과 대화를 저장한다. 일반 XDG 설정 경로를 사용하려면 portable.txt와 data/를 제거한다.

## 문제 해결

- node를 찾지 못함: Node.js 20 이상을 설치한다.
- xdg-open 없음: --no-open으로 실행하고 출력된 URL을 직접 연다.
- 폴더 선택 창 없음: zenity 또는 kdialog를 설치하거나 경로를 직접 입력한다.
- LM Studio 연결 실패: Local Server, 포트, 모델 로드를 확인한다.
- C/C++ 컴파일러 없음: sudo apt install build-essential을 실행한다.
- 실행 권한 없음: start.sh, build.sh 또는 배포 실행 파일에 chmod +x를 적용한다.
- 로그: ~/.config/oh-my-qwen/oh-my-qwen.log 또는 포터블 data/oh-my-qwen.log.

## 구조

    server.js          로컬 HTTP/SSE 서버
    src/agent.js       에이전트 루프와 Ubuntu 시스템 프롬프트
    src/tools.js       파일 도구, Bash 실행, 경로 보호
    src/project.js     프로젝트 감지와 작업 명령
    src/toolchain.js   GCC/Clang/CMake/Ninja/Make 감지
    src/picker.js      zenity/kdialog 폴더 선택기
    src/config.js      XDG와 포터블 데이터 경로
    public/            웹 UI
    tests/             회귀, HTTP, 시나리오 테스트
    build.js           포터블 폴더와 Node SEA 빌드

영문 문서는 README.md를 참고한다.
