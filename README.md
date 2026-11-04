# Ghost

## 이 Mac의 운영 구성

`~/Applications/Ghost.app`을 열면 데스크톱 콘솔(`127.0.0.1:65164`)이
기존 Host(`com.a7.ghost`, `127.0.0.1:62062`)에 연결된다.
Host 하나가 주 Ghost와 담당 Ghost들의 대화와 작업을 보관한다.
설치된 앱, 운영 Host 릴리스, 소스 `main`은 각각 판본을 확인한다.

[실행·검증·복구 지침](docs/local-operations.md) ·
[공유 Mac/iPhone 클라이언트와 .ghost 패키지](docs/ghost-packages-and-shared-client.md)

## 2026-10-24 봇 중심 Pi 직접 실행 — 구현 진행 중

목표 구조는 Ghost가 Pi SDK를 내부 엔진으로 사용해 직접 작업하는 것이다. 새 실행에 OMP나 별도 작업자 에이전트를 두지 않는다. 현재 소스의 [직접 실행 계약](docs/pi-direct-execution.md), [봇 정의와 판본](docs/bot-definitions-2026-10-24.md), [기존 실행 전환 점검](docs/pi-cutover-inventory.md)을 참고한다.

격리된 새 Host에서 실제 로컬 모델→Pi SDK→Apple 컨테이너의 파일 읽기·편집·명령 실행·산출물 게시·독립 수용을 확인했다. 모델 호출 7회, worker outbox 0개이며 기존 협업/복구 회귀 40개와 Pi 런타임 92개 테스트가 통과했다. [실제 검증 범위와 한계](../infra/reports/2026-10-24/pi-host-physical-canary.md)에 근거를 남겼다. 공유 기억·봇 제작·브라우저·외부 provider·운영 전환의 전체 수용은 아직 진행 중이다. 아래 설치 이력의 OMP 구조는 이전 운영판 설명이며, 이 소스 변경의 배포를 뜻하지 않는다.

## 2026-10-24 접수·실행·재시작 복구 안정화

일시적인 Pi 접수 오류의 same-ID 복구/backoff, 시작 실패 재기동·handshake10초, 전달 진단과 정책 blocker 구분을 수정하고 운영 binary `stabilized-7e1b5ce9c882b6e9`에 적용했다. 원 대기 Work 완료, 새 대화와 실제 파일·독립 검수·accepted·같은 Primary 보고2, 재시작 후 실행1→1과 원래 기록 보존을 확인했다. [검증·설치·남은 경계](docs/stabilization-2026-10-24.md). mini 정본 전환·실물 음성/APNs·기간 관찰은 남아 있다.

## 2026-10-22 PC–mini 복원·운영 연결 준비

실제 운영 상태의 전체 cold capture/mini dispatch-off 복원, 원 영수증을 보존하는 worker artifact 경로 재연결, stopped-Host CAS fence와 operator rebind/runtime acceptance를 구현·검증했다. mini는 Studio 없이 직접 ZAI로 대화하고 실제 Linux Node/Python 업무의 독립 수용·같은 Primary 보고를 완료했다. PC 앱은 별도 writer 대신 기존 상시 Host에 연결한다. **현재 정본 writer는 Studio이며 mini 운영 cutover는 아직 미실행이다.** 기존 Primary의 ZAI 이력 허용 응답과 최종 fence/전환·백업 원격화를 남겼다. [구현·검증·보존 경계](docs/dual-host-2026-10-22.md).

## 2026-10-19 격리 Node/Python·로컬 이미지

네 native worker에 Node24.20.0/Python3.13.16 동결 runtime을 적용하고 실제 Linux 실행을 확인했다. 로컬 이미지의 유휴 모델 반환·단계별 로드·실제 weight 크기 검증을 설치해 운영 API에서512×512/40-step PNG를 생성했다. [설치·보호 경계·실제 검증](docs/runtime-and-local-images-2026-10-19.md). 같은 Primary의 언어 업무 revision5 독립검수·수용 보고도 확인했고, 이전 revision 보고가 새 보고를 막던 오류를 수정했다. 현재 실물 iPhone이 unavailable이므로 이번 변경의 폰 검증은 아직 미완료다. 아래10/18 runtime 부재/로컬 차단은 이전 관측이다.

## 2026-10-18 대화 복구·제공자 전환

주 Ghost 기본 대화를 Codex `gpt-6-luna`/high로 전환했다. ZAI Coding Plan·MiniMax API 키 등록과 선택형 로컬 제공자, PC/iPhone의 추론 수준 전환을 지원한다. Codex 이미지는 공식 CLI의 같은 OAuth를 사용하며 실제 iPhone 표시까지 확인했다. 기존 대화의 Codex 외부 처리 허용은 별도 grant로 기록하고 원 이력·기기 키·실패 기록은 보존했다. 실제 휴대폰의 대화→업무→독립 수용 보고→313-byte 결과 문서 열기를 통과했다. [구현·권한·검증 범위](docs/registered-models-2026-10-18.md)를 먼저 읽는다. 아래 날짜의 미연결·옛 binary 판단은 해당 시점의 기록이다.

## 2026-10-17 운영 적용 이력

운영 실행판을 `ba66795899cc065d`로 전환했다. 기존 다섯 profile과 모든 원래 DB 행을 유지하고 canonical Primary와 세 specialist·Pi Durable·격리 native worker 네 개를 실행한다. 실제 운영 파일34바이트의 Owner byte 검수/수용과 같은 Primary 보고, 최종판 cold 보존을 확인했다. 모델 HTTP500의 controller/native 지시 혼합을 수정했고 오류에 안전한 단계/status 진단을 추가했다. OxiBrain workspace version0.19.0의 기존 client source와 Cargo/lock을 정렬한 뒤 Rust489/39 suites/4 ignored, Pi39, UI183+bridge13, gateway96을 검증했다.

새 `g10q-a`는 원 Goal revision1에서 실제 보고서3111바이트·필수검수6·수용·동일 Primary 보고2·cold/cleanup을 통과했다. 이전 실패 기록은 보존한다. 실제 iPhone14에 `io.a7garden.ghost.local` 개발용 앱을 설치·실행했으며 Personal Team APNs 제한으로 원 APNs 설정과 별도다. 운영 gateway8788/Bonjour는 실행 중이나 실제 휴대폰 연결은 Tailscale 관리자 인증·HTTPS 검증이 남았다. [운영 실행 보고](/Users/garden/Workspace/Projects/infra/reports/2026-10-17/operational-resumption.md).

## 2026-10-17 source와 실제 후속 검증

scoped SDK RPC는 pinned OMP18.8.6의 CLI RPC와 같이 `PI_NO_TITLE=1`을 SDK import 전에 설정한다. 보조 제목 inference가 native Work의 고정 예산을 소비하지 않는다. Incident 입력은 봉인 관측·write.content·출처·읽기 전용 경계를 명시하고 snapshot validity/age를 실제 서비스 건강으로 해석하지 않게 한다. 새 incident Goal에는 독립검수6종을 요구한다. 최종 Rust489/39 suites/4 ignored, Pi37, release build를 통과했다. 운영판은 바꾸지 않았다.

mini 새 `m1017`에서 실제 Linux SDK18.8.6의 write/publish→Owner 정확27byte 읽기/해시 검증→수용→같은 Primary 보고2→cold 동일 상태를 확인했다. 처음 누락된 OMP 실행판 설정을 이미 있는 offline18.10.1 launcher로 채우고 native 전 같은 Goal/Work를 명시 revision2로 재접수한 경로다. 실제 inference는 Studio loopback SSH다. mini-only/Studio-off/전체 인수나 옛 m141goal 수용은 아니다.

