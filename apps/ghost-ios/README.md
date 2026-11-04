# Ghost for iPhone

2026-11-04 소스: 모든 Ghost를 같은 지속형 봇으로 다룬다. 상단에서 허용된 Ghost를 이름으로 전환하고 대화별 초안과 마지막 선택을 복원한다. **대화 · 맡긴 일 · 확인할 일**을 사용하며, 확인할 일에는 승인 질문과 결과 알림을 모은다. 새 QR 연결은 Owner가 선택한 정확한 Ghost·대화 쌍을 허용한다. 기존 기기 권한은 자동 확대하지 않는다. Telegram·Slack 없이 HTTPS Gateway로 직접 사용한다. [재설계 검증과 설치 범위](../../docs/dashboard-redesign-2026-11-04.md).

2026-10-18: 기존 실제 iPhone 앱을 build6으로 업데이트했다. 대화 상단에서 모델·추론 수준을 바꾸고 대화 옵션에서 이미지를 만든다. 기본 Codex Luna/high, ZAI Coding Plan·MiniMax API 키는 Mac 설정에서 등록한다. 실제 대화·업무 수용 보고·원문 결과 문서와 Codex 같은 OAuth 이미지 표시를 확인했다. [제공자 계약](../../docs/registered-models-2026-10-18.md). Personal Team용 로컬 서명은 기존 APNs entitlement 원본과 별도이며 원격 push 수용을 뜻하지 않는다.

SwiftUI 네이티브 앱. 현재 Lifetime 연결은 **대화 → 맡긴 일 → 확인할 일**의 대화 우선 구조다. 선택한 Ghost와 앱에서 바로 대화할 수 있고, 설정·처리 범위·복구 진단은 상단 버튼으로 연다. 기존 Owner 연결의 Ghost 목록 경로도 유지한다.
같은 저장소의 `ghost-gateway`를 통해 기존 Rust host에 접속한다.

```sh
open apps/ghost-ios/Ghost.xcodeproj
```

`Ghost` scheme을 선택한다. 실제 iPhone 설치에는 Xcode의 Signing & Capabilities에서
본인의 개발 팀을 선택해야 한다. iOS 17 이상을 대상으로 한다. 배포·서명 인증서를
자동 설치하거나 App Store에 업로드하지 않는다.

프로젝트 재생성은 이 폴더에서 `xcodegen generate`로 한다. 통신 모듈은 별도 Swift
package이며 `swift test`로 인증 주소, 요청 영속성, 대화별 초안과 통화 수명 처리를 검증한다.

대화별 초안은 기기에 저장되며 앱을 다시 열어도 복원된다. 전송 도중 추가로 쓴
내용은 전송 응답이 도착해도 남아 있다. 대화는 최근 메시지부터 표시하고, 이전
메시지를 읽는 동안에는 새 메시지가 와도 강제로 이동하지 않는다.

시뮬레이터:

```sh
xcodebuild -project apps/ghost-ios/Ghost.xcodeproj -scheme Ghost \
  -sdk iphonesimulator -configuration Debug \
  -derivedDataPath /tmp/ghost-ios-build CODE_SIGN_IDENTITY=- build
```

키체인 동작에는 시뮬레이터에서도 정상적인 ad-hoc 서명/entitlement가 필요하다.
`CODE_SIGNING_ALLOWED=NO`는 컴파일 전용 확인에만 사용한다.

휴대폰에는 서버 주소나 긴 연결 키를 입력하지 않는다. PC Ghost의 **확장 → 휴대폰 연결**
화면에서 QR·연결 코드를 만들고, iPhone에서 **QR 코드로 연결**을 선택한다. 스캔한
HTTPS 서버를 확인해 연결을 요청한 뒤, 양쪽의 6자리 확인 번호와 기기 이름이 같을
때 PC에서 승인한다. 같은 LAN에서는 자동 검색된 서버를 선택해 `XXXX-XXXX` 코드로도
요청할 수 있다. 다른 네트워크에서는 QR을 사용한다.

