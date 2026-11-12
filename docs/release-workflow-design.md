# GitHub 릴리스 워크플로 설계 (2026-11-11)

목적: 태그 push → GitHub Actions(macOS 러너) 빌드 → GitHub Release 게시 → 설치된 맥 앱이 자동 업데이트,까지 전 체인이 저장소와 GitHub Secrets만으로 닫히도록 한다. 아이폰은 소유자 결정(2026-11-11)에 따라 TestFlight로 배포하며, Apple 개발자 팀 활성화가 확인될 때까지 "활성화 대기" 단계로 둔다.

## 1. 현황 (근거)

**릴리스 생성 — `scripts/release.ts` (전부 로컬 Mac 수동 실행)**
- 버전 원천: `apps/ghost-host/package.json` (셸·iOS는 각각 `tauri.conf.json`·`project.yml`/pbxproj). 태그 `v<version>`, 저장소는 git 원격 중 github.com 매칭(`a7garden/ghost`).
- 검사: 루트 typecheck·test(호스트+계약), `apps/ghost-ui` typecheck·test, 셸 `cargo test` — 통과해야 빌드.
- 호스트 페이로드: `bun build --compile`로 단일 실행 파일 생성, `GHOST_RELEASE_REPOSITORY/COMMIT/PUBKEY`를 빌드 시 주입(release.ts:139). `Ghost Host.app` 번들 + `ghost` 셸 shim, Developer ID 서명. agent-browser는 고정 소스+패치(pnpm+cargo 빌드, `stage-agent-browser.sh`), obscura는 프리빌드 다운로드, PC 제어는 swiftc + agent-desktop 프리빌드 + Geist를 고정 커밋 `f6254cc`로 cargo 빌드(`stage-desktop.sh:19,40`).
- 셸: `tauri build --bundles app`이 `Ghost.app.tar.gz` + `.sig` 생성(`tauri.conf.json` `createUpdaterArtifacts: true`).
- iPhone: `xcodebuild archive` + debugging export로 `Ghost.ipa`(개발 프로필, 등록 기기 OTA). 서명·내장 프로필 양쪽에서 `aps-environment=development` 강제 확인, 없으면 중단.
- 매니페스트: `ghost-release.json`(format `ghost-release/1`, host/shell/ios 항목, 파일 해시)을 `~/.tauri/ghost.key`(minisign)로 서명 → `.sig`.
- 게시: `gh release create --draft`로 6개 에셋 업로드 후 `gh release edit --draft=false --latest` — 드래프트 우선이라 Host는 모든 에셋이 올라온 뒤에만 릴리스를 본다(release.ts:295).
- 제약: `--publish`는 깨끗한 작업 트리, 원격에 없는 태그, 커밋이 원격 브랜치에 push돼 있어야 함(release.ts:108-113).

**자체 업데이트 — `apps/ghost-host/src/update/` (기존 구현, 변경 불필요)**
- `github.ts:101-102`: `GET https://api.github.com/repos/<repo>/releases/latest`(또는 `tags/<tag>`), 에셋 URL은 `api.github.com/repos/.../releases/assets/`로 강제. 비공개 저장소라 상태 루트 `secrets/update-github.json` 토큰 사용(index.ts:89,165).
- 매니페스트 `ghost-release.json` + `.sig`를 빌드 시 주입된 공개키로 minisign 검증, ios 항목은 선택(없어도 유효).
- 설치: check → download → `waiting`(유휴가 올 때까지 `idle()` 반복, index.ts:264-289 — 2.7.x idle-wait 경로) → `installing`: `releases/<version>-<commit>` 배치, 백업 후 `current` 원자 교체, 정상 종료 → launchd 재기동. 3회 연속 기동 실패 시 같은 저장 지문이면 롤백.
- 셸 앱(Ghost.app)은 자체 업데이트 엔드포인트가 없다: Host가 릴리스의 `Ghost.app.tar.gz`(+tauri minisign 서명)을 받아 설치한다. iOS는 Host의 OTA 토큰(QR/「앱 업데이트」)로 설치.
- 업데이트 비활성 조건: 저장소/공개키 없음, dev 빌드, 레이아웃 없음, `GHOST_SERVICE != launchd`(index.ts:83).

