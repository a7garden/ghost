# 주 Ghost 모델 등록과 전환 — 2026-10-18

10/19 후속으로 격리 Node/Python과 로컬 이미지 메모리 경로를 적용했다. 아래 runtime 부재/로컬 차단은10/18 관측이며 [최신 구현·수용 범위](runtime-and-local-images-2026-10-19.md)를 따른다. 제공자 인증·기존 이력 grant·Luna/high 기본값은 유지한다.

운영 주 대화의 기본값은 **Codex `gpt-6-luna` / high(깊게)**다. 로컬 Qwen은 제공자 목록에서 선택한다. 이 설정은 주 Ghost의 대화 추론을 바꾸며, 격리 worker의 보호된 모델 배치나 개인 기억·문서 권한을 일괄 변경하지 않는다.

## 사용하는 경로

| 제공자 | 인증 | 현재 모델 | 추론 선택 |
|---|---|---|---|
| Codex | 이 Mac의 공식 Codex ChatGPT OAuth 로그인 | gpt-6-luna, gpt-6-sol, gpt-6.1-sol, gpt-6-astra | low / medium / high / xhigh / max |
| Z.AI Coding Plan | Owner가 등록한 Coding Plan API 키 | glm-5.3 | low / high / max |
| MiniMax | Owner가 등록한 API 키 | MiniMax-M3.1-Flash-Preview | low / medium / high / xhigh / max |
| 로컬 | 기존 loopback route | 설치된 Qwen 모델 | off |

PC의 **설정 → 모델**에서 API 키와 기본 모델을 관리한다. iPhone은 대화 상단의 모델 이름을 눌러 제공자·모델·추론 수준을 바꾼다. 진행 중이거나 결과가 불명확한 대화는 먼저 대사한 뒤 변경한다. 설정은 version을 비교해 저장하며 다른 화면에서 바뀌면 다시 불러와야 한다. 저장에 실패한 키 입력은 화면 메모리에 남고, 성공한 뒤에만 비운다.

`GHOST_INFERENCE_PROVIDER_MODE=registered`가 등록 제공자 경로를 활성화한다. `GHOST_CODEX_EXECUTABLE`은 설치된 공식 CLI의 절대경로다. Codex가 OAuth 로그인·갱신을 소유하며 Ghost는 OAuth 파일·토큰을 읽거나 복제하지 않는다. 별도 이미지용 OpenAI 키도 받지 않는다.

ZAI와 MiniMax 텍스트 요청은 **공식 Codex CLI의 custom Responses provider**로 실행한다. 주소는 각각 `https://api.z.ai/api/v1`, `https://api.minimax.io/v1`로 고정한다. API 키는 자식 프로세스의 전용 환경에만 전달하며 argv에 넣지 않는다. 사용자 Codex 설정을 덮어쓰지 않고 요청별 비공개 model catalog에 `supports_reasoning_summaries=true`와 지원 추론 목록을 명시한다. 이 필드 없이 선택한 추론 수준이 누락되는 경로를 방지했다. Codex 자체의 모델 metadata는 기존 공식 catalog를 사용한다.

