# 전화 (음성 통화)

상태: 설계. 소유자 결정 2026-11-23: 앱 안 통화와 전화망 발신(전화 대행)을 함께 넣고, 음성 엔진은 Realtime과 로컬 둘 다 지원한다. 이 문서가 구현의 기준이며, 구현 중 바뀐 사실은 여기에 먼저 고친다.

## 목표

1. **앱 안 통화.** Mac 앱·웹·iPhone에서 Ghost에게 전화를 건다. 말하면서 끼어들 수 있고, 통화는 그 Ghost의 직접 대화와 같은 대화에 기록된다.
2. **전화 대행.** Ghost가 소유자 대신 실제 전화번호로 전화를 건다. 소유자 승인 없이는 걸지 않는다.
3. 엔진은 설정으로 고른다. 통화 계층(상태·기록·제한·UI)은 하나다.

범위 밖: 전화를 받는 일(수신), 통화 녹음 보관, 영상 통화.

## 이미 있는 것과 없는 것

| 항목 | 현재 |
| --- | --- |
| `apps/ghost-voice-server` | Dyno MLX(`127.0.0.1:7730`)를 부르는 loopback STT/TTS 어댑터. `/v1/audio/transcriptions`, `/v1/audio/speech`(문장 단위 WAV, 500자·60초 상한). 호스트와는 연결돼 있지 않다 |
| `streaming.py`, `serve_streaming.py`, `host_voice_bridge.py` | Pipecat SmallWebRTC 서버. 사라진 `ghost-lifetime/1` 호스트 면(`/api/v1/action`)을 전제로 한다. 현재 Host에는 그 경로가 없으므로 재사용하지 않는다 |
| Host `config.voice` | `{mediaOrigin, controlToken}` 파싱만 하고 어디서도 쓰지 않는다. 새 설계에서는 제거한다 |
| Host WebSocket 수신 | 없다. 바깥으로 거는 클라이언트(CDP)뿐이다 |
| UI 마이크 코드 | 없다 |
| Mac 셸 | 마이크 권한 연결 완료(`Info.plist`, `on_permission_request`) |
| iPhone 셸 | `NSMicrophoneUsageDescription`, `requestMediaCapturePermissionFor` 없음 |
| OpenAI 공급자 | 공급자 카탈로그에 `openai`(API 키) 있음. 음성 키는 이 공급자의 비밀을 쓴다 |

`rea-codex`의 `codex-voice-host`(Rust, WebRTC + Sonora AEC3/AGC2/NS)는 데스크톱 네이티브 오디오 캡처용이다. Ghost는 브라우저/WebView의 `getUserMedia`(에코 제거·잡음 억제 내장)를 쓰므로 가져오지 않는다. 참고할 것은 끼어들기 때 재생 버퍼를 즉시 비우는 방식 하나다.

## 엔진

공통 인터페이스는 "통화 하나"다. 엔진은 말 듣기와 말하기만 맡고, 생각과 도구는 항상 Ghost의 대화(Pi)가 한다.

```mermaid
flowchart LR
  subgraph client[클라이언트: Mac 앱 · 웹 · iPhone]
    mic[마이크 / 스피커]
    ui[통화 화면]
  end
  subgraph host[ghost host]
    call[calls · 상태·제한·기록]
    rt[realtime 어댑터]
    loc[local 어댑터]
    core[Core.sendMessage → Pi 대화]
    pstn[phone 어댑터]
  end
  oai[(OpenAI Live API · gpt-live)]
  vs[ghost-voice-server → Dyno MLX]
  sip[(SIP 트렁크 → 전화망)]
  mic <-->|WebRTC 오디오| oai
  ui -->|SDP 중계 · 통화 명령| call
  call --> rt --> oai
  oai -->|위임 요청| rt --> core
  mic -->|발화 WAV| loc --> vs
  loc --> core
  core -->|답 텍스트| loc --> vs -->|WAV| mic
  call --> pstn --> oai
  oai --> sip
```

### realtime (OpenAI Live API)