**iPhone 현황**
- `apps/ghost-ios`(XcodeGen, `io.a7garden.ghost`, `CODE_SIGN_STYLE: Automatic`, entitlements `aps-environment: development`).
- `docs/local-operations.md:96`: 팀 W5SAS95CBV를 Apple이 `Personal Team`으로 취급해 실기기 archive·푸시 프로필 생성이 실패한 기록. `:237` 무료 팀 프로필은 7일 만료.
- 소유자 결정(2026-11-11): 배포는 TestFlight, 팀 활성화까지는 활성화 대기. TestFlight가 업데이트 통지·설치를 담당하므로 IPA는 App Store Connect 업로드용으로 빌드한다.

**기존 CI**: 없음(`.github/` 부재). **Geist 소스**: 미니 서버 Gitea `garden/geist` 전용(git-sync 구성에 GitHub 원격 없음) → GitHub 러너가 직접 접근 불가.

## 2. 설계 — `.github/workflows/release.yml`

**맥 자동 업데이트 체인 (닫힘)**
```
git tag v<x.y.z> push
  → [mac-release] macos-latest: bun scripts/release.ts --publish (GHOST_SKIP_IOS=1)
      검사 → 빌드 → Developer ID·minisign 서명 → Release(draft → latest, 에셋 5개)
  → 설치된 Host의 주기 체크: /releases/latest 조회(토큰) → 매니페스트 검증
  → idle 대기 → 설치 → launchd 재기동 (롤백 가드)
```
기존 자체 업데이트 코드 변경 0 — CI는 `scripts/release.ts --publish`를 그대로 재사용하므로 로컬과 완전히 같은 검증·서명·게시 경로를 지난다. 에셋은 `ghost-<version>-darwin-arm64.tar.gz`, `Ghost.app.tar.gz(.sig)`, `ghost-release.json(.sig)` 5개(IPA 제외).

**iOS — ios-testflight 잡 (활성화 대기)**
- `needs: mac-release` + `if: always() && needs.mac-release.result == 'success' && vars.IOS_TESTFLIGHT_ENABLED == 'true'` — 맥 릴리스와 독립, 실패해도 맥 릴리스는 이미 게시된 뒤.
- 잡 내용: App Store Connect API 키로 자동 서명 archive → `app-store-connect` 방식 export → `xcrun altool --upload-app`로 TestFlight 업로드.
- ASC는 같은 build number(`CURRENT_PROJECT_VERSION`) 재업로드를 거부: ios 네이티브가 바뀐 릴리스는 버전을 먼저 올린다(기존 문서 규칙 동일). TestFlight가 이후 배포·업데이트를 담당하므로 Host의 QR/OTA 경로는 신규 배포에 사용하지 않는다(기존 설치 기기용으로만 존속).

**중복 게시 방지**: guard 단계가 태그의 Release 존재를 확인 — 게시된 릴리스가 있으면 잡 전체 스킵(로컬 `--publish` 병행 가능), 게시 안 된 드래프트만 제거하고 재빌드(태그는 유지).

**release.ts 최소 수정 (기본 동작 불변)**
- `GHOST_SKIP_IOS=1` 환경변수 추가: iOS 빌드 섹션 건너뜀, 매니페스트 `ios` 필드 생략(parseManifest상 ios는 선택이라 Host 검증 통과), 검증·에셋 목록에서 IPA 제외. 환경변수 미설정 시 로컬 동작은 한 글자도 바뀌지 않는다.
- 수정은 조건 분기 5곳(선언, 섹션 감싸기, 매니페스트 스프레드, 검증 가드, 에셋 목록)뿐.

