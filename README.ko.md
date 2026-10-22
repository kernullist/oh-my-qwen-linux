# oh-my-qwen for Ubuntu

LM Studio의 Qwen 계열 모델을 로컬 코딩 에이전트로 사용하는 Ubuntu용 웹 UI다. 등록한 작업 폴더 안에서 파일을 읽고 수정하며 프로젝트를 빌드, 실행, 테스트할 수 있다.

## 요구 사항

- Ubuntu 22.04 이상(24.04 권장)
- Node.js 20 이상
- LM Studio 0.4.8 이상과 tool calling을 지원하는 모델(이전 버전도 동작하지만 '추론 노력' 설정은 무시됨)
- 선택 사항: zenity 또는 kdialog
- C/C++ 작업 시 build-essential, 필요에 따라 cmake와 ninja-build

    sudo apt update
    sudo apt install -y build-essential cmake ninja-build zenity

## 실행

    ./start.sh

또는 npm start를 실행한다. 기본 주소는 http://127.0.0.1:8787/ 이다.

    ./start.sh --no-open
    ./start.sh --port 9000

LM Studio에서 모델을 불러오고 Developer > Local Server를 시작한 뒤, 앱 설정에서 서버 주소와 모델을 선택한다. 상단 폴더 버튼에서 /home/user/projects/app 형태의 작업 폴더를 등록한다.

다른 PC의 LM Studio를 쓰려면 서버 주소에 http://192.168.1.28:1234 처럼 입력하고, LM Studio에서 "Serve on Local Network"를 켠다.

## 모델 설정

기본값은 Qwen3.8 계열의 thinking 모드 권장값을 따른다: temperature 0.6, top_p 0.95, top_k 20, presence_penalty 0, 응답 8192 토큰, 대화 예산 65536 토큰. 대화 예산과 응답 토큰의 합은 LM Studio에 실제로 로드된 컨텍스트보다 작아야 하며, 설정 화면이 로드된 모델 기준으로 확인해 준다.

'추론 노력'은 reasoning_effort로 전달된다. LM Studio는 none, minimal, low, medium, high, xhigh를 받지만 Qwen3.8은 추론을 켜기/끄기로만 지원하므로 실제로 효과가 있는 값은 '끄기(none)' 하나다. 빠르고 가벼운 작업에서는 끄기를 쓰면 된다. 한 요청 안에서는 모델의 생각 과정을 도구 라운드 사이에 다시 넘겨주고(Qwen 템플릿의 interleaved thinking), 다음 요청부터는 버린다.

## 웹 검색

설정에 Tavily API 키(tavily.com에서 발급)를 넣으면 모델이 도구 두 개를 더 쓸 수 있다. web_search는 제목, URL, 요약을 돌려주고, web_fetch는 페이지 본문을 읽는다(질문을 주면 관련된 부분만). '키 확인'은 검색 한 번으로 키가 동작하는지 확인한다. 키가 없으면 이 도구들은 모델에게 아예 제공되지 않으므로 토큰도 쓰지 않는다.

키는 소유자만 읽을 수 있는 권한(0600)으로 저장되는 config.json에 들어가며 브라우저로는 다시 보내지 않는다. 설정 화면에는 tvly-dev-…1234 같은 힌트만 표시된다. 입력란을 비워 두면 저장된 키가 유지되고, '키 삭제'로 지울 수 있다.

검색은 이 PC의 아무것도 바꾸지 않으므로 승인 없이 실행되지만 검색어는 외부로 나간다. 그래서 모델에게 비밀 값이나 비공개 코드를 검색어에 넣지 말라고 지시한다. 웹 결과에는 신뢰할 수 없는 데이터라는 표시가 붙고, 모델은 출처 URL을 밝히고 페이지 안의 지시는 따르지 않도록 지시받는다. OMQ_TAVILY_URL로 다른 엔드포인트(프록시나 테스트용 서버)를 지정할 수 있다.

## 컨텍스트와 대화 기록

요청마다 시스템 프롬프트, 도구 스키마, 그리고 대화 예산에 들어가는 만큼의 대화 기록이 전달된다. 앱은 LM Studio가 알려주는 prompt_tokens로 자기 추정치가 실제 몇 토큰인지 학습하므로, 산문보다 훨씬 촘촘하게 토큰화되는 코드 위주의 작업에서도 예산을 넘지 않는다. 답변의 시간 표시에 마우스를 올리면 실제 입력·출력·생각 토큰 수를 볼 수 있다.