- 브라우저가 SDP offer를 만들고 Host가 `POST /v1/live/sessions`(`transport: {type:"webrtc", sdp}`)로 answer를 받아 돌려준다. API 키와 세션 설정은 Host에만 있다.
- `delegation: {type:"client"}`. 음성 모델이 `session.delegation.created`로 위임을 요청하면 Host가 해당 통화의 직접 대화에 `Core.sendMessage`로 제출하고, 답 텍스트를 `response.item.create` + `response.create`로 돌려준다. 이것이 OpenDots의 `ask_compute`에 해당하며, 모델이 알아서 하는 일은 말하기뿐이다.
- 위임 결과를 보내기 전에 Host가 검증·정리한다(client delegation의 이유). 위임 완료 전에도 음성 모델은 말을 이어 갈 수 있으므로, "했다"는 말은 도구 결과가 있을 때만 하도록 지시문에 못 박는다.
- 비용은 초 단위다. WebRTC 생성 시 15초가 먼저 청구되고 이후 사용 시간에서 차감된다. 통화 시간 상한과 일일 한도를 `core/budget.ts`에 걸고, `session.usage.updated`/`session.closed`의 최종 `usage.seconds`를 통화 기록에 한 번만 적는다.
- 서버 연결은 sideband WebSocket(`/v1/live/sessions/{id}/attach`)로 붙여 위임·기록·종료를 처리한다. 클라이언트 데이터 채널과 중복 처리하지 않도록 위임 처리 주체는 Host 하나다.

[INFERENCE] Live API의 모델명(`gpt-live-1`, `gpt-live-1.1`)과 위임 이벤트 이름은 2026-11 공식 문서 기준이다. 구현 시작 시 실제 계정에서 한 번 세션을 열어 확인한다. 계정에 Live 접근이 없으면 기존 Realtime(`/v1/realtime/calls`, `ask_compute` 함수 도구) 방식으로 같은 어댑터를 구현한다.

### local (Whisper → Ghost 턴 → TTS)

- 클라이언트가 VAD로 발화를 자르고(마이크 → AudioWorklet → mono PCM16 WAV), Host의 `POST /api/calls/:id/utterance`로 올린다. Host는 `ghost-voice-server`의 `/v1/audio/transcriptions`로 받아쓴 텍스트를 `Core.sendMessage`로 제출한다. requestId는 통화 id와 발화 번호에서 정한다(`call:<id>:u<n>`), 재전송은 같은 제출이다.
- 답은 이미 있는 SSE `live`/`message` 이벤트로 클라이언트에 온다. 클라이언트는 문장 단위로 `POST /api/calls/:id/speech`에 보내 WAV를 받아 재생 큐에 넣는다. TTS가 문장 단위 WAV이므로 첫 문장이 끝나는 즉시 재생해 지연을 줄인다.
- 끼어들기는 클라이언트가 즉시 재생 큐를 비우고 명령 `message.cancel { conversationId }`로 진행 중 답을 멈춘다. 서버 STT/TTS 실행기는 직렬이라(동시 3건) 클라이언트가 먼저 멈춰야 한다.
- STT/TTS 프로세스(`ghost-voice-server`, Dyno MLX)가 꺼져 있으면 통화를 시작하지 않고 이유를 보여 준다. 조용히 realtime으로 넘어가지 않는다(소유자 데이터가 외부로 나가는 경로가 바뀌기 때문).
- 이 엔진은 `streaming.py`의 Pipecat 경로를 쓰지 않는다. 목적이 같은 서버가 이미 하나 더 있으면 두 개를 유지해야 하므로, 사용하지 않는 `streaming.py`·`serve_streaming.py`·`host_voice_bridge.py`는 구현 마지막에 삭제한다.

## 통화 모델

새 원장 엔티티 `Call`. 대화와 통화는 따로다: 통화는 대화에 붙는 세션이고, 새 대화 종류를 만들지 않는다.

| 필드 | 뜻 |
| --- | --- |
| `id`, `ghostId`, `conversationId` | 어느 Ghost의 직접 대화에 붙는 통화인가 |
| `kind` | `app`(앱 안) / `phone`(전화망 발신) |
| `engine` | `realtime` / `local` |
| `status` | `connecting` → `active` → `ended` / `failed` |
| `startedAt`, `answeredAt`, `endedAt`, `seconds` | `seconds`는 엔진이 보고한 사용 시간. 계량의 근거 |
| `endReason` | `hangup` / `limit` / `error` / `unreachable` / `declined`... |
| `phone` | `phone` 통화일 때 `{to, callerNumber, purpose, decisionId}` |
| `summary` | 종료 후 Ghost가 쓴 한 단락. 확정된 결정만 적는다 |