서버는 휴대폰이 신뢰하는 HTTPS 인증서, 현재 실제 Ghost registry와 authority epoch,
기기 registry를 갖춰야 한다. [서버 설정](../../deploy/self-host/README.md)을 참고한다.
QR·코드는 5분·1회용이며 기기 키를 포함하지 않는다. 휴대폰이 새 키를 먼저 Keychain에
저장하고, PC 승인 전에는 기기 권한이 생성되지 않는다. 새 연결은 Owner가 선택한 Ghost·대화 쌍의 `lifetime.read`/`lifetime.write`만 갖는다. 최대 16개를 선택할 수 있으며 기본 Ghost는 처음 선택값일 뿐이다. 기존에 저장한 Owner 연결은 유지한다.
카메라·로컬 네트워크 권한은 iOS에서 직접 확인한다. TLS·권한 검증을 우회하지 않는다.

음성 통화는 네이티브 WebRTC(libwebrtc)와 CallKit으로 진행된다. gateway가 알린
고정된 Ghost·대화 쌍에서만 시작 버튼이 활성화되고, 서버의 `serve_streaming.py`
(SmallWebRTC → 로컬 STT/TTS → 동일 Owner 대화)가 미디어를 소유한다. CallKit이
오디오 세션과 잠금 화면 통화 UI를 소유하므로 앱을 벗어나거나 화면을 잠가도
통화는 계속되고, 통화 종료는 잠금 화면에서도 가능하다. 종료는 항상 로컬 마이크·
피어·CallKit을 먼저 닫고 서버 종료를 기다린다. 연결 중 취소는 늦게 도착한
offer 응답도 서버에서 종료하며, 서버 종료 확인이 유실되면 같은 세션 ID로 종료
재시도를 제공한다. 모든 offer는 통화마다 하나의 `start_id`(UUID)를 실어 보내고,
시작 결과가 불명확하면 서버의 시작 조회(`starts/{start_id}`)로만 정리한다. 불명확한
시작이나 미확인 종료는 통화 화면과 무관하게 기기에 유지되고(메타데이터뿐, 토큰·
전사 내용 없음), 앱을 다시 열어도 새 통화를 막는다. 기록은 시작한 gateway·작업
공간·등록 기기·권한 세대에 묶여 있어 다른 연결에서는 상태 조회조차 보내지 않으며,
서버가 확정한 종료나 시작 없음 증거로만 기록이 지워진다. 기록 복원은 상태 확인
전용이며 오디오나 CallKit을 자동으로 다시 잇지 않는다. 연결 단절 후에는 보존된
통화 상태가 새 연결로 재시도한다.
일시 단절은 복구 중으로 표시하고 15초 안에 복구되지 않으면 종료한다. 실제
마이크·스피커·Bluetooth·셀룰러 전환과 한국어 전사·끼어들기는 실기기에서 별도
검증해야 한다 (gateway `GHOST_VOICE_MEDIA_*` 설정 필요).

완료·수용 알림은 APNs alert로 전달된다. 기기는 알림 권한 승인 뒤 토큰을 gateway에
등록하고, push 본문에는 불투명한 notification ID와 최소 문구만 담긴다. 서버의
notification outbox가 정본이며, 앱은 같은 ID로 알림함을 회수하고 열람 시
client_seen을 확인 응답한다. push 탭은 정확히 그 ID의 알림만 열고, 대상을 못
찾으면 다른 알림으로 대체하지 않는다. client_seen 표시는 Host가 같은 수신자·
알림·결과 상태를 성공 응답한 뒤에만 적용하고, 거절·불명확한 응답은 알림을
전달됨 상태로 두고 사유를 표시한다. DEBUG 빌드는 sandbox APNs 환경으로 등록한다.
실기기 원격 알림·APNs 자격(키/Team ID/Topic)과 닫힌 앱 전달은 별도 수용이다.

`Ghost` scheme의 `GhostUITests`는 시뮬레이터에서 실행할 수 있습니다. 예:

```sh
xcodebuild -project apps/ghost-ios/Ghost.xcodeproj -scheme Ghost \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath /tmp/ghost-ios-build CODE_SIGN_IDENTITY=- test
```

