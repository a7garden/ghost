# 격리 언어 런타임과 로컬 이미지 — 2026-10-19

네 native worker의 `linux_runtime_root`를 새 동결본 `~/.local/share/ghost/runtime/linux-sdk-18.8.6-node24-python313`으로 전환했다. 기존 Bun 1.4.2/OMP 18.8.6, Ubuntu 이미지 digest, 네트워크 차단·읽기 전용 runtime·uid501·cap-drop ALL과 보호된 로컬 worker 모델을 유지한다. 주 대화의 Codex Luna/high 기본값과 제공자 grant도 유지한다.

## Node와 Python

`scripts/prepare-linux-languages.py`는 기존 동결 runtime을 새 경로로 복사하고 Linux/arm64 Node 24.20.0 및 CPython 3.13.16을 추가한다. 공식 Node 배포본과 Astral python-build-standalone 20261013을 SHA-256으로 검증한다. 기존 경로를 덮어쓰지 않고 파일·디렉터리를 읽기 전용으로 동결한다. 출처와 digest는 새 runtime의 `provenance.json`에 있다. macOS의 대소문자 비구분 파일시스템에서 순환하는 선택형 Python terminfo 별칭만 제외했다.

```sh
python3 scripts/prepare-linux-languages.py \
  --source "$HOME/.local/share/ghost/runtime/linux-sdk-18.8.6" \
  --destination "$HOME/.local/share/ghost/runtime/linux-sdk-18.8.6-node24-python313" \
  --cache .build/linux-language-archives
```

실행기는 Python 3.12 이상을 요구한다. 이미 준비된 destination에는 다시 실행하지 않는다. `bun-bin`의 node/npm/npx/python/python3/pip/pip3가 `/runtime`의 실제 실행 파일을 가리키므로 기존 guest PATH를 바꾸지 않는다. 언어 추가가 guest 네트워크·패키지 다운로드 권한을 부여하지는 않는다.

실제 네트워크 없는 Linux guest에서 Node v24.20.0, npm 11.19.0, Python 3.13.16, SQLite 3.53.1, OpenSSL 3.5.9와 계산·해시 실행을 확인했다. 실제 업무 revision5는 Owner 제공 bash recipe를 현재 local grant에서 직접 실행했다. 두 언어의 합계5050·같은 SHA·동적 버전/Linux·SQLite3행·SSL·exit0과 실제 stdout406bytes를 독립 대사해 수용했다. 같은 Primary sequence33의 accepted 보고도 확인했다. 자연어 local worker의 앞선 metadata 상수/합계 누락/반복 write 실패는 보존했으므로 일반 자율 코딩 수용으로 확대하지 않는다. 휴대폰 수용은 아래 infra 보고를 따른다.

## 로컬 이미지

Ghost 로컬 이미지 요청은 512×512, 40단계, worker deadline 600초다. Node watchdog은 750초에 소유한 Rust CLI에 SIGTERM을 보내며 Rust가 자기 child group을 정리한다. 같은 요청 ID 조회와 `effect_unknown` 보존 정책은 유지한다.

Dyno helper protocol `dyno-image-worker/3`은 캐시된 Qwen-Image-2.1의 인코더를 먼저 실행하고 CPU embedding만 남긴 뒤 MPS 할당을 반환한다. 인코더 live allocation이 1 GiB 이하인지 확인한 뒤 transformer+VAE를 올린다. 512px에서는 VAE tiling을 사용하지 않는다. 가중치의 symlink 자체 길이 대신 실제 파일 크기를 읽고, Python worker도 독립적으로 크기를 계산해 caller 예산과 일치해야 로드한다.

MLX 요청은 shared lease를, 이미지 작업은 exclusive lease를 쓴다. 진행 중인 추론은 완료시키고 유휴 LLM만 반환한다. 새 로컬 추론은 이미지 종료를 기다렸다가 필요할 때 모델을 다시 올린다. 커널 pressure, 시스템 14 GiB와 activation 10 GiB 예약, 실제 상주 speech/Kev 예약 및 실행 중 pressure 중단은 유지한다. 메모리가 부족하면 `blocked`이며 외부 제공자로 자동 전환하지 않는다.

운영 UI bridge를 통과한 새 로컬 요청은 실제 PNG 207,365 bytes와 SHA-256 `7e01ba80baef20f3f3f52c6b621068934dd055d56baab84843d0348d168d23da`를 반환했다. 약 122초, 실제 가중치 33,115,613,408 bytes, 단계별 peak weight 17,534,339,488 bytes다. 인코더 종료 뒤 live MPS allocation은 0이었다. 이 결과는 서버 검증이며 현재 휴대폰 수용을 대신하지 않는다.

## 이전 revision 보고의 대기열

보고의 Host 검사가 new_revision으로 거절되면 immutable 원 보고를 갱신할 수 없다. 해당 보고는 failed/blocked로 보존하고 다음 보고를 검사한다. same_id/미확정 실패는 계속 차단한다. 접수 전과 생성 중 거절 두 회귀와 전체 Pi45/45를 통과했고 실제 원 대화의 새 수용 보고가 도착했다. 네 native worker의 새 실행은 없었다. 새 Pi cutover 전 cold backup `pre-report-fix-20261019T004802`의 SQLite22개를 검증했다.

## 설치와 복귀

| 구성 | 현재 설치 |
|---|---|
| Host Rust | `6dfd74d5ea0e2258` 유지 |
| Host/Pi | `~/.local/share/ghost/bundles/20261019T004802-report-recovery` (runtime.js만 수정) |
| UI/gateway·image adapter/CLI | `~/.local/share/ghost/bundles/20261018T235646-local-images` |
| 네 worker config | 새 Node/Python runtime 경로 |
| Dyno | 기존 daemon·Kev 유지, MLX child 1회 교체, image helper/전용 venv 보완 |

worker 변경 전 백업은 `~/.local/share/ghost/backups/pre-languages-20261018T234025`, UI/gateway 변경 전 백업은 `~/.local/share/ghost/backups/pre-image-services-20261019T000604`다. active/unknown 업무가 없을 때 해당 구성의 plist/config와 runtime 경로를 복귀한다. **Root DB를 이전 백업으로 덮어써 새 사용자 작업을 잃게 하지 않는다.** launchd 교체 시 기존 label 해제와 PID 종료를 확인한 뒤 bootstrap한다.

전체 배포 시도와 두 초기 worker 준비 실패는 자동 복귀했고 최종 scoped 설치 영수증과 구별한다. 이전 불명확한 이미지 요청은 그대로 보존하며 새 요청 성공으로 덮어쓰거나 자동 재실행하지 않는다. 모델 사용은 기존 개인 비상업 연구·평가 범위다.

실행·검수·실물 iPhone의 최신 상태: [infra 보고](../../infra/reports/2026-10-19/runtime-and-local-images.md). 이전 [제공자 등록 보고](registered-models-2026-10-18.md)의 Node/Python 부재와 로컬 resource 차단은 그 시점의 관측이다.
