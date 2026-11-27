# herdr-reader

herdr에서 돌고 있는 Claude Code와 Codex 세션을 폰 브라우저에서 대화 기록으로 읽고 답하는 웹앱입니다.

터미널 화면을 그대로 옮기지 않습니다. 에이전트가 남기는 세션 기록 파일(jsonl)을 읽어 말풍선, 마크다운 답변, 한 줄로 접힌 도구 호출로 보여 줍니다. 그래서 폰에서도 줄바꿈과 스크롤이 자연스럽습니다. 기록 파일을 찾지 못한 터미널(원격 머신, 일반 셸)은 화면 텍스트를 대신 보여 줍니다.

## 필요한 것

- macOS, [Bun](https://bun.sh) (1.4.3에서 확인)
- herdr와 `hc` CLI (`hc ls`가 동작해야 합니다)
- 폰에서 접속하려면 Tailscale

## 실행

```bash
bun install
bun start            # http://127.0.0.1:7878
```

서버는 `127.0.0.1`에만 붙습니다. 포트는 `HERDR_READER_PORT`로 바꿉니다.

## 폰에서 접속 (Tailscale)

```bash
tailscale serve --bg 7878
tailscale serve status   # https://<이 Mac 이름>.<tailnet>.ts.net 주소가 보입니다
```

폰 Safari에서 그 주소를 열고 공유 메뉴의 "홈 화면에 추가"를 누르면 앱처럼 열립니다.

`tailscale serve`는 요청에 접속한 사람의 Tailscale 로그인을 `Tailscale-User-Login` 헤더로 붙여 줍니다. `HERDR_READER_ALLOWED_LOGIN`에 내 로그인을 넣으면 그 사람의 요청만 받고 나머지는 403으로 막습니다.

```bash
HERDR_READER_ALLOWED_LOGIN=<내 Tailscale 로그인> bun start
```

## 로그인할 때 자동으로 켜기

```bash
HERDR_READER_ALLOWED_LOGIN=<내 Tailscale 로그인> scripts/install.sh
```

LaunchAgent(`~/Library/LaunchAgents/local.herdr-reader.plist`)를 만들고 바로 띄웁니다. 죽으면 launchd가 다시 띄우고, 로그는 `~/Library/Logs/herdr-reader.log`에 쌓입니다. 무엇이 들어갈지만 보려면 `scripts/install.sh --dry-run`을 씁니다. 끄고 지우려면 `scripts/uninstall.sh`를 실행합니다.

## 쓰는 법

- 목록은 입력 기다림, 작업 중, 끝남 순서로 묶입니다. 승인 요청이나 아직 안 본 답변이 있는 세션이 맨 위에 옵니다
- 세션을 누르면 대화가 열리고 새 기록이 실시간으로 붙습니다. 맨 아래를 보고 있을 때만 자동으로 따라 내려갑니다
- 입력창은 에이전트가 쉬고 있을 때만 열립니다. 작업 중에는 "중단 (Esc)"만 누를 수 있습니다
- 승인 요청이 뜨면 터미널 화면 일부와 함께 위, 아래, 선택(Enter), 1~3, 취소(Esc) 버튼이 나옵니다

## 보안

이 서버에 닿는 사람은 누구나 에이전트에게 글을 보내고 키를 누를 수 있습니다. 에이전트가 셸 명령을 실행하는 권한을 가졌다면 그 사람도 사실상 같은 권한을 갖습니다.

- 서버는 `127.0.0.1`에만 붙습니다. 공용 인터넷에 직접 열지 마세요 (`tailscale funnel` 금지)
- `HERDR_READER_ALLOWED_LOGIN`을 꼭 설정하세요. 비워 두면 같은 tailnet의 모든 기기가 들어옵니다
- POST 요청은 JSON이어야 하고 같은 출처에서 와야 합니다. 누를 수 있는 키는 Esc, Enter, Ctrl+C, 위, 아래, 1~9로 한정합니다
- 대화 기록에는 비밀번호나 토큰이 섞여 있을 수 있습니다. 화면을 다른 사람에게 보여 줄 때 조심하세요

## 개발

```bash
bun run dev          # 코드가 바뀌면 다시 띄웁니다
bun test             # 기록 파서와 파일 꼬리 읽기 테스트
bun run typecheck
bun scripts/make-icons.ts   # 앱 아이콘 다시 그리기
```

구조와 동작은 [docs/herdr-reader.md](docs/herdr-reader.md)에 정리했습니다.