UI 테스트는 `--ui-testing`(기존 Owner 경로)와 `--ui-testing-lifetime`(정본 Ghost 대화 경로)의 Debug 전용 fixture를 사용한다. Lifetime fixture는 예약된 `.invalid` 호스트를 URLProtocol로 처리하고 실제 네트워크와 변경 요청을 거부한다. `--review-width=320|375|414|768`은 네이티브 레이아웃 검토 전용이다. 실제 연결 키와 서버를
사용하지 않고 별도 테스트 초안 디렉터리를 쓴다. Telegram 소스 참조와 적용 범위는
[개선 기록](../../docs/telegram-ios-reference-2026-10-03.md)에 정리했다.

Lifetime 범위 연결의 소유자 결정 화면은 Host 레지스트리의 대기 질문을 그대로
보여준다. 각 질문에는 정규화된 동작 대상 전체(연산, URL, 대상 ref·역할·이름,
입력값, 페이지 snapshot, profile 범위, 권한 세대)가 먼저 표시되고, 승인·거절은
같은 action ID에만 기록된다. 승인은 dispatch가 켜진 현재 권한 세대에서만
가능하며, 거부·재개 실패·stale action은 있는 그대로 표시된다. 재개 결과는
sealed worker의 `browser.resume` 응답(`status`, `data.resumed`, `data.executed`)
과 재조회한 action 상태로 표시하며 모델 steer 성공을 재개로 간주하지 않는다.
대상이 바뀐 질문은 이전 승인으로 실행되지 않고 새 질문으로 대체된다(Host가
결정 시점에 재검증). work 카드에서는 취소가 요청됨·확정으로 구분되고, 등록된 다른 담당
Ghost 위임은 같은 work 장부의 child work로 접수되며 선택한 결과물은 참조로만
전달된다. 결과 문서는 digest가 재검증된 bytes만 열고, Markdown은 링크·이미지
가 없는 읽기 전용 텍스트로, HTML은 nonpersistent web view에서 JavaScript를
끄고 신뢰된 CSP로 외부 자원·form·frame을 차단한다. 초기 main-frame
`about:blank` 렌더링만 허용하고 후속 탐색은 거절한다. 로컬 data 이미지와
inline style은 허용하지만 결과 원본 파일은 수정하지 않는다.
전용 컴퓨터·브라우저의 idle 중지/재생성/중지는 같은 화면에서 scope 안의
Ghost에만 제공되고, 불명확한 중지 결과는 레지스트리의 대사 요구를 그대로
보여준다. 승인·위임·문서 열기·컴퓨터 제어의 실제 수용은 실제 worker 질문과
결과 fixture, 실기기에서 별도로 확인한다.

남은 제품 기능: 수신 통화 (APNs/PushKit은 작업 알림에 쓰지 않음), 확정 Ghost
아이콘 적용. 실기기 게이트는 음성 실측(잠금/백그라운드·Bluetooth·셀룰러),
APNs 실측, ICE/TURN 경로 검증이다.
상세 구조와 완료 기준은 [ADR 012](../../docs/adr-012-cross-device-voice-self-host.md)에 있다.

## 2026-10-17 모바일 리디자인

[디자인 계약](DESIGN.md), [구현·검증 기록](../../docs/mobile-redesign-2026-10-17.md).
따뜻한 흰색·차콜, Dynamic Type, 다크 모드와 원본 벡터 Ghost 마크를 적용했다.
대화 입력창은 키보드·탭 바 위에 유지되며, 이전 대화를 읽을 때 새 메시지가 오면
최근 메시지 버튼으로 알린다. 전경에서는 유휴8초/진행 중2초로 정본 대화를 확인하고
백그라운드·연결 권한 변경 시 관찰 task를 취소한다. 명시적 새로고침/전송 후 조회는
한 페이지 조회로 끝나며 별도 장기 poll을 만들지 않는다. 미확정 요청 재전송 금지,
기존 초안·영수증·권한·통화 fence와 정확한 대상 승인 규칙은 그대로다.

앱 아이콘 재생성: 이 저장소 루트에서
`swift apps/ghost-ios/generate-icon.swift apps/ghost-ios/App/Assets.xcassets/AppIcon.appiconset/Ghost-1024.png`.