- 앱 통화: 한 Host에 동시에 한 통화. 활성 통화가 있으면 새 통화는 거절한다.
- 모든 변경은 `events`에 한 줄을 남긴다(원칙 7). 통화 기록(자막)은 대화 메시지로 들어간다. 메시지 출처는 `voice`로 새로 구분해 UI가 알아볼 수 있게 한다.
- 시작은 명령 `call.start`(requestId 멱등), 종료는 `call.end`. 통화 중 만료(앱 15분, 전화 대행은 승인에 적힌 상한)와 Host 재시작 때는 `failed`로 닫고 통화를 다시 걸지 않는다. 엔진 쪽이 아직 살아 있을 수 있으므로 종료 시 hangup을 시도하고, 확인하지 못하면 `unknown`을 기록한다.
- 종료 뒤 `call:<id>:ended`라는 결정적 id로 Ghost 대화를 한 번 깨워 요약·후속을 만든다(원칙 3). 기록은 요약이 실패해도 남는다.

## 전화 대행

### 흐름

1. Ghost가 `phone_call` 도구로 `{to, purpose, script?, maxMinutes}`를 제안한다. 도구는 걸지 않는다.
2. 소유자에게 `approve_effect` 결정이 간다. 카드에 번호, 목적, 상한 시간, 발신 번호, 예상 비용 상한을 보인다. 이름·카드·주소 같은 금고 값은 통화 중 말하지 않는다(통화에는 금고 도구를 주지 않는다).
3. 승인 뒤 `effects.onApproved("phone_call")`가 현재 허용을 다시 확인하고 Live API `POST /v1/live/sessions`(`transport.type:"sip"`)로 발신한다. 응답은 "세션 초기화"일 뿐 "받았음"이 아니므로, sideband에서 `transport.ringing`/`answered`/`failed`를 기다려 상태를 바꾼다.
4. 통화가 끝나면 효과를 `done`으로 닫고 결과를 Ghost 대화에 돌려준다.

### 반드시 지킬 것

- **재발신 금지.** 발신 요청 후 결과를 모르면(타임아웃, 재시작) 효과는 `unknown`이고 소유자가 확인한다. 같은 승인으로 다시 걸지 않는다. `session.id`를 받기 전에 실패한 요청만 새 승인 없이 한 번 재시도할 수 있는지는 구현 때 따로 판단한다(기본은 재시도 없음).
- **통화 상대는 신뢰하지 않는 입력이다.** 상대의 말은 지시가 아니다. 위임 백엔드는 통화용으로 줄인 권한만 가진다: 읽기 전용 조회와 소유자가 승인에 적은 범위의 메모. 호스트 명령, 메일 발송, 브라우저 쓰기, 금고, 다른 전화는 주지 않는다. 구현은 `Engine.runSubagent`처럼 도구를 교집합으로 줄인 별도 실행으로 한다.
- **고지.** 첫 마디에 "(소유자 이름)을 대신해 전화드리는 AI 비서입니다"를 말하게 한다. 지시문에 고정하고 설정으로 끌 수 없다.
- 긴급번호(112, 119 등), 유료·국제 정보 서비스 번호, 번호가 아닌 입력은 코드에서 거부한다. 소유자가 승인한 한 번호에만 건다.
- 동시 1통화, 통화당 시간 상한(승인에 적힌 값, 최대 15분), 일일 통화 수·초 한도(`core/budget.ts`).
- 상대가 DTMF 안내(ARS)를 요구하면 `transport.dtmf.send`를 쓰되, 번호 입력은 승인에 적힌 범위만 허용한다.

### 공급자 (소유자가 준비해야 하는 것)

Host는 번호를 직접 사지 않는다. 필요한 것은 둘이다.

1. OpenAI API 키(공급자 `openai`, Live 접근 포함).
2. TLS 시그널링과 SDES-SRTP를 지원하는 SIP 트렁크 계정과 발신 번호: `sips:` 엔드포인트, SIP digest 사용자·비밀번호, 발신 번호(E.164). 트렁크 자격은 `Connection`(비밀은 `secrets/connections/`, Ghost별 허용)으로 저장한다. 설정 파일·원장·이벤트에 넣지 않는다.

한국 번호에는 제약이 있다. Twilio 기준 한국 일반(지역) 번호는 개인에게 발급되지 않고 사업자등록증과 SK 양식이 필요하다. 한국 휴대전화 번호는 개인도 신분증으로 신청할 수 있다고 안내돼 있다. 한국 착신 시 발신번호 표시는 "국내 발신 시 보장 안 됨", 국제 발신 시 E.164 표시다. 어떤 번호를 쓸지는 공급자와 정해야 하고, 한국에서 자동 음성 발신에 적용되는 동의·고지 규정은 이 문서가 판단하지 않는다. 실제 상대에게 거는 첫 통화 전에 소유자가 확인해야 한다.

