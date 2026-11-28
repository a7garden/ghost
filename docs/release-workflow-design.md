# GitHub 릴리스 워크플로 설계 (2026-11-11)

Mac 릴리스는 `v<version>` 태그로 GitHub Releases에, iPhone 빌드는 별도 `ios-v<version>-<build>` 태그로 내부 TestFlight에 배포한다.

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

**Geist 소스**: 비공개 GitHub `a7garden/geist`가 정본이다. mini Gitea `garden/geist`는 보존한다.

## 2. 설계 — `.github/workflows/release.yml`

**Mac 자동 배포 및 업데이트**
```
git tag v<x.y.z> push
  → [mac-release] macos-latest: bun scripts/release.ts --publish (GHOST_SKIP_IOS=1)
      검사 → 빌드 → Developer ID·minisign 서명 → Mac 앱 공증·검증 → Release(draft → latest)
  → 설치된 Host의 주기 체크: /releases/latest 조회(토큰) → 매니페스트 검증
  → idle 대기 → 설치 → launchd 재기동 (롤백 가드)
```
CI는 로컬과 같은 `scripts/release.ts --publish`를 쓴다. CI에서는 배포할 `Ghost.app.tar.gz`를 실제로 풀어 Developer ID, 공증 티켓, Gatekeeper를 확인해야 게시할 수 있다. 릴리스에는 Host 묶음, Mac 앱과 그 서명, 매니페스트와 그 서명, `SHA256SUMS`가 포함된다.

**iPhone 내부 TestFlight**
- `ios-v<version>-<build>` 태그만 업로드한다. Mac 릴리스나 공증 성공 여부와 독립적이다.
- App Store Connect API 키로 Xcode 자동 서명 후 내부 테스트 전용 IPA를 내보낸다. 번들 ID·버전·빌드와 `aps-environment=production`을 패키지에서 확인한 뒤 App Store Connect로 보낸다.
- 올릴 빌드 번호는 `project.yml`과 `project.pbxproj`에 함께 올린다. 이미 업로드한 번호는 재사용할 수 없다. 기존 개발용 IPA와 Host OTA 경로는 그대로 둔다.

**중복 게시 방지**: guard 단계가 태그의 Release 존재를 확인한다. 게시됐든 업로드 중인 드래프트든 Release가 있으면 잡 전체를 스킵하므로 Mac의 `--publish`가 올리는 드래프트를 건드리지 않는다. 실패한 실행이 남긴 드래프트는 소유자가 지운다. CI는 태그가 이미 원격에 있는 상태에서 시작하므로 `GHOST_RELEASE_TAG_PUSHED=1`로 release.ts의 「태그 없음」 가드 대신 「태그가 이 커밋을 가리킴」을 확인한다.

**release.ts 최소 수정 (기본 동작 불변)**
- `GHOST_SKIP_IOS=1` 환경변수 추가: iOS 빌드 섹션 건너뜀, 매니페스트 `ios` 필드 생략(parseManifest상 ios는 선택이라 Host 검증 통과), 검증·에셋 목록에서 IPA 제외. 환경변수 미설정 시 로컬 동작은 한 글자도 바뀌지 않는다.
- 수정은 조건 분기 5곳(선언, 섹션 감싸기, 매니페스트 스프레드, 검증 가드, 에셋 목록)뿐.

**Geist**: `a7garden/geist`를 읽기 전용 SSH deploy key로 checkout해 `GEIST_REPO`로 지정한다. 워크플로는 이 키를 checkout 뒤 남기지 않으며, 고정 커밋이 이력에 없으면 빌드 전에 중단한다.

**시크릿**: 값은 저장소에 절대 두지 않는다. 아래 이름만 워크플로가 참조.

## 3. GitHub Secrets / Variables (이름만, 값은 GitHub에 직접 등록)

| 이름 | 종류 | 내용 |
| --- | --- | --- |
| `APPLE_CERTIFICATE` | secret | Developer ID Application 인증서와 키의 암호화된 `.p12`(base64) |
| `APPLE_CERTIFICATE_PASSWORD` | secret | `.p12` 내보내기 비밀번호 |
| `APPLE_SIGNING_IDENTITY` | secret | `Developer ID Application: … (TEAMID)` 전체 이름 |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | secret | 공증용 Apple 계정, 앱 전용 암호, 팀 ID |
| `GHOST_UPDATER_KEY` | secret | `~/.tauri/ghost.key` 내용(minisign 개인키) — 유실 시 설치 앱 전체가 업데이트 불가 |
| `GHOST_UPDATER_KEY_PASSWORD` | secret | 키 비밀번호(없으면 빈 값) |
| `GEIST_DEPLOY_KEY` | secret | `a7garden/geist` 전용 읽기 키. 다른 저장소나 사용자 계정 권한 없음 |
| `ASC_API_KEY_ID` / `ASC_API_KEY_ISSUER` / `ASC_API_KEY_P8` | secret | App Store Connect API 키(팀 활성화 후 발급, base64) |
| `IOS_DISTRIBUTION_CERTIFICATE` / `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` / `IOS_DISTRIBUTION_IDENTITY` | secret | iPhone 배포용 Apple Distribution `.p12`(base64), 암호, 서명 이름 |
| `IOS_DISTRIBUTION_PROFILE` | secret | `io.a7garden.ghost` 전용 App Store Connect 프로파일(base64) |
| `IOS_TEAM_ID` | variable | TestFlight 서명 팀을 기본값과 다르게 지정할 때만 설정 |

## 4. 소유자가 할 일

1. [Ghost Actions 시크릿](https://github.com/a7garden/ghost/settings/secrets/actions)에 Apple 배포·공증 자격을 등록한다. `project-oxi` 조직의 값은 개인 저장소 `a7garden/ghost`에 상속되지 않는다.
2. 업데이터 키는 설치본의 공개 키와 일치하는 기존 `GHOST_UPDATER_KEY`를 쓴다. 바꾸면 기존 앱이 업데이트를 거부한다.
3. 서명 자격 등록 후 다음 버전 태그를 push해 `mac-release`의 빌드·게시와 설치된 Host의 자동 업데이트를 확인한다.
4. App Store Connect에 `io.a7garden.ghost` 앱을 만들거나 기존 기록을 확인한다. `ASC_*`를 등록하고 내부 테스트 그룹의 자동 배포를 켠다. 첫 태그로 빌드가 그룹에 도달하는지 확인하고, iPhone의 TestFlight에서 최초 설치와 자동 업데이트를 켠다.

## 5. 남은 결정 / 참고

- 비용: 비공개 저장소의 macOS 러너는 분 단위 과금(1회 빌드 수십 분). 로컬 `--publish`를 쓰면 guard가 CI를 스킵해 중복 과금 없음.
- GitHub Mac 릴리스에는 iPhone IPA를 넣지 않는다. 개발용 OTA가 필요하면 로컬 릴리스 경로를 사용한다.
- 롤백: GitHub에서 워크플로를 끄면 자동 빌드만 중단된다. Mac의 로컬 릴리스 경로는 유지된다.