공식 근거: [Codex를 자체 제품에 통합하는 방법](https://developers.openai.com/blog/codex-as-a-platform), [ZAI의 Codex 설정](https://docs.z.ai/devpack/tool/codex), [MiniMax의 Codex 설정과 reasoning 필드](https://platform.minimax.io/docs/m-plan/codex). ZAI Coding Plan은 [사용 정책](https://docs.z.ai/devpack/usage-policy)의 지원 도구 경로를 따른다. raw SIWC preview의 이미지 미지원과 공식 Codex CLI의 native image tool은 별개다.

## 권한과 저장

- 설정·제공자별 대화 허용은 Host `workspace.db`의 `inference_settings_v1`에 저장한다. 비밀 값은 이 장부·action receipt·snapshot에 넣지 않는다.
- API 키는 Root의 `inference-credentials/{zai-coding|minimax}.json`에 0600으로 저장한다. 디렉터리는 0700이며 소유자·파일 종류·크기·symlink를 검사한다. 휴대폰에는 키나 Owner bearer를 주지 않는다.
- 기존 Primary 이력의 외부 전송은 Owner가 **Codex에만** 허용했다. 원문의 `local_only` 표시는 보존하고 exact Ghost/conversation/provider grant로 별도 기록했다. ZAI·MiniMax로 전환할 때는 해당 제공자에 기존 기록과 새 메시지를 보낼지 화면에서 선택한다.
- 대화 grant는 개인 기억·문서 저장소 접근권을 추가하지 않는다. 외부 추론에는 이 도구를 노출하지 않고 요청 때마다 현재 선택·grant·권한 세대를 재검증한다.
- CLI의 plugin/hook/MCP·native shell/브라우저/컴퓨터 도구를 차단한다. 모델은 구조화된 답변 또는 노출된 Ghost 도구 호출만 반환하고 실제 업무는 기존 Host/Pi/worker 권한 경로가 실행한다. 종료 receipt 없는 응답이나 native 실행 시도는 거절한다.
- 앱의 대화 예산은 65,536 tokens다. 제공자 모델의 전체 context 상한을 뜻하지 않는다. 로컬 제공자 사용 시 compaction은 실제 16K context에 맞춰 reserve 6,144 / keep-recent 2,048로 적용한다.

## 이미지

대화 옵션의 **이미지 만들기**에서 Codex·MiniMax·로컬을 고른다. 이 명시적 요청은 이미지 설명만 보내며 대화 이력을 함께 전송하지 않는다. 이미지 요청이 대화 전체의 외부 처리 grant를 만들지도 않는다.

Codex는 같은 공식 CLI OAuth의 native `image_generation`을 사용한다. 반환 경로나 요약만 믿지 않고 캡처한 **그 CLI thread의** 출력 디렉터리 또는 소유한 job 디렉터리에서 새 파일 하나를 확인한다. MiniMax는 등록한 키로 공식 `image_generation` API의 base64 결과를 받는다. 로컬은 동결한 Dyno CLI를 사용하며 기존 resource gate를 유지한다.

Root `images/<UUID>/receipt.json`은 exact 대화 쌍·제공자·prompt digest와 상태를 보관한다. 생성 전 `effect_unknown`, 실행 중 `running`, 검증된 bytes만 `completed`다. 파일은 PNG/JPEG/WebP signature·크기·소유자·경계·SHA-256을 확인한다. 기기와 gateway 재기동 후에는 같은 ID를 조회하며 자동으로 다시 생성하지 않는다. 로컬 자원 부족은 `blocked`로 표시한다.

## 실제 검증

- Codex Luna, ZAI glm-5.3, MiniMax M3.1 Flash에 합성 텍스트를 실제 전송해 정상 응답을 확인했다. 기존 대화는 이 시험의 ZAI·MiniMax 요청에 포함하지 않았다.
- 공식 CLI의 로컬 전송 fixture에서 ZAI max와 MiniMax medium이 실제 Responses `reasoning.effort`로 전달되는 것을 확인했다. fixture 전용 키와 loopback만 사용했다.
- 실제 iPhone14의 기존 앱을 build6으로 업데이트했다. Keychain·pairing·원래 실패를 보존했다. Codex 답변, 추론 medium→high 저장, 새 Goal/Work, 실제 파일, 독립 검수 2개, accepted 보고와 결과 문서 원문 열기를 검증했다.
- 실제 업무는 `01a14f2d-8d0e-7319-a696-ff10e8cc8ae1`, 원 Goal revision1이다. 313-byte 산출물 SHA-256은 `3b0a752e3e1ad5d298040daca57043a05789fdcadfb5c2de58827961e06594b8`다. 격리 Linux worker의 node/python3 부재(exit127)도 그대로 기록했다. 관측 업무 수용이며 이 언어 runtime 설치의 수용은 아니다.
- 실제 iPhone에서 Codex 이미지가 생성·표시됐다. 요청 `759bf986-6b8e-4bbd-a762-fff75194bb7f`, 1,056,343 bytes, SHA-256 `3426615f113199c4faa3a484b9bfd489e82090c32e5db8e85a79d864108ffdc9`다. MiniMax 이미지도 실제 파일 검증을 통과했다. 로컬 이미지는 resource gate 차단이므로 생성 성공으로 계산하지 않는다.

검증 영수증과 최종 배포·복귀 위치는 [infra P0 보고](../../infra/reports/2026-10-18/p0-and-providers.md)를 따른다. 음성·APNs, mini Studio-off 인수·전체 복원, 7일 관찰은 별도 미완료다.
