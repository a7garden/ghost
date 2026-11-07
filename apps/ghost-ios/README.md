# Ghost for iPhone

SwiftUI 네이티브 앱. 휴대전화는 호스트 API(`/api`)를 직접 호출한다. 별도 게이트웨이는
없고, 페어링된 호스트 origin 하나에 bearer 토큰으로 붙는다.

```sh
open apps/ghost-ios/Ghost.xcodeproj
```

`Ghost` scheme을 선택한다. 실제 iPhone 설치에는 Xcode의 Signing & Capabilities에서
본인의 개발 팀을 선택해야 한다. iOS 17 이상을 대상으로 한다. 배포·서명 인증서를
자동 설치하거나 App Store에 업로드하지 않는다.

프로젝트 재생성은 이 폴더에서 `xcodegen generate`로 한다. 통신 모듈은 별도 Swift
package이며 `swift test`로 계약 JSON 디코딩, SSE 프레임 파싱, 페어링 URL 파싱,
요청 ID 재사용, 결과 자료 digest 검증을 검증한다.

## 탭

- **대화** — 허용된 Ghost의 직접 대화. 전송, 응답 중지, 라이브 입력 중 표시.
- **맡긴 일** — 진행 중이거나 최근에 끝난 Work. 상태·결과·검수, 취소·재개·편집.
- **소식** — 확인이 필요한 결정(종류별 승인·거절·답변)과 알림. 알림은 읽음 처리 후
  정확히 그 대상(대화·맡긴 일)으로 이동한다.
- **연결** — origin, 기기 ID, 연결 상태, 푸시 알림 상태, 연결 해제.

## 페어링

호대전화에는 서버 주소나 긴 연결 키를 입력하지 않는다. PC Ghost 화면에서
`device.pairing_start`로 만든 연결 코드를 QR(`ghost://pair?origin=…&code=…`)로
스캔하거나, origin과 코드를 직접 입력한다. 호스트의 `POST /api/pairing/claim`가
`{deviceId, token}`을 돌려주고, 이 값은 Keychain에 저장된다.

- origin은 스킴·호스트·포트만 허용한다(경로·쿼리·fragment·자격증명 없음).
  HTTPS는 항상 허용하고, 평문 HTTP는 loopback(127.0.0.1·localhost)만 허용한다.
- 코드는 6~32자이며 길이와 형식을 파싱 단계에서 확인한다.
- 전송 결과가 확정되지 않으면 연결 요청을 보존하고, 같은 요청으로 다시 시도한다.

## 대화와 이벤트

`GET /api/state` 스냅샷을 먼저 받고 `GET /api/events` 스트림을 이어받는다. 이벤트
스트림은 마지막으로 적용한 seq부터 이어받으며, `reset` 프레임이 오면 스냅샷을 다시
받는다. 연결이 끊기면 같은 seq로 재연결한다.

`POST /api/commands`는 클라이언트가 정한 requestId를 쓴다. 전송 결과가 미확정이면
요청을 로컬 저널에 남기고 같은 ID와 같은 바이트로 다시 보낸다. 호스트가 requestId로
중복을 막으므로 재전송이 효과를 두 번 만들지 않는다.

대화별 초안은 기기에 저장되며 앱을 다시 열어도 복원된다. 전송 도중 추가로 쓴
내용은 전송 응답이 도착해도 남아 있다. 대화는 최근 메시지부터 표시하고, 이전
메시지를 읽는 동안에는 새 메시지가 와도 강제로 이동하지 않는다.

결과 자료는 `GET /api/artifacts/:digest`로 받고, 받은 바이트의 SHA-256이 요청한
digest와 일치할 때만 연다. Markdown은 링크·이미지가 없는 읽기 전용 텍스트로,
HTML은 nonpersistent web view에서 JavaScript를 끄고 신뢰된 CSP로 외부 자원·form·
frame을 차단한다.

알림은 APNs alert로 전달된다. 기기는 알림 권한 승인 뒤 토큰을
`device.push_register`로 등록한다. DEBUG 빌드는 sandbox APNs 환경으로 등록한다.
실기기 원격 알림·APNs 자격과 닫힌 앱 전달은 별도 수용이다.

## 검증

```sh
cd apps/ghost-ios && swift test
xcodebuild -project apps/ghost-ios/Ghost.xcodeproj -scheme Ghost \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' build
```

UI 테스트는 `--ui-testing` Debug 전용 fixture를 사용한다. fixture는 예약된
`.invalid` 호스트를 URLProtocol로 처리하고 실제 네트워크와 변경 요청을 거부한다.
`--review-width=320|375|414|768`은 네이티브 레이아웃 검토 전용이다.

앱 아이콘 재생성: 이 저장소 루트에서
`swift apps/ghost-ios/generate-icon.swift apps/ghost-ios/App/Assets.xcassets/AppIcon.appiconset/Ghost-1024.png`.
