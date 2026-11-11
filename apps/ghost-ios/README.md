# Ghost for iPhone

네이티브 셸 앱. 화면은 페어링한 호스트가 제공하는 웹 UI(`apps/ghost-ui`)를 WKWebView로 연다.
페어링·Keychain 연결 정보·알림 권한·APNs 등록·알림 탭 이동만 Swift가 맡는다. 별도
게이트웨이는 없고, 페어링된 호스트 origin 하나에 기기 bearer 토큰으로 붙는다.

```sh
open apps/ghost-ios/Ghost.xcodeproj
```

`Ghost` scheme을 선택한다. 실제 iPhone 설치에는 Xcode의 Signing & Capabilities에서
본인의 개발 팀을 선택해야 한다. iOS 17 이상을 대상으로 한다. 배포·서명 인증서를
자동 설치하거나 App Store에 업로드하지 않는다.

빌드와 릴리스 IPA는 유료 개발 팀(Apple Developer Program)의 자동 개발 프로파일로
서명하며, 프로젝트의 `App/Ghost.entitlements`(`aps-environment=development`)가
그대로 서명에 들어간다. 개인(무료) 팀은 Push Notifications 권한을 발급하지 않으므로
이 앱의 푸시 빌드에는 쓸 수 없다. 번들 ID와 팀이 같으면 Keychain의 연결 정보는 유지된다.

```sh
xcodebuild -project apps/ghost-ios/Ghost.xcodeproj -scheme Ghost -configuration Debug \
  -destination 'platform=iOS,id=<UDID>' DEVELOPMENT_TEAM=<TEAM> -allowProvisioningUpdates build
xcrun devicectl device install app --device <UDID> <DerivedData>/Build/Products/Debug-iphoneos/Ghost.app
```

프로젝트 재생성은 이 폴더에서 `xcodegen generate`로 한다. 통신 모듈은 별도 Swift
package이며 `swift test`로 페어링 URL·origin 파싱, 연결 요청 재시도, 셸 브리지(토큰 주입
스크립트, origin 경계, 요청 파싱, 이벤트 전달), 푸시 등록 요청을 검증한다.

## 업데이트

호스트가 제공하는 웹 UI 변경은 앱 재설치 없이 반영된다. 네이티브 코드가 바뀌면
개발용으로 서명한 IPA를 GitHub Release에 올린다. iPhone의 설정 › 업데이트 › 「앱 업데이트」를
누르거나 Mac의 같은 화면에서 QR 코드를 표시해 iPhone으로 스캔하면 OTA로 설치한다.

OTA 빌드는 개발용 프로비저닝 프로파일을 사용한다. 설치할 기기의 UDID가 프로파일에
등록되어 있어야 하며, 프로파일은 매년 만료되므로 갱신해야 한다. 릴리스 스크립트는
내보낸 IPA에서 codesign entitlements와 내장 프로파일 양쪽의 `aps-environment`가
모두 `development`인지 확인하고, 하나라도 빠지거나 다르면 릴리스를 만들지 않는다.

## 페어링

휴대전화에는 긴 연결 키를 입력하지 않는다. PC Ghost의 설정 › 기기 › 기기 연결이
`device.pairing_start`로 만든 연결 코드를 QR(`ghost://pair?origin=…&code=…`)로
스캔하거나, 코드로 연결 시트에 origin과 코드를 입력한다. 호스트의 `POST /api/pairing/claim`가
휴대전화가 보낸 기기 이름으로 기기를 등록하고 `{deviceId, token}`을 돌려주며, 이 값은
Keychain에 저장된다.

- origin은 스킴·호스트·포트만 허용한다(경로·쿼리·fragment·자격증명 없음).
  HTTPS는 항상 허용하고, 평문 HTTP는 loopback(127.0.0.1·localhost)만 허용한다.
- 코드는 6~32자이며 길이와 형식을 파싱 단계에서 확인한다.
- 전송 결과가 확정되지 않으면 연결 요청을 보존하고, 같은 요청으로 다시 시도한다.

## 셸

- 문서 시작 시점에 paired origin의 main frame에만 `window.__GHOST_TOKEN__`(기기 토큰)과
  `window.__GHOST_SHELL__`(`{platform, version, deviceId}`)을 넣는다.
- 웹 → 네이티브: `window.webkit.messageHandlers.ghostShell.postMessage(request)`가 Promise로
  답한다. 요청은 `ready`, `notifications.status|request|settings`, `app.install`, `theme`,
  `haptic`, `disconnected`, `revoked`이며 paired origin의 main frame에서 온 것만 처리한다.
- 네이티브 → 웹: `ghost-shell` CustomEvent(`notification.open`, `resume`). 페이지가 `ready`를
  보내기 전의 이벤트(예: 앱을 깨운 알림 탭)는 그 응답에 담긴다.
- `app.install`은 `itms-services`의 `download-manifest` 요청만 허용한다. manifest는 paired
  origin의 HTTPS `/api/update/ios/manifest.plist`여야 하며, 응답은 `{opened: boolean}`이다.
- paired origin 밖의 최상위 링크는 앱 밖에서 열고, 다운로드는 공유 시트로 넘긴다.
- 첫 로드 동안에는 Ghost 표시를, 호스트가 응답하지 않으면 다시 시도/연결 지우기 화면을 보인다.

연결된 기기는 기기 관리(페어링 시작, 다른 기기 이름 변경·철회)를 뺀 소유자 권한을 가진다.
설정 › 기기에서 이 기기를 스스로 해제할 수 있다. 분실한 휴대전화는 PC에서 철회한다.

알림은 APNs alert로 전달된다. 기기는 알림 권한 승인 뒤 토큰을 `device.push_register`로
등록한다. APNs 환경은 빌드 구성과 관계없이 서명 프로파일의 `aps-environment`로 정한다.
`development`는 sandbox, `production`은 production이며, 내장 프로파일이 없는
App Store·TestFlight 앱도 production이다. 이 빌드는 sandbox APNs로 전달되며, 실제
수신 수용에는 호스트 `config.json`의 `apns` 설정(Apple 포털에서 발급한 팀 ID·키 ID·
`.p8` 키 경로·topic)과 등록된 실기기에서의 권한 승인·원격 알림 확인이 필요하다. 키
파일과 토큰은 저장소 밖에서만 관리한다.

## 검증

```sh
(cd apps/ghost-ios && swift test)
xcodebuild -project apps/ghost-ios/Ghost.xcodeproj -scheme Ghost \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' build
```

UI 테스트는 `--ui-testing` Debug 전용 인자를 쓴다. `--pairing`(`--pairing-issue`)은 저장된
연결 없이 연결 화면을 연다. `--shell-origin <origin> --shell-device <id> --shell-token <token>`은
Keychain을 건드리지 않고 그 호스트로 셸을 연다. 격리된 개발 호스트(별도 `GHOST_ROOT`와 포트)에
기기를 페어링해 그 값으로 실행한다. `ShellUITests`는
`TEST_RUNNER_GHOST_SHELL_ORIGIN|DEVICE|TOKEN`이 없으면 건너뛴다. 첨부 화면은
`xcrun xcresulttool export attachments --path <result.xcresult> --output-path /tmp/ghost-shots/ios`로 내보낸다.

앱 아이콘 원본은 `apps/ghost-desktop/src-tauri/brand-source/Ghost-round-ios.svg`다.
1024px 불투명 PNG로 렌더링해 `App/Assets.xcassets/AppIcon.appiconset/Ghost-1024.png`에 넣는다.