진단은 여전히 미수용이다. `g10l-a`의 게시된 원 보고서는 부정확한 snapshot 해석·링크 누락으로 검수에서 보류했고, 최종 `g10m-a`는 Primary Pi Connection error 후 native0으로 원 Goal open/Work queued를 cold 보존했다. 최종 지시의 실제 native 효과는 미검증이다. 시험 서비스는 정리했다. 자세한 원장·검증·다음 작업은 [infra 실행 보고](../infra/reports/2026-10-17/model-service-recovery.md)를 본다.

Ghost는 **Rust로 구현하는 장기 실행 에이전트의 기본 단위**다. 각 Ghost는
고유 UUID, 역할, 권한, 맡은 일과 실행 기록을 유지한다. 대화·모델·UI가
바뀌어도 identity와 저장된 작업은 남는다. 제품 목표는 우리가 소유하는 주 Ghost와
지속형 담당 Ghost들의 개인 비서다. 외부 Dot은 필수 접점이 아니다. [기기·음성·컴퓨터·셀프 호스팅 설계](docs/adr-012-cross-device-voice-self-host.md)에
현재 구현과 후속 수용 기준을 정리했다. iPhone 앱은 `apps/ghost-ios`, 선택형 원격 접속
게이트웨이는 `apps/ghost-gateway`에 있다.

기본 빌드는 UI 없이 동작하는 상주 호스트다. 하나의 프로세스가 여러 Ghost의
실행, 타이머, 목표, 정책과 재시작 복구를 관리한다. 기본 모델 `mock`은 외부
요청을 하지 않는다. 실제 모델은 명시적인 provider/model과 기존 인증 설정을 사용한다.

## 소유한 주 Ghost: 현재 source와 canary

`lifetime` source는 Host가 주 Ghost와 고정 대화를 등록하고, 일반 메시지를 실제
Pi Durable 1.1.0에 접수한다. 인사나 메모 요청만으로 Goal/Work를 만들지 않는다.
Owner 원문과 모델 답변, Host가 확인한 업무 상태는 서로 다른 기록이다.

```sh
cargo build --offline --features 'lifetime memory documents'
VITE_GHOST_LIFETIME=true npm --prefix apps/ghost-ui run build
```

상시 설치판과 source 검증은 별개다. 격리 canary에서 로컬 Qwen의 주 Ghost 인사,
같은 SDK 답변의 Host 재시작 회수, desktop 표시를 확인했다. 답변 쓰기 ID와 본문은
불변이며, 회수 때 history 조회에는 새 ID를 사용한다. 예전 거절 영수증은 삭제하지 않는다.
이 결과는 전체 협업, mini 이전, 실물 iPhone 통화·APNs 수용을 대신하지 않는다.

별도 public canary에서는 실제 Primary→Linux Luna/max Work→immutable 파일→독립
검수→Owner 수용을 확인했다. schema13은 완료 보고를 `origin_report_id`가 있는
Ghost advisory로 한 번 투영한다. 이미 완료된 SDK 보고는 원래 entry를 회수하며
Owner turn·Work·모델을 재실행하지 않는다. 같은 report/text는 원래 reply를 반환하고
변경 text와 Owner가 위조한 callback은 거부한다. 실제 opt-in desktop과 두 번째
owned Host cold restart에서도 원래 SDK record/text SHA와 accepted 원장을 유지했다.
이 앞선 증거는 두 canary 도구의 한정된 경로다. 이후 10/12 실제 Linux SDK
Engineering Goal에서는 top-level 20회/10종과 eval 내부 native Bash를 포함한
11개 handler, 실제 hashline/AST 변경, 17-byte immutable artifact를 확인했다.
독립 Owner 5개 검수로 현재 Work/Goal을 수용했고 `work.artifact`가 동일 원본을
반환했다. 실제 Pi 수용 보고와 Host cold reopen도 accepted 상태 및 기존
14회 모델 요청을 보존했다. 초기 glob 실패와 거부된 설정은 삭제하지 않았다.
증거는 `.lifetime-canary/native-20261011T174238112Z/native-acceptance.json`이다.
이는 하나의 public Engineering 작업이며, 원 SDK 장기 승인 대기·동일 call 재개,
전체 Home/browser 복원, 자동 specialist 협업, mini와 실물 전화 수용은 남아 있다.

10/12의 별도 public 협업 canary에서는 Primary가 두 specialist를 선택하고,
실제 native 파일 두 개의 독립 Owner 수용과 자동 보고까지 이어졌다. 그러나
Primary에 native binding이 없어 부모 Work는 queued이며 root Goal은 미완료다.
실행되지 않은 부모를 자동 실행·aggregate 수용으로 대체하지 않는다. 이 canary의
추가 Owner 입력 두 건도 보존하므로 단일 입력으로 끝난 전체 협업 증거가 아니다.
`work_wait` 해소는 queued 전환일 뿐이며, 부모의 권한 있는 `work_submit`,
자체 producing artifact와 독립 검수가 여전히 필요하다.

명시적인 새 Goal revision은 실행이 없는 delivery-stop 작업을 같은 Work ID로
다시 queued 배정한다. 기존 실행은 재시도하지 않고, `wait_for:` dependency는
기존 자식 취소가 정리되기 전까지 유지한다. 실제 원장 복사본의 R1 API 검증과
graph 회귀 16개를 통과했다. 이후 Goal 필수 검수 항목과 선행 accepted artifact의
opaque metadata를 Host→Pi→native 경로에 연결했으며, 전체 Rust 512개(40 suites,
4 ignored)·Pi 32개와 no-fixture 빌드를 통과했다. 원래 미완료 협업 Goal의 자동
끝단 수용은 아직 없으며, 별도 Owner 대체 Goal의 수용을 그 결과로 계산하지 않는다.

휴대폰 신규 연결은 PC **연동 → 휴대폰 연결**의 5분·1회용 QR 또는 같은 LAN의
8자리 코드로 접수하고, 양쪽 6자리 확인 번호·기기 이름을 PC에서 확인한 뒤 승인한다.
새 기기는 현재 실제 주 Ghost 1개의 고정 대화로 제한되며 Owner 키를 휴대폰에
입력하지 않는다. [iPhone 안내](apps/ghost-ios/README.md)와
[서버 설정](deploy/self-host/README.md)을 따른다. 별도 canary에서 gateway 95개,
PC bridge 13개·Swift core 59개 검증과 실제 PC QR decoding을 확인했다. 이 결과는
실물 카메라·HTTPS 연결·통화·APNs·백그라운드 수용을 대신하지 않는다.

기억은 `memory` feature, 명시적인 `GHOST_BRAIN_EXECUTABLE`, `GHOST_BRAIN_DIR`,
`GHOST_BRAIN_TOKEN`, **파일 경로**인 `GHOST_BRAIN_SPACE_MAP`, 절대경로
`GHOST_BRAIN_SOURCE_LEDGER`와 해당 Ghost의 기억 권한이 필요하다. 주 Ghost의
개인 기억 도구는 승인된 로컬 추론에서만 노출된다. 원문·요약 저장은 Untrusted
출처이며 지식 fold나 사실 채택 완료가 아니다. Session 저장은 실제 Session provenance와
`x-oxibrain-session-trust: untrusted` schema marker가 있는 엔진만 사용한다.
구 엔진을 Note 저장으로 대체하지 않는다. 위 기억 canary 당시에는 설치 엔진을 교체하지 않았다.
별도로 승인한 10/12 infra cutover는 OxiBrain `0.18.0`과 Dyno `8768` 추출 entry를
설치·실제 호출·cold restore 검증했다. 이 엔진 설치는 Ghost 운영 기억 E2E 수용과 별개다.

