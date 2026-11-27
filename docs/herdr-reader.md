# herdr-reader 구조

Mac에서 도는 작은 Bun 서버와 폰용 웹앱입니다. 서버는 `hc`로 터미널 목록을 따라가고, 에이전트 세션 기록 파일을 읽어 대화 항목(Entry)으로 바꿔 SSE로 보냅니다. 폰에서 보낸 글과 키는 다시 `hc`로 터미널에 넣습니다.

## 데이터 모양

`src/types.ts`에 서버와 앱이 같이 쓰는 모양을 둡니다.

| 타입 | 뜻 |
|---|---|
| `SessionSummary` | 목록 한 줄. 주소, 에이전트 종류, 상태, 위치(Space / Tab), 마지막 문장 |
| `Entry` | 대화 한 항목. `user`, `assistant`(마크다운), `tool`(한 줄 요약과 diff 또는 출력), `screen`(기록이 없을 때 화면 텍스트) |
| `StreamEvent` | SSE로 보내는 것. `sessions`(목록 전체), `entries`(id 기준 덮어쓰기), `reset`(목록 교체) |

도구 결과는 호출과 id로 짝을 맞춥니다. 결과가 오면 같은 id의 `tool` 항목을 다시 보내고, 앱은 그 자리를 갈아 끼웁니다.

## 파일과 역할

| 파일 | 역할 |
|---|---|
| `src/parse/common.ts` | 파서 인터페이스 `TranscriptParser.feed(line)`, `parseAll`, 줄 단위 diff `lineDiff`, 도구 요약 `genericSummary` |
| `src/parse/claude.ts` | `createClaudeParser()`. Claude Code 기록 한 줄을 Entry로 바꿉니다. `isMeta`, `isSidechain`, `isVirtual`(REPL 스크립트 안의 호출), `isCompactSummary`, system-reminder, `<command-*>` 같은 하네스 텍스트를 뺍니다 |
| `src/parse/codex.ts` | `createCodexParser()`. Codex rollout의 `response_item`을 Entry로 바꿉니다. `apply_patch`는 `describePatch`로 파일 목록과 +/- 수, diff를 만듭니다 |
| `src/tail.ts` | `readLastLines`(큰 파일의 끝만 읽기)와 `TailReader`(덧붙은 줄만 읽기). 쓰다 만 줄, 잘린 멀티바이트 문자, 파일 잘림과 교체를 처리합니다 |
| `src/sources.ts` | 에이전트별 레지스트리 `sources`. `locate(terminal)`로 기록 파일을 찾고 `createParser`로 파서를 줍니다 |
| `src/hc.ts` | `hc`를 부르는 유일한 모듈. `parseTerminal`, `getTerminal`, `readScreen`, `send`, `pressKey`, `followTerminals` |
| `src/sessions.ts` | 상태를 묶음으로 나누는 `GROUP_OF`, 목록 순서 `orderSessions`. 앱도 이 파일을 가져다 씁니다 |
| `src/hub.ts` | `Hub`(터미널 상태, 목록 방송, 기록 파일 위치 캐시)와 `Follower`(보고 있는 세션 하나의 기록 따라가기) |
| `src/server.ts` | `Bun.serve` 라우트, 인증과 출처 검사, SSE |
| `web/app.ts`, `web/style.css`, `web/index.html` | 폰 앱. 프레임워크 없이 DOM을 직접 다룹니다 |
| `scripts/make-icons.ts` | `web/public/`의 PNG 아이콘을 그립니다 |
| `scripts/install.sh`, `scripts/uninstall.sh`, `scripts/herdr-reader.plist.template` | LaunchAgent 설치와 제거 |

## 기록 파일 찾기

`src/sources.ts`의 `sources[agent].locate`가 맡습니다. 원격 머신 터미널(`box/t3` 같은 주소)은 파일이 그 머신에 있어서 찾지 않고 화면으로 대신합니다.

- Claude Code: 터미널 foreground pid와 그 아래 프로세스 중 `~/.claude/sessions/<pid>.json`이 있는 것을 찾아 `sessionId`를 읽고, `~/.claude/projects/*/<sessionId>.jsonl`을 엽니다. `CLAUDE_CONFIG_DIR`가 있으면 그 경로를 씁니다
- Codex: 같은 프로세스들에 `lsof`를 걸어 열려 있는 `sessions/YYYY/MM/DD/rollout-*.jsonl`을 찾습니다. 없으면 `session_meta.cwd`가 같은 가장 최근 rollout을 씁니다. `CODEX_HOME`이 있으면 그 경로를 씁니다

`Hub.locate`는 결과를 pid와 상태 변경 시각으로 캐시합니다. `/clear`나 재시작으로 파일이 바뀌면 다음 상태 변화 때 다시 찾고, 보고 있던 화면에는 `reset`을 보냅니다.