외부 공급자 계정이 없는 동안에도 앱 통화(realtime·local)는 끝까지 만들고 시험할 수 있다. 전화 대행은 계정이 생길 때까지 `phone` 엔진이 `unavailable`을 돌려주며 도구를 모델에 노출하지 않는다.

## API

읽기는 기록하지 않는다. 변경은 `POST /api/commands`로 한다.

| 용도 | 경로 |
| --- | --- |
| 통화 시작·종료 | 명령 `call.start { ghostId, engine }`, `call.end { callId }` |
| 상태·목록 | 스냅샷의 `calls`와 원장 이벤트 `call` |
| realtime SDP 교환 | `POST /api/calls/:id/offer` → `{ sdp }` |
| local 발화·음성 | `POST /api/calls/:id/utterance`(WAV → `{text}`), `POST /api/calls/:id/speech`(`{text}` → WAV) |
| 설정 | 설정 › 음성: 기본 엔진, 목소리, 통화 시간·일일 한도 |

기기 토큰과 소유자는 같은 권한이다. 통화 시작은 기기에서도 된다. 전화 대행 승인은 다른 결정과 같은 규칙이다(메인의 사전 검토 대상이 아니다: 외부에 영향을 주고 되돌릴 수 없으므로 `proposal.review`를 붙이지 않는다).

## 클라이언트

- 통화 버튼은 대화 머리의 `.chat-corner`(데스크톱)와 컴팩트 제목줄(`GhostChat.tsx`) 옆에 둔다. 아이콘 하나이며 설명 문구는 붙이지 않는다.
- 통화 화면: 시간, 내 말과 Ghost 말을 구분한 자막, 마이크 끄기, 스피커 끄기, 끊기, 최소화(대화로 돌아가 계속 통화). 색은 상태에만 쓴다(DESIGN 규칙: 실패만 빨강).
- 마이크는 사용자가 누른 동작 안에서만 요청한다. 에코 제거·잡음 억제·자동 이득은 `getUserMedia` 제약으로 켠다.
- iPhone: `Info.plist`에 `NSMicrophoneUsageDescription` 추가, `WKUIDelegate`에 `requestMediaCapturePermissionFor`(`.audio`, 페어링한 Host 출처만 허용) 추가. 화면을 끈 채 통화하려면 `UIBackgroundModes: audio`와 `AVAudioSession`이 더 필요하며, 첫 판은 화면을 켠 통화만 지원한다. 네이티브 변경이므로 iPhone 빌드 번호를 올린다.
- Mac 셸: 이미 마이크 권한이 연결돼 있다. 추가 변경 없음. Host 응답 CSP가 `media-src`/`connect-src`를 막는지 구현 시작 때 확인한다.

## 구현 순서

1. **계약·원장**: `Call`, 명령, 이벤트, 마이그레이션, 메시지 출처 `voice`. 시험: 멱등 시작, 동시 통화 거절, 재시작 시 `failed`.
2. **local 엔진 + 최소 UI**: 외부 계정 없이 끝까지 돌아간다. STT/TTS 프록시 라우트, 발화 제출, 끼어들기, 통화 화면. 이것으로 통화 계층을 먼저 검증한다.
3. **realtime 엔진**: SDP 중계, sideband, 위임 처리, 사용 시간 계량·한도.
4. **iPhone·Mac 셸 마이크**와 설치판 실기기 확인.
5. **전화 대행**: `phone_call` 도구·결정·SIP 발신·권한 축소 위임·번호 검증·고지. 공급자 계정 확보 뒤 실발신 시험은 소유자 본인 번호로 한다.
6. **정리**: 쓰지 않는 `streaming.py` 계열과 `config.voice` 제거, `architecture.md`·`current-priorities.md`·`ghost-voice-server/README.md` 갱신.

각 단계는 임시 상태 루트와 다른 포트의 Host에서 검증한다. 설치판에는 단계 4 이후 한 번에 릴리스하고(Host와 iPhone 번들), 실제 마이크·스피커와 전화 수신은 소유자 기기에서 확인한다.

## 소유자 확인이 필요한 것

- 전화 대행에 쓸 SIP 트렁크 공급자와 발신 번호.
- OpenAI 계정의 Live API 접근 여부.
- 한국 자동 음성 발신 규정에 대한 소유자 판단.