**Geist**: 비공개 GitHub 미러 `a7garden/geist`를 checkout해 `GEIST_REPO`로 지정 — `stage-desktop.sh` 무변경. 미리 pinned commit 존재를 확인하고, 미러/토큰이 없으면 명확한 오류로 실패(조용한 저하 없음).

**시크릿**: 값은 저장소에 절대 두지 않는다. 아래 이름만 워크플로가 참조.

## 3. GitHub Secrets / Variables (이름만, 값은 GitHub에 직접 등록)

| 이름 | 종류 | 내용 |
| --- | --- | --- |
| `MACOS_CERTIFICATE_P12` | secret | Developer ID Application 인증서 `.p12`(base64) |
| `MACOS_CERTIFICATE_PASSWORD` | secret | `.p12` 내보내기 비밀번호 |
| `KEYCHAIN_PASSWORD` | secret | CI 임시 키체인용 임의 문자열 |
| `GHOST_UPDATER_KEY` | secret | `~/.tauri/ghost.key` 내용(minisign 개인키) — 유실 시 설치 앱 전체가 업데이트 불가 |
| `GHOST_UPDATER_KEY_PASSWORD` | secret | 키 비밀번호(없으면 빈 값) |
| `GEIST_MIRROR_PAT` | secret | `a7garden/geist` 미러 읽기용 fine-grained PAT(contents:read) |
| `ASC_API_KEY_ID` / `ASC_API_KEY_ISSUER` / `ASC_API_KEY_P8` | secret | App Store Connect API 키(팀 활성화 후 발급, base64) |
| `GHOST_SIGNING_IDENTITY` | variable | `Developer ID Application: … (TEAMID)` 전체 이름 |
| `IOS_TESTFLIGHT_ENABLED` | variable | 팀 활성화 확인 후 `true` |
| `IOS_TEAM_ID` | variable | 기본 `W5SAS95CBV` |

## 4. 소유자가 할 일

1. `a7garden/geist` 비공개 미러 생성(미니 Gitea mirror push 또는 수동 push) → fine-grained PAT 발급 → `GEIST_MIRROR_PAT` 등록.
2. Developer ID `.p12` 내보내기 → `MACOS_CERTIFICATE_P12`·`MACOS_CERTIFICATE_PASSWORD`·`KEYCHAIN_PASSWORD`·`GHOST_SIGNING_IDENTITY` 등록.
3. `GHOST_UPDATER_KEY`(+필요 시 password) 등록 — 개인키를 다루는 등록은 소유자가 직접.
4. Secrets 등록 후 첫 태그(예: 다음 버전 `v2.8.2`) push로 검증 — Actions 로그에서 release.ts가 로컬과 같은 단계를 통과하는지 확인.
5. 팀 활성화 후: ASC API 키 발급 → `ASC_*` 등록 → `IOS_TESTFLIGHT_ENABLED=true` → 첫 TestFlight 업로드 확인(ASC 웹에서 내부 테스터 자동 배포 1회 설정).

## 5. 남은 결정 / 참고

- Geist 확보 방식: GitHub 비공개 미러(권장, 표준) 대신 러너에 Tailscale을 얹고 미니 Gitea를 직접 읽는 방법도 가능하나 인증·의존성이 늘어난다.
- 비용: 비공개 저장소의 macOS 러너는 분 단위 과금(1회 빌드 수십 분). 로컬 `--publish`를 쓰면 guard가 CI를 스킵해 중복 과금 없음.
- iOS 미포함 릴리스의 유효성: Host의 `verifyReleaseDirectory`는 에셋에 실린 파일만 검증하므로 IPA 없는 릴리스도 설치 가능. 기존 설치 기기의 iPhone OTA는 마지막 dev-signed IPA(2.8.1)로 유지되다가 TestFlight로 전환.
- 롤백: GitHub UI에서 워크플로 비활성화하면 기존 로컬 절차 그대로. release.ts 변경은 `GHOST_SKIP_IOS` 미설정 시 동작 불변.