## 실시간 갱신

`hc events --json`은 첫 줄에 터미널 전체 스냅숏을 주고, 그 뒤로는 바뀐 터미널 주소만 담은 `event` 알림을 보냅니다. `followTerminals`는 스냅숏을 그대로 반영하고, 알림이 오면 `Hub.onChanged`가 250ms 동안 모은 주소마다 `hc get`으로 전체 상태를 다시 읽습니다.

세션 하나를 보고 있으면 `Follower`가 붙습니다. 처음에 파일 끝 4MB(항목이 모자라면 24MB)를 읽어 파서 상태를 만들고, 그 뒤로는 `fs.watch`와 2초 폴링으로 덧붙은 줄만 읽습니다. 기록 파일이 없으면 2초마다 `hc read`로 화면을 읽어 바뀌었을 때만 보냅니다. 새로 붙은 화면에는 최근 200개 항목을 `reset`으로 줍니다.

## 상태와 입력

| hc 상태 | 묶음 | 표시 | 글 보내기 |
|---|---|---|---|
| `blocked` | 입력 기다림 | 승인 필요 | 막음. 승인 카드의 키 버튼으로 답합니다 |
| `done` | 입력 기다림 | 새 답변 | `hc send` (게이트 없음) |
| `error` | 입력 기다림 | 오류 | `hc send` (게이트 없음) |
| `working` | 작업 중 | 작업 중 | 막음. Esc만 보낼 수 있습니다 |
| `idle` | 끝남 | 대기 | `hc send --if idle` |
| 보고 없음 | 끝남 | 상태 없음 | `hc send` (게이트 없음) |

`hc send --if idle`은 상태가 정확히 `idle`일 때만 들어갑니다. 턴을 마친 세션은 `done`을 보고하는데, 이 경우 `t132 is done, not idle`로 거절되는 것을 확인했습니다. 그래서 `done`은 게이트 없이 보냅니다. hc는 `blocked` 상태에는 `--force` 없이 입력하지 않으므로 승인 대화상자에 글이 잘못 들어가지는 않습니다. 표는 `src/server.ts`의 `SEND_GATE`에 있습니다.

`hc`를 부를 때 `HC_TERMINAL_ID`를 지웁니다. 터미널 안에서 서버를 띄우면 hc가 보낸 글을 그 터미널이 보낸 메모(`<hc from="t12">`)로 감싸기 때문입니다. 그래도 남은 감싸기는 Claude 파서가 벗겨서 보여 줍니다.

## API

| 요청 | 설명 |
|---|---|
| `GET /api/sessions` | `SessionSummary[]`. 에이전트 세션 먼저, 그 안에서 입력 기다림, 작업 중, 끝남 순, 최근 것 먼저 |
| `GET /api/sessions/:address/entries?limit=200` | `Entry[]`. 원격 주소는 `/`를 `%2F`로 씁니다 |
| `GET /api/sessions/:address/screen` | `{ text }`. 터미널 화면 |
| `POST /api/sessions/:address/send` | `{ text }`. 거절되면 409와 한국어 이유 |
| `POST /api/sessions/:address/keys` | `{ key }`. `esc`, `enter`, `ctrl+c`, `up`, `down`, `1`~`9` |
| `GET /api/stream?session=<address>` | SSE. `sessions`, 그리고 session을 주면 `reset`과 `entries` |

`HERDR_READER_ALLOWED_LOGIN`이 있으면 `/api/*`는 `Tailscale-User-Login` 헤더가 같을 때만 답합니다. 정적 파일(HTML, JS, 아이콘)에는 비밀이 없어서 검사하지 않습니다. POST는 `Content-Type: application/json`이어야 하고, `Sec-Fetch-Site: same-origin`이거나 `Origin`의 호스트가 `Host` 또는 `X-Forwarded-Host`와 같아야 합니다.

## 알려진 한계

- 원격 머신 세션은 화면 텍스트로만 봅니다. 기록 파일을 `hc file read --on`으로 가져오는 방법은 아직 넣지 않았습니다
- Codex 파서는 합성 픽스처와 이 Mac에 남은 rollout 파일로만 확인했습니다. 실행 중인 Codex 세션에서 `lsof` 찾기는 확인하지 못했습니다
- Codex rollout을 cwd로 찾을 때는 모든 rollout을 훑습니다. 파일이 수천 개가 되면 느려질 수 있습니다
- 폰에서 세션을 열어도 herdr의 "봤음" 표시는 바뀌지 않습니다. `done` 세션은 데스크톱에서 볼 때까지 입력 기다림에 남습니다
- 웹 푸시 알림은 없습니다