긴 작업이 예산을 넘으면 오래된 도구 결과부터 잘라내지만, 그 작업을 시작한 사용자 요청은 항상 남기고 앞 단계가 생략되었다는 사실을 모델에게 알린다. 응답 한도에 걸려 잘린 도구 인자는 빈 객체로 바꿔 보내므로, 잘린 응답 하나 때문에 LM Studio가 이후 대화를 모두 HTTP 500으로 거부하는 일이 생기지 않는다.

설정은 XDG_CONFIG_HOME/oh-my-qwen에 저장된다. XDG_CONFIG_HOME이 없으면 ~/.config/oh-my-qwen을 사용한다. OMQ_DATA_DIR을 지정하면 그 경로가 우선한다.

## Ubuntu 포팅 내용

- run_command는 격리된 비대화형 /bin/bash에서 pipefail과 함께 실행된다. git 프롬프트와 pager는 꺼져 있다.
- 백그라운드로 띄운 작업(`./server &`)이 있어도 셸이 끝나면 바로 결과를 돌려주고, 그 작업은 계속 실행된다.
- 프로그램이 죽으면 종료 코드 대신 시그널(SIGSEGV, SIGABRT, SIGFPE 등)과 원인 힌트를 보여준다.
- 타임아웃이나 취소 시 Bash와 그 하위 프로세스 그룹 전체를 종료한다.
- CMake는 Ninja가 있으면 Ninja를, 아니면 Unix Makefiles를 사용한다.
- 빌드 파일이 없는 C/C++ 폴더는 GCC 또는 Clang으로 빌드한다.
- 생성된 ELF 실행 파일을 찾아 run_project로 실행한다.
- build.sh, configure, autogen.sh, Make, Node.js, Python, Go, Rust, .NET을 자동 감지한다. python 명령이 없으면(Ubuntu 기본) python3로 실행한다.
- GNU ld 오류(undefined reference, cannot find -lfoo)와 CMake 오류도 빌드 오류 목록에 표시한다.
- /etc/passwd, 상위 폴더 탐색, HOME 아래 민감 경로 같은 작업 폴더 밖 Bash 경로를 승인 화면에 표시한다.
- /, /etc, /usr, /var, 홈 디렉터리를 작업 폴더로 선택하면 보호 범위 경고를 표시한다.
- 새 Linux 소스에는 Windows용 UTF-8 BOM을 붙이지 않으며 기존 BOM, 인코딩, 줄바꿈은 보존한다.
- zenity를 우선 사용하고 KDE에서는 kdialog로 폴더 선택 창을 연다.
- 브라우저 실행에는 xdg-open을 사용하며 headless 환경에서 실패해도 서버는 유지된다.

## 승인과 안전 장치

목록, 읽기, 검색, 웹 검색은 항상 바로 실행된다. PC를 바꾸는 작업은 입력창 옆이나 설정에서 고르는 권한 모드를 따른다.

| 모드 | 묻지 않고 실행 | 여전히 묻는 작업 |
|---|---|---|
| 확인 (기본값) | 없음 | 모든 쓰기, 수정, 삭제, 빌드, 실행, 테스트, 명령 |
| 편집 자동 | 작업 폴더 안의 파일 쓰기, 수정, 일괄 치환, 폴더 생성 | 삭제, 명령, 빌드, 실행, 테스트 |
| 자동 | 작업 폴더 안의 모든 작업 | 폴더 밖 경로를 건드리거나 바이너리를 셸로 덮어쓰는 명령 |
| 전체 자동 | 모든 작업 | 없음(선택할 때 한 번 확인) |

모드는 턴 도중에도 다음 작업부터 바로 적용된다. 더 넓은 모드로 바꾸면 그 모드에서는 묻지 않았을 승인 카드도 자동으로 허용된다. 시스템 프롬프트가 모델에게 현재 모드를 알려주며, 전체 자동에서는 아무도 확인하지 않는다는 사실을 알린다. 예전 '자동 승인' 체크박스로 저장된 설정은 자동 모드로 바뀐다.