Owner 제어 API의 `workspace` action은 `memory_source_inspect`,
`memory_source_correct`, `memory_source_resume`을 제공한다(`lifetime` + `memory`).
모두 `profile_id`와 등록된 `conversation_id`, 현재 기억 권한·authority·명시적
Brain 설정을 확인한다. inspect는 `origin`과 `content`, correct는 `prior`,
`expected_prior_episode_id`, `prior_content`, `replacement_content`를 받는다.
출처 metadata는 기존 retain receipt를 그대로 사용하며 원문 hash/episode CAS를
우회하지 않는다. 정정의 최소 엔진 권한은 Read/Ingest/**Redact**다(Write가
Redact를 대신하지 않는다). 정정은 LocalOnly이고 새 원문도 Untrusted 출처다.
결과 불명은 성공으로 표시하지 않는다. resume은 새 Owner 요청에
`correction_request_id`로 원래 정정 UUID를 넣어, 저장된 같은 원문·revision을
계속 대사한다. 임의 journal payload나 다른 대화의 요청은 재개할 수 없다.
이 세 명령은 모델 도구가 아니며 자연어/휴대폰 정정 화면 수용도 아니다.

10/14 격리 `memory-natural-clone-2026-10-13T193006991Z`에서 실제 자연 추출
근거의 Primary recall, 실제 로컬 Qwen retain, Owner CAS 정정·거부 경계와
불완전 정정의 동일 revision 재개를 확인했다. 다음 Qwen recall은 질문에 주지
않은 수정 날짜와 새 episode를 반환했고 이전 날짜/episode는 반환 layer에서
빠졌다. 같은 요청 replay는 command 수 17→17, cold 재시작은 두 source
revision과 원본 redacted·정정 complete를 보존했다. 실제 대화 원문은 보존한다.
`actual-natural-primary-owner-correction-acceptance-v5.json`을 본다. 운영 기억
변경·첨부/사진/음성 출처·전체 G08 수용으로 확대하지 않는다.

10/14 최신 V11는 default141/product481(39 suites, 4 ignored)와 release build를
통과했다(`artifact://5783`); Pi consumer37개는 `5780`으로 통과했다. 실제 Host
shutdown/drop 뒤 unrelated fork child의
inherited FD가 workspace flock을 붙잡는 현상은 strong count1→0으로 재현했다
(`5310`). private `WorkspaceLock` RAII가 기존 state/journal→lock field drop 순서를
유지하며 명시적으로 unlock하고, constructor 실패 시에도 획득한 lease를 놓는다.
실제 live writer 배제와 child가 살아 있는 cold open은 `5340`으로 통과했다.
전체 회귀의 Host fixture도 모두 이 guard로 이관했다. 임시 smoke example은
제거했고 중간 compile 실패5344·원래 실패도 보존한다. 원래 suite 실패의 fork
보유자는 미캡처다. V8 file-first/chunk guidance의 전파는 실제 private 요청으로
관측했지만 원1024 응답이 length/tool_calls null이라 그 private Root는 미수용이다.
V9의 LocalHttp cap 수정 때 남은 guest launch duplicate1024/8192 validator가
새 실행을 모델 호출 전 거절했다. V10는 launch/runner를 기존 registered route
validator 하나로 통합했고, legal4096/16384에서도 occupied control state의
Reservation 거절·원 bytes 보존을 검증했다. V10에서는 원 incident Goal이 absolute
publish 경로를 반복해 open/Work failed로 남았다. 별도 d2 Goal의 게시/수용/보고/cold는
원 Goal 마감이 아니며, 봉인 범위 밖 서비스 정상·전체 완료 단정을 놓친 verifier의
공백도 correction으로 기록했다. V11는 게시 도구 schema와 completion guidance에
workspace-relative만 허용함을 명시하고 absolute를 schema에서도 거절한다.
backend traversal/symlink fence·권한·예산은 그대로다. 실제 단일 원 Goal 수용은
새 바이트 발생 전 고정한 independent 기준으로 별도 검증한다.
Guest skill manifest는 Host 파일을 쓰되 `file`에는 guest `/home/ghost/skills/…`
경로를 기록한다. compiled V8의 실제 teaching→독립 검수→Owner v1 import→다른
데이터 sealed reuse→v2 candidate→inflight v1 pin 중 v2 promotion→다음 v2 output→
Owner CAS v1 rollback(rev3)→cold 보존→새 native consumer의 v1 output까지 수용했다.
마지막 output은 independent oracle와 byte-exact이고 by_file 없는 원 v1 shape다.
G11 receipt `g11v8-221637Z/evidence/canary-receipt.json` SHA87db6f44를 본다.
중간 verifier 변경·실패/unknown·별도 correction은 보존하며 운영 설치 수용은 아니다.

Ghost Home은 registry가 증명한 layout의 public/private lane만 worker HOME으로
노출한다. legacy 원본은 명시적 `computers migrate-home --confirm`으로 private lane에
옮기며, 디스크 marker만 있는 unregistered layout은 채택하지 않는다. no-overwrite
rename 충돌은 unknown으로 기록하고 새 migration/admission을 막는다. 10/12 실제
CLI smoke는 public이라는 legacy 디렉터리를 포함한 원본 2개를 private에 옮기고
bytes/inode/mode/mtime 보존과 public 비노출을 독립 확인했다. 전체 Home/browser
cold restore와 원래 SDK pending tool의 cold continuation은 별도 수용 조건이다.

Owner 질문 대기에서는 모델 작업이 없고 살아 있는 SDK tool들이 모두 해당 질문에
막힌 경우만 active budget을 봉인한다. 재개는 이미 쓴 시간을 되돌리거나 180초/16회
한도를 새로 주지 않는다. 중단된 charging interval이나 불완전한 continuation은
성공으로 바꾸지 않는다. 실제 장시간 pause/approve/deny의 원래 SDK 경로 수용은
단위 회귀 통과와 구분한다.

10/12 후속 실제 headless Chrome smoke는 별도 소유 private 프로필에서 오래된
`DevToolsActivePort`를 두 번 넣은 뒤 두 세대 Chrome이 새 endpoint로 시작하고,
같은 합성 원본 파일을 보존하며 정확한 원래 process group을 종료함을 확인했다.
Host/lifecycle writer는 rooted identifier에 맞는 `browser-…`/`lifecycle-…`를 쓴다.
Chrome birth는 CDP 연결 전에 기록한다. 이 결과는 원 SDK Owner-wait 재개 수용이 아니다.
원래 `c8bad…` 실행은 unknown/불완료를 유지한 채 SDK·VM·Chrome 정지 증거만
수집했다. 이후 승인된 별도 실행은 CDP startup 실패 뒤 unknown 효과를 보존하고
Home/lease를 격리한다. 재실행·모델 예산 보충·허위 완료·강제 lease 해제는 하지 않았다.
근거는 같은 canary root의 `native-owned-cold-devtools-browser-smoke-receipt.json`과
`native-schema2-original-approved-startup-failure-collect-receipt.json`이다.

별도 schema14 **소프트웨어** package는 실제 CLI 생성·외부 manifest SHA 검증과
payload 변조 거부를 통과했다. 포함된 ARM Linux Bun 1.4.2/OMP 18.8.6을 실제
network-none/read-only guest에서 실행해 native grep/AST 변경과 Pi dependency를
확인했다(`.lifetime-canary/packaged-guest-smoke-20261012T084500Z-pgrs-receipt.json`).
이 package의 Host는 `b9d9…` 판본이며 위 후속 Chrome 수정과 같지 않다.
아홉 software component·실행 의존성의 검증이지 전체 Original 데이터의 quiesced
복원, mini 인수, 운영 설치·복귀 또는 주 Ghost 자동 협업 완료 수용은 아니다.



## 설치와 CLI 실행

이 프로젝트 폴더에서 release 바이너리를 빌드·설치한다. 설치기는 서비스를 시작하지 않는다.

```sh
python3 scripts/install.py --offline --features workspace-ui
```

`~/.local/bin/ghost`가 판본별 바이너리를 가리킨다. 이 경로가 PATH에 있는 환경에서:

```sh
ghost run
# 다른 터미널에서 같은 호스트 조회/명령 전달
ghost control snapshot
ghost control send --file command.json
```

실행 중인 호스트의 주 Ghost("primary")에게 프롬프트 한 건을 보내고 답을
표준 출력으로 받는 원샷 경로도 있다. 대화가 없으면 만들고, 접수(admission)가
필요한 작업 턴은 콘솔과 같은 routing 절차를 밟는다.

```sh
ghost chat '오늘 일정 요약해줘'          # 답 텍스트만 출력
ghost chat --profile Scout --json '...'  # 대상 교체와 JSON 기록
ghost chat --timeout 600 --kind prompt '...'  # 대기 상한과 입력 종류 지정
```

`ghost run`은 기본적으로 화면 없는 foreground 호스트다. 기본 상태 위치는 macOS의
`~/Library/Application Support/Ghost`이며 `--root` 또는 `GHOST_ROOT`로 바꾼다.
터미널 종료 이후의 상시 운영은 별도 launchd/service 등록을 사용한다.
현재 기본 모델은 `mock`이므로 실제 작업에는 provider/model과 권한을 설정해야 한다.

설치기는 Python 3.9 이상과 Cargo를 사용한다. 개발 checkout의 path dependency도
빌드할 때 필요하다. 설치된 바이너리는 checkout과 별도로 보관하며 Node/Bun 기반
worker나 음성 등 선택 backend의 의존성은 별도다. 이전 release는 보존한다.
`--offline` 빌드는 의존성 cache가 있어야 하고, online 빌드는 이 옵션을 생략한다.

기존 `ghost --root DIR serve --headless`와 `ghost --root DIR run PROFILE`은 호환 경로다.
후자는 기존 queued task를 한 번 처리하는 명령이다. 새 사용 예시는 `ghost run`을 따른다.

선택형 웹 UI는 같은 호스트의 제어 API를 사용한다. UI를 닫아도 작업은 계속된다.

새 React 콘솔은 `apps/ghost-ui`에 있다. Rust 바이너리와 UI를 빌드하고 개인
콘솔 설정을 저장한 뒤 `npm --prefix apps/ghost-ui run console`로 함께 실행한다.
[콘솔 실행·인증 설정](apps/ghost-ui/README.md)과
[Z.ai 실제 E2E 검증](docs/zai-live-e2e-2026-10-03.md)을 참고한다.
아래 `serve` 명령의 내장 UI는 기존 클라이언트다.

UI 포함 바이너리는 `workspace-ui` feature로 별도 빌드한다. 그런 바이너리의
`ghost run --ui`는 내장 UI를 제공하며 `ghost run`은 화면 없이 실행한다.
현재 별도 React console launcher는 host를 자식으로 소유해 launcher 종료 시 함께
종료한다. 상시 호스트에 붙는 client와 구별하며, 기본 attach-only 전환은 후속 작업이다.

`documents`, `memory`, `computer`, `channels` 어댑터를 각각 선택할 수 있다.
`workspace-ui`는 기존 사용법을 유지하는 UI+어댑터 편의 묶음이다.
모델 도구에는 현재 연결된 backend의 지원 기능을 노출하고, 실행 시 정책을
다시 확인한다. 기존 OpenBot 연결과 `ComputerBackend` 교체 인터페이스가 있으며,
Cloudflare Computer는 후속 backend 후보로 [평가](docs/cloudflare-computer-assessment-2026-10-03.md)했다.

[전체 시스템 설계](docs/adr-011-ghost-host-control.md)에 Ghost의 기본 개념, 실행·복구,
도구·권한·프로토콜, 데이터 원본, Cloudflare 활용, UI, 운영과 개발 순서를 정리했다.
[패러다임 재평가](docs/architecture-reassessment-2026-10-03.md)는 그 결정의 배경 기록이다.
현재는 단일 소유자의 로컬 호스트다. OS 자동 시작이나 Cloudflare 배포가
자동 설치되는 것은 아니다. 검증 대상은 로컬 macOS arm64이며, 다른 플랫폼의
릴리스 이식성은 아직 검증하지 않았다.

아래 `profile`/`task`/`conversation` 직접 저장소 CLI는 기존 오프라인 호환 경로다.
상주 호스트가 writer lock을 보유할 때는 위의 `control` 경로를 사용한다.
`--no-default-features`로 기존 bounded core만 빌드할 수 있다.

## 펫과 Ghost 아바타

`apps/ghost-ui`의 **설정 → 펫과 아바타**에서 Ghost별 아바타를 만들거나
Codex 펫 v1/v2 스프라이트를 가져와 지정합니다. 색·형태·표정·장식을 조합하는
제작기, 동작 미리보기, Codex용 ZIP 내보내기, 작업실 펫 표시를 제공합니다.
호스트 연결 시 아바타와 지정 상태는 `workspace.db`에 보존합니다.
[사용 방법과 호환 규격](apps/ghost-ui/README.md#펫과-아바타)을 참고하세요.

## 개인 할 일·일정과 외부 연동

`apps/ghost-ui`의 **할 일과 일정**에서 개인 할 일(마감일·완료 상태)과 시간대가
반영된 일정을 관리한다. **연동**에서 로컬 MCP 프로그램(stdio) 또는
Streamable HTTP 서버를 등록하고, 사용할 Ghost를 선택한 뒤 연결을 확인한다.
Google Calendar·Tasks용 Workspace MCP 설정 예시도 포함한다.

```sh
cargo run --features workspace-ui -- --root /path/to/ghost-state serve --headless
cd apps/ghost-ui
GHOST_ROOT=/path/to/ghost-state npm run dev
```

위 개발용 UI 주소는 `http://127.0.0.1:5178`이다. `GHOST_ROOT` 없이 UI를 실행하면
브라우저에만 저장하는 예시 모드이며 외부 MCP를 실행하지 않는다.
호스트는 기본적으로 `mock` 모델을 사용하므로 자연어 도구 실행에는 실제 모델을
선택해야 한다. 로컬 할 일·일정 화면의 직접 조작에는 모델이 필요 없다.

계정 로그인, 지원 범위와 제어 API 예시는
[개인용 연동 안내](docs/personal-integrations.md)를 참고한다.

## Grammar

```
ghost --root DIR profile create NAME [--persona TEXT]
ghost --root DIR profile list
ghost --root DIR session create PROFILE
ghost --root DIR session status PROFILE SESSION_ID
ghost --root DIR task submit PROFILE SESSION_ID --message-id MSG --prompt TEXT \
    [--read PATH | --write PATH --content TEXT]
ghost --root DIR task status PROFILE [--task TASK_ID]
ghost --root DIR task cancel PROFILE TASK_ID
ghost --root DIR run PROFILE [--provider mock | --provider oxicode --model MODEL]
ghost --root DIR outbox PROFILE
ghost --root DIR policy allow PROFILE --path EXISTING_FOLDER --operation read|write
ghost --root DIR policy revoke PROFILE GRANT_ID
ghost --root DIR policy list PROFILE
ghost --root DIR wake add PROFILE --conversation ID --time HH:MM [--timezone IANA] \
    --prompt TEXT [--quiet-minutes N] [--missed-policy coalesce|skip]
ghost --root DIR wake list PROFILE
ghost --root DIR wake preview PROFILE WAKE_ID [--now-ms MS]   # read-only, no model call
ghost --root DIR wake update PROFILE WAKE_ID [--time HH:MM] [--timezone IANA] \
    [--quiet-minutes N | --clear-quiet] [--missed-policy P] [--paused true|false]
ghost --root DIR wake remove PROFILE WAKE_ID
ghost --root DIR skill add PROFILE NAME --file SKILL.md
ghost --root DIR skill replace PROFILE NAME --version N --file SKILL.md
ghost --root DIR skill list PROFILE
ghost --root DIR skill manifest PROFILE       # explicit pinned set for scoped OMP sessions
ghost --root DIR skill recover PROFILE NAME   # verify/restore the pinned revision
ghost --root DIR skill disable|enable PROFILE NAME
ghost --root DIR skill remove PROFILE NAME --version N
ghost --root DIR skill candidate PROFILE SKILL --file SKILL.md [--note TEXT]
ghost --root DIR skill promote PROFILE CANDIDATE_ID
ghost --root DIR skill reject PROFILE CANDIDATE_ID
```

All output is JSON. `TASK_ID` may be a task uuid, message id, or numeric id.

## Example fixture session

```
mkdir -p /tmp/g-work && echo payload > /tmp/g-work/in.txt
ghost --root ~/ghosts profile create garden --persona "a careful ghost"
ghost --root ~/ghosts session create garden
# use the session uuid printed above
ghost --root ~/ghosts task submit garden $SESSION --message-id m-1 --prompt hi
ghost --root ~/ghosts policy allow garden --path /tmp/g-work --operation write
ghost --root ~/ghosts task submit garden $SESSION --message-id m-2 --prompt write \
    --write /tmp/g-work/out.txt --content written
ghost --root ~/ghosts run garden
ghost --root ~/ghosts outbox garden
```

## Guarantees (legacy task API)

These guarantees describe the original `task`/`run` path. Durable conversations
and the workspace have their own continuation/cancellation contract in ADR 009
and ADR 010.

- **Durable submit**: a submitted task is committed to SQLite before the
  process exits; `run` is a bounded drain of queued tasks with one attempt
  each and no automatic retries.
- **Inbox deduplication**: message ids are UNIQUE per profile. An identical
  duplicate submit returns the same task; a mismatched reuse of a message id
  is rejected. Distinct ghosts cannot cross-correlate.
- **Tasks double as the inbox queue** (documented design choice).
- **Single writer**: an exclusive `fs2` lock per profile is held for the
  command's lifetime; a second writer fails fast and reacquires on drop.
- **Effects**: a ledger row (`UNIQUE(task_id, action)`) is written **before**
  any external effect. After an ambiguous interruption the task/effect is
  `uncertain` and is **never automatically replayed**; writes promise
  at-most-once automatic attempts plus manual reconciliation, not exactly-once.
  Recovery runs on every open: `running` tasks and `started` effects become
  `uncertain`. A tool success followed by a ledger failure is recorded as
  `uncertain`, never duplicated.
- **Cancellation**: only `queued` tasks are cancellable; cancellation is
  terminal and persisted. `running` can only become `uncertain` via crash
  recovery.
- **Provider failures** mark that task `failed` (with an outbox record) and do
  not strand the remaining queued tasks.
- **Capabilities**: everything is denied by default. Grants are explicit,
  local, persisted user approvals of a canonical directory + operation,
  re-checked at every execution; revocation removes eligibility. Approving `/`
  or anything inside the Ghost root is refused (a tool can never alter its own
  policy or identity store). Symlink components below the granted directory
  are denied; lexical `..` escapes and sibling-prefix tricks are rejected;
  writes use atomic `create_new` and refuse to overwrite existing files; reads
  are capped at 1 MiB. All SQL is parameterized.
- **Persona** is immutable per profile, persists across reopen, and is carried
  in every provider request (mock output echoes it). Reconstructed LLM
  conversation history is available through the newer durable conversation API;
  this legacy task path retains its session/task records.

**Security honesty**: path checks are `symlink_metadata`-based and subject to
TOCTOU above the final component; this MVP assumes no hostile concurrent
mutation of granted folders and makes no production-sandbox claim. The single
profile lock cannot stop independent external filesystem actors. A hardened
build should use handle-relative opens (e.g. cap-std) with symlink denial.

## Providers

- `mock` (default): deterministic, offline echo of identity/session/correlation
  context. It never loads credentials and never touches the network.
- `oxicode` (optional feature `oxicode-engine`): adapter over a local SDK
  checkout; no engine tools are registered — host tools are the sole capability
  enforcement, and Ghost (not the SDK supervisor) owns persistence and
  rebinding. Build with `cargo build --features oxicode-engine`; provider
  selection is by `--model` only. Multi-provider engine routing is backlog.

## 선택형 공개 웹 도구

`web_search`와 `web_read`는 Host가 고정 인자만 조립해 별도 OxiBrowser CLI를
실행하는 읽기 전용 도구다. 모델은 실행 파일이나 원시 인자를 선택할 수 없다.
도구가 대화의 역할에 등록되고, 해당 Ghost의 **웹 검색·읽기** 권한이 켜져
있으며, Host 실행 파일에 아래 환경 변수가 절대 경로로 설정된 경우에만 노출된다.

```sh
GHOST_OXIBROWSER_EXECUTABLE=/absolute/path/to/oxibrowser ghost run
```

상주 서비스 명세에 경로를 넣으려면 다음처럼 생성한다. 이 명령은 파일을
검토용으로 만들 뿐 launchd에 설치하거나 서비스를 시작하지 않는다.

```sh
ghost service-spec --output /tmp/ghost.plist --platform launchd \
  --port 62062 --model mock --headless \
  --oxibrowser-executable /absolute/path/to/oxibrowser
```

검색어는 DuckDuckGo에 전송된다. 페이지 본문은 신뢰되지 않은 자료로 취급하며
최대 24 KiB, 실행 제한 20초를 적용한다. 명시적인 로컬·사설 IP와 자격 정보가
들어간 URL은 거부하지만, 이 CLI 자식 프로세스는 OS 수준의 네트워크 격리
경계가 아니다. 이 기능을 금융 원장, 자격 증명, 민감 기록의 외부 전송 권한으로
사용하지 않는다. 검색·읽기 권한은 브라우저 자동화 권한과 별도로 관리한다.

인터랙티브 브라우저 자동화, 기존 Chrome 프로필 접근, 임의 웹 요청은 이 도구가
제공하지 않는다. 셸·Git·로컬 모델 등의 권한도 각 backend와 정책 설정 없이는
자동으로 활성화되지 않으며, CLI 자체는 에이전트 권한을 발급하지 않는다.

## 선택형 OMP 분석 작업자

`worker_analyze`는 Ghost가 설정된 OMP CLI에 한 번의 제한된 분석 요청을 보내는
작업자다. 모델은 실행 파일·인자·도구를 고를 수 없고 prompt만 전달한다.
`--no-tools`, `--no-session`, `--no-extensions`, `--no-rules`, `--no-skills`,
`--no-ui`를 사용하며 임시 작업 디렉터리에서 실행한다. 실행 제한은 125초,
입력 32 KiB, 출력 128 KiB다. 결과는 검증해야 하는 untrusted analysis로 표시된다.

이것은 OS 파일 격리나 샌드박스가 아니다. OMP CLI가 현재 사용자 인증을 읽도록
`HOME`을 유지하고, 프로세스 자체에는 OS 파일 접근이 남는다. 금융 원장, 자격 증명,
민감 기록은 보내지 않는다. 각 Ghost의 **OMP 분석 작업자** 권한은 기본 거부이며,
하루 프로필당 4회·Ghost 호스트 전체 12회로 제한한다. 호출 전 예약을 영속화해
응답이 유실되면 같은 호출을 자동 반복하지 않는다. 이 상한은 OMP 구독의 provider
한도 조회가 아니며 실제 entitlement 성공을 보장하지 않는다. 이 실행 경로는 MiniMax의 `minimax-code` Token Plan provider를 고정하고 OMP 내부 모델 fallback/retry도 끈다. API 호환 transport를 쓰더라도 종량제 API key provider로 전환하지 않는다. [MiniMax Token Plan](https://platform.minimax.io/subscribe/coding-plan)은 M3 모델군과 외부 도구용 구독 key 경로를 안내한다.

개발용으로 실행할 때는 OMP의 기존 구독 로그인과 지원 모델을 확인하고 명시한다.
실제 서비스 환경에서 모델 ID와 계정 entitlement는 운영자가 확인해야 한다.

```sh
GHOST_OMP_EXECUTABLE=/absolute/path/to/omp \
GHOST_OMP_MODEL=minimax-code/MiniMax-M3 ghost run
```

상주 서비스 명세에 넣으려면 `--omp-executable`과 `--omp-model`을 함께 전달한다.
서비스 명세 생성은 launchd/systemd에 설치하거나 서비스를 시작하지 않는다.

```sh
ghost service-spec --output /tmp/ghost.plist --platform launchd \
  --port 62062 --model mock --headless \
  --omp-executable /absolute/path/to/omp \
  --omp-model minimax-code/MiniMax-M3
```

이 adapter는 Pi 멀티턴 세션이나 Codex 구독 연결이 아니다. 멀티턴 위임·파일 편집·셸·MCP를
사용하지 않는 분석 경계이며, 일반 OMP 개발 세션은 별도 작업 실행 adapter가 필요하다.

## Judge

`LocalJudge` is advisory-only: given a prompt, candidates, and the allowed set,
it returns a recommendation with a rationale (or `None` for empty candidates).
It has no authority-grant API. The deterministic mock picks the first allowed
candidate. Laya candidate notes are coordinator backlog; no weights exist.

## Tests

`cargo test --offline -j1` uses mocks/fixtures only (no model downloads or
auth); dependencies must already be cached. CLI tests spawn separate `ghost` processes to prove submit survives
process exit and that two ghosts stay isolated. Optional engine construction is
tested only under `cargo test --features oxicode-engine` and makes no model or
API calls.

## Backlog

Oxibrain search integration, reconstructed conversation history, Knock/FARM
composition, engine multi-provider routing, hardened handle-relative FS tools.

## Verified first unit

See [status and evidence](docs/status.md). The default standalone development
binary is `dist/ghost-macos-arm64`; it has been run with a cleared environment.
Default acceptance tests: 24 passed. Optional engine tests: 25 passed, including
credential-free model registry resolution; live LLM calls were not performed.

## Ghosts collaboration checkpoint

Ghosts manages exactly two existing Ghosts in this bounded unit. A parent is
owned by one of those Ghosts; worker roles provide text context. Delegation
cannot inherit file, HTTP, shell or MCP capabilities. Each worker retains its
own identity, policy, sessions and inbox/outbox.

```
ghost --root DIR ghosts submit --request-id MSG --owner alpha --title TEXT \
    --worker alpha:research --worker beta:review
ghost --root DIR ghosts run WORKFLOW_ID
ghost --root DIR ghosts status WORKFLOW_ID
ghost --root DIR ghosts cancel WORKFLOW_ID
ghost --root DIR ghosts list
```

`ghosts run` uses MockProvider only. Status/list use public read-only APIs and
show last-harvested persisted results. The coordinator journal and profile
DBs are separate: durable intent, sender/message dedup and receipt validation
reconcile delivery; no cross-DB atomic transaction is claimed. Cancellation
is recorded before propagation and unknown work is not automatically replayed.

See [collaboration contract](docs/collaboration-acceptance.md),
[architecture](docs/adr-003-ghosts-collaboration.md),
[v1 acceptance stages](docs/v1-acceptance.md) and
[next native provider unit](docs/native-provider-next.md).
Mock CLI checkpoints do not constitute a finished Ghosts v1 app.

## Verified collaboration recovery — 2026-10-02

See [recovery result and evidence](docs/recovery-2026-10-02.md).
Default regression: 43 passed. Optional SDK regression: 44 passed with global
MCP/config access and networking denied. The standalone macOS arm64 development
binary is `dist/ghosts-macos-arm64`; cleared-environment smoke passed.
Live providers, credentials and browser integration remain future units.

## Native text provider mock unit — 2026-10-02

Two explicit library configurations (OpenAI/Z.ai) share a bounded SSE text/usage
adapter with host-controlled endpoint policy, cancellation/deadline and durable
per-profile call receipts. Default CLI execution remains mock; user credential
input and live native execution are a later unit. Read a stored receipt with:

```sh
ghost --root DIR task provider-receipt PROFILE TASK_ID
```

The command opens the profile through the existing writer/recovery path; the
receipt projection itself is read-only. Terminal and uncertain calls are never
automatically replayed. Raw provider error bodies are excluded from records.
Reported token usage is advisory and does not prove billing or completion.

See [transport decision](docs/adr-004-native-provider-control.md),
[native verification](docs/native-provider-2026-10-02.md) and
[proposed browser boundary](docs/browser-core-next.md). Loopback-only test
constructors require `native-fixtures`, absent from the default artifact.
This is a bounded mock acceptance unit, not a Ghosts v1 release.

## Browser core fixture unit — 2026-10-02

The `browser` library API binds a fake stdio child to one Ghost/session, checks
fixture-only grants, and joins request/snapshot/cancellation handling to the
existing durable effect ledger. Unknown outcomes block restart until separate
trusted reconciliation and never replay the old effect. Page data cannot mint
permissions or resume control. No production browser constructor or browser CLI
execution command is exposed. The default executable still runs without an
extra runtime or browser executable.

See [browser host contract](docs/adr-005-browser-fixture-host.md) and
[actual verification](docs/browser-core-2026-10-02.md). `browser-fixtures` builds
a finite test helper only. The following checkpoint adds actual local-fixture validation.


## Actual browser local-fixture unit — 2026-10-02

`browser-local-e2e` runs nine acceptance cases against a pinned actual OxiBrowser
CLI with separate local-fixture grants and per-child exact-port macOS containment.
Observe/fill/click, two Ghosts, refs, deny, dedup, cancel/timeout/crash and lost
commit recovery passed. Default 47, local 77, combined SDK/HTTP 96 tests passed;
base standalone CLI smoke passed. See [verification and remaining scope](docs/browser-local-e2e-2026-10-02.md).
The base binary is `dist/ghost-local-browser-macos-arm64`; actual browser execution
remains an optional feature-gated library test, with no browser CLI command.
Private-FD human ownership, real sites/credentials and Ghosts v1 remain unverified.


## Private controller and watchdog fixture unit — 2026-10-02

A separate browser-handoff-fixtures library host owns an anonymous private control
FD and an independent child watchdog. Task/session/epoch binding, pause/human
admission, all-tab fresh observations and durable UNKNOWN recovery passed against
actual local OxiBrowser children. Trusted input is fixture-only; it does not prove
actual user confirmation or UI approval. No script/network freeze is available.

Default 47 / no-SDK browser 91 / complete SDK-HTTP-browser 110 passed,
failed/ignored 0. Base CLI smoke passed; default artifact is
`dist/ghost-handoff-checkpoint-macos-arm64`, with fixture constructors disabled.
See [actual verification and limits](docs/browser-handoff-2026-10-02.md).
Next is a bounded host UI and real trusted input validation, before live accounts.


## Temporary fixture host UI — 2026-10-02

`ui-fixtures` embeds static HTML/CSS/JS in one Rust executable and serves a
finite loopback session, without a Node/Bun/Python product runtime. Its two
marked fixture profiles expose mock conversation, independent tasks, actual
results/errors/cancel and local-browser ownership/epoch/handoff/resume.
Actual browser buttons additionally require the pinned OxiBrowser artifact
and macOS sandbox-exec; the browser is not bundled.

```sh
# Use a new empty fixture root and the explicit local artifact pin.
dist/ghost-ui-fixture-macos-arm64 --root /tmp/ghost-ui-new ui-fixture   --browser-pin docs/evidence/handoff-pin.json --seconds 180
```

Open the public loopback URL from stdout manually. It expires in 1..300 seconds;
no auto-open, accounts, credentials, publishing or autostart. MockProvider and
fixture mode are visible. Fixed routes, session/CSRF/Origin checks and typed
host actions keep page/model text separate from commands. UI and untrusted
page fixtures have different origins; child containment excludes the UI port.
This is CSRF containment, not real human authentication or script/network freeze.

Default47 / no-SDK browser+UI95 / complete114 passed, failed/ignored0.
Standalone fixture artifact smoke and its four HTTP acceptance cases passed.
Actual GUI render/DOM interaction/screenshots await the parent's shared GPU
slot; they are **not verified yet**. See [result, evidence and limits](docs/ui-fixture-2026-10-02.md).

## Selected release packages

The source CLI built with `lifetime` can capture and verify an immutable,
caller-selected release without installing it:

```sh
ghost release create --request request.json --destination /absolute/new/package
ghost release verify --package /absolute/package --manifest-sha256 EXTERNAL_SHA256
```

The bounded, regular request file uses the existing recovery `BundleRequest`
inventory and stop-proof format. Release capture requires all nine components:
host, pi, bridge, image, ui, gateway, extensions, config, and schema. It rejects
live SQLite state, unsafe links, missing compatibility pins, source drift, and
an existing destination. Credential exclusions remain explicit.

Retain the creator's manifest SHA-256 outside the package. Verification must not
trust a rewritten package's own hash: the controlled CLI smoke rejected a
coordinated payload-and-manifest rewrite and still verified the untouched
original. Its selected payloads and provenance were fixtures, not a production
release, installation, or restore.

## Google planner transport — source integration only

The `caldav` feature now includes native Google Calendar and Google Tasks JSON
transport alongside the existing iCalendar route. Fixed production HTTPS
endpoints require an account- and scope-bound, unexpired token lease. Complete
bounded pagination precedes inventory reconciliation; sparse updates preserve
unmodified provider fields. Import, reconciliation, and explicit active phases
remain distinct. An unknown-effect Tasks insertion is not blindly resent.

The source includes the concrete private lease store, installed-app PKCE/loopback
OAuth enrollment and production Host sync dispatch. No live Google account or
write has been exercised. Configure `GHOST_GOOGLE_OAUTH_CLIENT` with an absolute
owner-controlled private JSON file using schema `ghost-google-oauth-client/1`
and fields `client_id`/`client_secret`; configure `GHOST_GOOGLE_TOKEN_STORE` with
an absolute private store path. Never paste credential contents into a prompt.
The credential parser rejects unsafe paths, ownership or permissions.

```sh
ghost planner-google login --account personal
ghost planner-google status
```

`personal` is an Owner-assigned local routing label, not verified Google account
identity. Confirm the actual account and exact scopes on the consent surface.
Login defaults to Calendar-events/Tasks read-only; `--write` additionally requests
event/task write scopes and requires explicit approval. The CLI prints the consent
URL and credential-free status, never tokens. The consent window is bounded to
ten minutes; an unavailable client/store or denied consent has no fake fallback.
The latest actual canary status refused because `GHOST_GOOGLE_TOKEN_STORE` was
unconfigured. Owner permission to authenticate does not configure a Google
OAuth client or grant desktop control.

The isolated loopback transport cases pass. Google Tasks conditional-write
enforcement is not established by the provider documentation, so fixture
`If-Match` behavior does not authorize active Tasks writes. Source integration
and controlled fixtures are not live account/calendar or installed UI acceptance.

## Lifetime worker isolation and cancellation

The optional `lifetime,memory` source has an isolated worker supervisor. Its
canary acceptance does not install a release or complete the Ghost product gates.

`ghost worker-serve --root DIR` opens the existing worker journal/R1 protocol.
`GHOST_OMP_GUEST_CONFIG` explicitly selects a trusted, closed JSON configuration
with `container_cli`, `linux_runtime_root`, `source_directory`, `overlay_file`,
`backend`, `model_id`, `model_pin`, `max_tokens`, `context_window`,
`deadline_ms`, and `max_requests`. `backend` is either
`{"kind":"local_http","endpoint":"http://127.0.0.1:PORT/v1/chat/completions"}`
or `{"kind":"subscription_native","executable":"/canonical/bun","entry":"/canonical/subscription-native-bridge.ts","sdk_package_root":"/canonical/pi-ai","auth_file":"/canonical/agent.db","home_directory":"/private/owned/bridge-home"}`.
There is no old flat `endpoint` alias. Invalid selected configuration fails;
there is no model/provider fallback.

Work admission derives skill refs from the owning Ghost's authenticated Host
store when the caller omits them. Caller-supplied refs must match that store
exactly; caller metadata cannot forge a revision or lower source privacy.
Replaying an admitted execution retains its original sealed pin after promotion.

When a Work's sealed spec carries pinned skill refs, the Host dispatcher
(`lifetime_driver`) attaches the exact Host-owned revision bytes as a closed
private `skill_payloads` field on the SAME worker admission RPC — only after the
joined skill/Goal privacy gate admits the route, fetched from the Ghost's own
skill store with sealed-sha verification and a 512 KiB aggregate budget. The
worker validates the closed set against the sealed spec, stages the bytes
immutably under its binding root (`skills-store/<digest>/SKILL.md`), and the
guest session receives exactly those skills (`ghost-worker-skills/1` manifest;
scoped session skills stay explicit — no ambient discovery). Specs without refs
carry no payload and stage nothing.

The skill journal key is `<profile_id>:<name>`; two Ghosts may independently
own the same name. Recovery and candidate creation update/read only that exact
scope. Workspace open atomically migrates old name-only keys without changing
their payload bytes. A conflicting legacy/scoped revision refuses startup and
preserves both records for reconciliation; neither version is silently selected.

The guest route uses Apple Container 1.4.1, a locally available pinned Linux
ARM64 image, immutable credentialless OMP 18.8.6 assets, and private per-execution
session/request/response directories. It does not mount Host HOME, credentials,
project workspaces, the worker journal, or a control socket. Filesystem tools
remain Host-owned and scoped. Use canonical paths and a private `0600` overlay.
The local descriptor is `local/<configured model_id>` with SDK thinking `off`.
The trusted HTTP adapter sends `reasoning_effort:"none"`; this field is not
guest-controlled, and earlier local canaries did not prove backend reasoning-off.
LocalHttp limits are operator-pinned: at most 4096 response tokens and 16384
descriptor context tokens, with the existing 180000ms/request and 16-request
ceilings. Runner and guest launch share the Rust registered-route validator;
the Linux config parser enforces the same capacity bounds. The model
cannot select a larger budget. A captured incident turn used 8240 prompt tokens
and ended at length/1024 with no tool call; a separate 4096-token diagnostic
produced a complete 1627-token write. Actual Root acceptance is still required; diagnostic bytes
are not original production output. These changes do not relax the following
subscription-native descriptor.
`publish_artifact.path` is an existing workspace-relative file name, for example
`output.txt` or `reports/output.txt`. Do not pass `/workspace/...` or a Host absolute
path even when a native filesystem tool accepts that form. The tool schema states
this namespace and rejects an absolute prefix; backend traversal/symlink checks
remain authoritative. Publication does not grant Owner acceptance.

The native descriptor is exact `openai-codex/gpt-6-luna` / `max`, with catalog
context272000, SDK maxTokens1024, deadline ceiling180000 and request ceiling16.
This bounded route requires `canary_read` and `canary_write`; the original Work
deadline/authority still fence each dispatch independently. SDK maxTokens is not
a proved provider output-token cap because the pinned Codex catalog omits that wire field.

Native Host dispatch uses a version-checked Darwin OMP18.8.6 SDK and one RAM-pinned
OAuth credential per execution. The original SQLite main/WAL are read no-follow
into a revision-checked, checksum-verified committed RAM image; SQLite never opens
the source database or SHM. An existing readable SQLite SHM is not credential input
and its permissions are not changed. Bundled per-account discovery describes the
package publisher's accounts, not this execution's credential: catalog capability
pins remain exact, a single admitted credential is session-restricted, and the
provider decides entitlement. Credentials, refresh, account fallback and WebSockets
are excluded from the guest route. The native model bridge executes no tools;
filesystem effects go only through the worker's scoped callback.

The guest snapshot requires all five scoped source files. Actual Linux SDK18.8.6
native Context uses canonical Tool fields, not OMP's local runner metadata; original
messages and opaque signatures remain unchanged. Source39 proved both declared
tools on that wire and clean abort/VM removal without inference. Source41 proved
real single-credential configure readiness without provider I/O. Source42 made one
genuine public Luna SDK generation with configured/resolved `max`, returning the
expected marker with matching original scope/payload/message hashes and no retry.
That observer did not decode the provider Request body's effort field. It is not
physical tool execution, artifact verification, or Host acceptance.

Physical53 exposed a consumer bug: a terminal-only native response carried a
valid tool call, but OMP discarded it and exhausted its empty-completion retries.
The guest adapter now replays canonical content lifecycle events in the pinned
SDK stream in memory; the bounded native wire still carries one authentic final
message, not redundant rolling partial snapshots.

With immutable source55, physical56 produced three real read/write/reread
receipts, a complete stopped SDK session, and confirmed removal of its owned VM.
The independent Rust verifier accepted exactly `greenbox 20\n` (12 bytes) and
rejected both a wrong producing execution and a missing final LF. Worker
collection is still not Host Goal acceptance, nor proof of general tools or a
persistent Ghost home/Studio.

The later native source exposes the owned `read`, `write`, `edit`, `bash`, `grep`,
`glob`, `ast_grep`, `ast_edit`, `eval`, `todo`, and `publish_artifact` tools. An
isolated run of the pinned SDK exercised read/write continuation with opaque
provider history retained: visible-only progress reduced the spool from
7,153,202 to 27,171 bytes without changing the canonical final message. This is
SDK replay evidence, not acceptance of all eleven physical tools or Studio.

Host protected-Work admission, public physical cutover, full tools/Studio and mini
acceptance remain separate, unaccepted integration gates.

Worker mutation epochs are checked before cached command receipts. Stale
submit/steer/cancel/acknowledge/fence requests cannot reuse an old receipt as
authorization; immutable inspect/events/collect facts remain readable.
Cancellation, fencing, and the original execution deadline revoke admission
of new Host tool effects. Completed receipts remain historical facts; prior
effects are not rolled back and an in-flight model call is not instantly killed.
Collection returns forensic receipts/artifact spools, not Goal acceptance.

`native-unknown-collection-v1.json` defines narrow cleanup of an original native
`unknown` execution. It requires the recorded process birth/group and original
VM to be absent or stopped, no unresolved Host-tool receipt, and the original
cleanup scope. It seals actual partial SDK bytes before releasing only that
execution's lease pair. Collection keeps `state=unknown`,
`session_settled=false`, and absent exit/prompt outcomes; it cannot fabricate
completion or authorize another execution.

The original failed native execution was physically collected under this path:
its 2,582-byte SDK spool retained its original SHA-256, the artifact directory
and file were `0700`/`0600`, both original leases were released, and repeated
collection returned the same evidence without another model request. Cold
multi-root restore remains a separate gate. Original-worker routing now uses
the successful immutable submission and private recorded root/socket rather
than the current grant. An actual old-computer steering attempt was denied
without changing the original unknown Work.

### Bounded native observer progress

Canonical OMP SDK messages remain in the private SDK session. The worker
observer stores a bounded visible projection of recognized SDK progress,
including tool identity, error status and UTF-8-safe text previews; cumulative
messages and opaque provider signatures are not repeatedly charged to the
observer spool. Unknown or malformed frames keep raw fail-closed accounting;
critical prompt outcome and settlement records remain durable.

A fresh automatic Engineering execution performed seven native tool kinds
before repeated outer RPC metadata exhausted the original 1 MiB spool. It
remains failed and is not retried. The observer fix passed two semantic tests
and thirteen worker lifecycle tests. A new owned worker and fresh automatic
task exercised ten native tool kinds with 169,077 observer bytes, then failed
with a bound native broker `invalid_payload` response; its exact cause remains
unproved. After guest stop, independent reads confirmed a nine-byte task file
and sixteen-byte Home marker. No producing artifact was published or accepted.

The native broker now checks serialized bytes against its separate 1 MiB
payload bound, not the model's token window. The old predicate failed the new
boundary regression; the corrected predicate passed. A fresh automatic
Engineering attempt using work-ID-only admission dispatched a 367,896-byte
model payload, completed seven tool kinds and read the prior same-Ghost Home
marker from a new guest. It stopped at the unchanged 180-second deadline with
134,727 observer bytes and no artifact. These failed attempts are preserved,
not retried. Full eleven-tool/parent success, two-Home isolation and cold
restoration remain open.

### Persistent specialist bootstrap

With dispatch enabled and `GHOST_LIFETIME_MODE=broker`, Host startup provisions
research, engineering, and operations specialists alongside the Primary.
Existing role registrations are reused, including `draining` specialists;
restart does not reactivate them or replace their identities. Profile and
non-legacy personal-conversation bindings must remain valid. Name/identity
collisions fail closed. Dispatch-off restore creates no new profiles.

A fresh task-owned Host and its reopen preserved all four Ghost/conversation
IDs and an Owner-selected research `draining` mode without creating Goals,
Work, or model turns. This is registry-bootstrap proof, not automatic
delegation, cross-Ghost OMP, sandbox/Studio, or mini acceptance.
