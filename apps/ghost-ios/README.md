# Ghost for iPhone

SwiftUI 네이티브 앱. Ghost 목록·대화·작업 상태와 전경 음성 통화 경로를 제공한다.
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

앱에 HTTPS 서버 origin과 해당 기기의 연결 키를 입력한다. 서버는 TLS, 기기 registry,
Rust host가 준비되어 있어야 한다. [서버 설정](../../deploy/self-host/README.md)을 참고한다.
모든 기기 키는 현재 owner 권한이다.

음성 시작 버튼은 서버 음성 설정과 해당 Ghost의 voice 권한, 선택한 대화가 있을 때
활성화된다. 실제 공급자 비용이 드는 통화는 mock 테스트와 별개다. 마이크 권한,
양방향 오디오·끼어들기·한국어 전사·도구 결과 발화는 실기기에서 추가 검증해야 한다.
현재는 앱을 벗어나면 통화를 마치고 맡긴 작업은 서버에서 계속한다.
통화 연결 도중에도 취소할 수 있다. 실제 음성 연결 전에는 연결 중으로 표시하며,
일시 단절은 복구 중으로 표시한다. 서버 종료를 확인하지 못하면 종료 재시도를 제공한다.

통화의 WebKit 페이지는 서버에서 제공하지만 기기 키를 갖지 않는다. 네이티브 브리지는
origin과 main frame을 검사하고 고정된 Ghost·대화의 음성 동작만 허용한다.

`Ghost` scheme의 `GhostUITests`는 시뮬레이터에서 실행할 수 있다. 예:

```sh
xcodebuild -project apps/ghost-ios/Ghost.xcodeproj -scheme Ghost \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath /tmp/ghost-ios-build CODE_SIGN_IDENTITY=- test
```

UI 테스트는 `--ui-testing` Debug 전용 fixture를 사용한다. 실제 연결 키와 서버를
사용하지 않고 별도 테스트 초안 디렉터리를 쓴다. Telegram 소스 참조와 적용 범위는
[개선 기록](../../docs/telegram-ios-reference-2026-10-03.md)에 정리했다.

남은 제품 기능: 승인·취소·위임 조작, 문서 결과, 로컬 PC pairing/제어 UI, push 알림,
네이티브 WebRTC와 CallKit을 통한 잠금 화면/백그라운드 통화, 확정 Ghost 아이콘 적용.
상세 구조와 완료 기준은 [ADR 012](../../docs/adr-012-cross-device-voice-self-host.md)에 있다.
