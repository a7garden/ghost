# Telegram iOS를 참고한 Ghost iPhone 개선

참조 기준은 TelegramMessenger/Telegram-iOS의 커밋
[`6ad963e5b62d354da79040f388ae2b9132fb17b8`](https://github.com/TelegramMessenger/Telegram-iOS/tree/6ad963e5b62d354da79040f388ae2b9132fb17b8)이다.
해당 커밋의 소스를 읽고 상태 관리와 상호작용 원칙을 Ghost의 SwiftUI·WebRTC 구조에
맞춰 별도로 구현했다. Telegram 소스나 바이너리, UI 프레임워크 의존성을 가져오지 않았다.

## 참고한 구현과 적용

| Telegram 소스 | 참고한 내용 | Ghost 변경 |
| --- | --- | --- |
| [ChatInterfaceState.swift](https://github.com/TelegramMessenger/Telegram-iOS/blob/6ad963e5b62d354da79040f388ae2b9132fb17b8/submodules/ChatInterfaceState/Sources/ChatInterfaceState.swift) — `composeInputState`, `historyScrollState`, `encode(to:)` | 입력 상태를 화면의 임시 문자열과 분리하고 저장한다. | 서버·워크스페이스·Ghost·대화별 로컬 초안 저장, 대화 전환과 앱 재실행 시 복원, 전송 중 새로 작성한 내용 보존 |
| [ChatHistoryListNode.swift](https://github.com/TelegramMessenger/Telegram-iOS/blob/6ad963e5b62d354da79040f388ae2b9132fb17b8/submodules/TelegramUI/Sources/ChatHistoryListNode.swift) — `visibleContentOffset()`, `scrollToEndOfHistory()` | 현재 스크롤 위치를 고려하고 최근 메시지로 돌아가는 동작을 제공한다. | 처음 열면 최근 메시지 표시, 이전 메시지를 읽을 때 자동 이동 억제, 새/최근 메시지 버튼, 키보드와 스크롤 처리 |
| [PresentationCallManager.swift](https://github.com/TelegramMessenger/Telegram-iOS/blob/6ad963e5b62d354da79040f388ae2b9132fb17b8/submodules/AccountContext/Sources/PresentationCallManager.swift) — `PresentationCallState.State` 및 [PresentationCall.swift](https://github.com/TelegramMessenger/Telegram-iOS/blob/6ad963e5b62d354da79040f388ae2b9132fb17b8/submodules/TelegramCallsUI/Sources/PresentationCall.swift) — 연결 상태 → 표시 상태 변환 | 연결 중·연결됨·복구 중·종료 중을 구분하고 실제 연결 시각을 유지한다. | 미디어와 데이터 채널이 모두 연결된 뒤 통화 시간 시작, 일시 단절 시 복구 표시, 통화 시간과 음소거 유지, 연결/복구 제한 시간 |

## 입력과 통화의 실패 처리

- 초안에는 UUID revision이 있다. 서버 전송 성공 시 같은 revision만 지운다. 전송 중
  내용을 지웠다가 똑같이 다시 써도 새 revision이므로 지워지지 않는다.
- 새 대화를 만드는 중에 수정한 초안도 생성된 대화로 이동한다. 초안 저장은 입력 후
  300ms에 모아 수행하고, 대화 전환·화면 이탈·앱 비활성화·전송 시에도 저장한다.
  파일을 읽지 못하면 기존 파일을 빈 초안으로 덮어쓰지 않는다. iOS 파일 보호를 사용한다.
- 읽던 위치를 존중하는 동작은 열린 대화 화면 안에서 적용한다. 초안과 달리 스크롤
  위치를 디스크에 저장하지 않으며, 대화를 다시 열면 최근 메시지에서 시작한다.
- 마이크 권한을 기다리는 중에도 연결 취소가 가능하다. 취소 뒤 늦게 열린 마이크는
  즉시 닫고, 서버 통화 생성 응답이 늦게 오면 네이티브 세션이 해당 통화를 종료한다.
- 종료 요청이 실패하면 call ID를 유지하고 동일 통화 종료를 재시도한다. 종료를
  확인하기 전에는 새 통화를 시작하지 않는다. 시작 결과 자체가 불명확할 때도 종료가
  확인됐다고 표시하지 않으며 서버의 진행 중 통화와 보류 요청을 확인하도록 한다.
- 통화 종료는 위임한 Ghost 작업을 취소하지 않는다. 작업 결과는 서버의 durable
  task 결과가 있을 때만 음성 데이터 채널로 전달한다.

## 검증과 남은 범위

| 확인 항목 | 결과 |
| --- | --- |
| Swift core | 11개 통과 |
| 게이트웨이·음성 화면 | 18개 통과 |
| iOS 화면 | 초안 전환, 재실행 복원, 최근 메시지 이동, 새 메시지 도착 시 읽던 위치 유지 — 4개 사례 통과 |
| 빌드 | Debug·Release 시뮬레이터 빌드 성공; Release 바이너리에서 테스트 fixture 문자열 제외 확인 |

화면 테스트 도중 발견한 최초 스크롤 위치 문제를 수정한 뒤 영향받는 두 화면 사례를
다시 실행해 통과했다. 이전 실행의 초안 사례와 수정 후 스크롤 사례의 로그를 함께
[검증 기록](evidence/ios-telegram-improvements-2026-10-03.json)에 남겼다.
[새 메시지가 와도 이전 내용을 읽는 화면](evidence/ghost-ios-telegram-incoming-2026-10-03.png)도 저장했다.
런타임 화면 검증은 iPhone 18 Pro / iOS 27 시뮬레이터에서 수행했으며 iOS 17
호환 경로는 빌드만 확인했다.

Swift package 테스트는 초안 복원·격리·revision 경합·손상 파일과 통화 생성/종료
경합·종료 재시도·불명확한 시작 결과를 검증한다. Node 테스트는 게이트웨이 인증과
통화 화면 상태를 검사한다. XCUITest는 별도 Debug fixture에서 초안 전환/재실행과
실제 SwiftUI 스크롤을 실행하고 스크린샷을 남긴다. fixture는 API client와 Keychain을
사용하지 않고 Release 빌드에서 제외된다. 실제 서버 오류 시 fixture로 전환하지 않는다.

실제 마이크·음성 공급자·Wi-Fi/셀룰러 전환은 이 테스트로 검증되지 않는다.
네이티브 WebRTC·CallKit·이어폰 및 오디오 interruption·잠금 화면/백그라운드 통화는
여전히 [ADR 012](adr-012-cross-device-voice-self-host.md)의 후속 범위다. 현재 앱은
전경 통화만 지원하며 Telegram과 같은 통화 완성도를 달성했다고 간주하지 않는다.

다른 대화의 웹 UI/협업 작업을 확인했으며 이번 변경은 iPhone 앱과 게이트웨이의
음성 화면에 한정된다. Rust host의 저장 형식과 웹 UI 파일은 변경하지 않았다.