어떤 모드에서도 파일 도구는 심볼릭 링크를 통해 작업 폴더 밖으로 나가는 경로를 거부한다.

승인을 거부하면 같은 묶음으로 요청된 뒤쪽의 변경 작업도 실행하지 않는다. 그 작업들은 거부된 작업이 성공한다는 전제로 계획된 것이므로, 모델은 실제로 일어난 일을 기준으로 다시 계획해야 한다. 예를 들어 폴더 삭제가 거부되면 "폴더를 삭제했다"고 README에 적는 수정도 실행되지 않는다.

## 자동 빌드 감지

| 프로젝트 | 빌드 | 테스트 | 실행 |
|---|---|---|---|
| CMake | configure 후 cmake --build build | ctest | 최신 ELF |
| Make | make | make test | 최신 ELF |
| Node.js | npm run build | npm test | npm start |
| Python | 없음 | python3 -m pytest | main.py 등 |
| Go | go build | go test | go run |
| Rust | cargo build | cargo test | cargo run |
| .NET | dotnet build | dotnet test | dotnet run |
| C/C++ 소스만 존재 | GCC/Clang 직접 빌드 | 없음 | 생성된 ELF |

## 테스트

LM Studio 없이 실행:

    npm test
    npm run test:native
    npm run test:http

LM Studio를 사용하는 시나리오 테스트는 임시 프로젝트에서 실제 에이전트 루프를 돌린 뒤 디스크의 파일을 직접 검사한다:

    npm run test:scenarios
    node tests/run.js --list
    node tests/run.js --base http://192.168.1.28:1234 --model qwen3.8-27b --only approval-denied,cleanup-delete --repeat 3

그 밖의 옵션: --tags, --rounds, --max-tokens, --context, --turn-timeout, --keep, --verbose, --out, --save-baseline, --no-baseline. 필요한 도구가 없는 시나리오는 건너뛴다(cmake, go, dotnet, pytest(python3 -m pytest), PowerShell 검사용 pwsh 등). 결과는 tests/reports/baseline.json과 비교해 판정하므로 원래 가끔 실패하는 시나리오 때문에 전체 실행이 실패로 표시되지는 않는다.

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
- LM Studio 연결 실패: Local Server, 포트, 모델 로드를 확인한다. 다른 PC라면 LM Studio의 "Serve on Local Network"를 켠다.
- 웹 검색 실패: 설정의 '키 확인'이 원인을 알려준다. 401은 잘못된 키, 429는 요청 한도, 432/433은 크레딧 한도 소진이다.
- 생각 과정에 토큰을 다 써서 답변이 비어 있음: 한도를 올리지 말고 '추론 노력'을 '끄기'로 바꾼다. 한도를 올리면 대개 생각만 길어진다.
- pytest 없음: Ubuntu는 시스템 Python에 pip 설치를 막는다. apt로 python3-pytest를 설치하거나 가상환경을 쓴다. pytest가 없으면 모델에게 그 사실이 전달되어 일반 Python 스크립트로 검증한다.
- C/C++ 컴파일러 없음: sudo apt install build-essential을 실행한다.
- 실행 권한 없음: start.sh, build.sh 또는 배포 실행 파일에 chmod +x를 적용하거나 bash start.sh로 실행한다.
- 로그: ~/.config/oh-my-qwen/oh-my-qwen.log 또는 포터블 data/oh-my-qwen.log.

## 구조

    server.js          로컬 HTTP/SSE 서버
    src/agent.js       에이전트 루프, 대화 기록 정리, Ubuntu 시스템 프롬프트
    src/lmstudio.js    LM Studio 클라이언트, 스트리밍, 본문에 섞인 도구 호출 복구
    src/tools.js       파일 도구, Bash 실행, 경로 보호
    src/websearch.js   web_search / web_fetch 용 Tavily 클라이언트
    src/project.js     프로젝트 감지와 작업 명령
    src/toolchain.js   GCC/Clang/CMake/Ninja/Make 감지
    src/session.js     작업 폴더별 대화 기록
    src/config.js      설정, XDG와 포터블 데이터 경로
    src/picker.js      zenity/kdialog 폴더 선택기
    public/            웹 UI
    tests/             단위, HTTP, 네이티브, 시나리오 테스트
    build.js           포터블 폴더와 Node SEA 빌드

영문 문서는 README.md를 참고한다.
