# 후속 단위: 사용자 직접 credential 선택과 연결

협업 recovery와 native in-memory/loopback mock checkpoint는 완료했다. [native transport ADR](adr-004-native-provider-control.md), [검증](native-provider-2026-10-02.md) 참조. 아래 직접 key-file/영구 저장/실 API 연결 계약은 아직 미구현이다. 구현 호출 상한과 fixture/test 범위를 먼저 정하고 실제 키·첨부 파일·OMP 인증은 사용하지 않는다. 새 credential store를 자동 설정하지 않는다.

## 확인한 소스와 공식 계약

2026-10-01 read-only 조사: local oxicode SDK commit 5a7b8587c0bca342efd9bf1fbc62c704de5659d3의 builder는 with_builtins → builtin factory → catalog env_key/extra_env_keys 순서로 환경변수를 받는다. Ghost adapter는 with_auth/explicit api_key/base_url을 연결하지 않는다. catalog snapshot에는 zai/glm-5와 일반 https://api.z.ai/api/paas/v4 endpoint, ZHIPU_API_KEY가 존재한다. legacy env_api_keys 모듈에는 ZAI_API_KEY가 있으나 현재 builder factory가 이 legacy 값을 사용한다고 추정하면 안 된다. OPENAI_API_KEY가 Z.ai에 자동 적용된다는 근거도 없다.

[Z.ai HTTP 공식 문서](https://docs.z.ai/guides/develop/http/introduction)는 일반 API endpoint 및 HTTP Bearer 인증을 명시하고 Coding Plan은 별도 endpoint 설정을 요구한다. [API reference](https://docs.z.ai/api-reference/introduction)도 Bearer header를 명시한다. [GLM-5 공식 소개](https://docs.z.ai/guides/llm/glm-5)는 모델을 문서화한다. SDK의 native OpenAI-compatible transport가 후보이지만 Ghost에서 Z.ai live 연결/plan 적합성/모델 선택/timeout/redaction을 검증한 것은 아니다. 코드 개발 OMP의 성공은 Ghost runtime 지원 증거가 아니다. 두 endpoint의 용도와 사용자 plan을 별도 선택·확인하게 한다.

## 사용자 직접 credential 구현·수용 계약 (아직 미구현)

- 사용자가 provider/model과 전송 대상 origin/path를 선택하고 로컬 key-file의 **경로**를 직접 지정한다. 값은 argv/model context/stdout/log/DB/artifact로 전달하지 않는다. 재사용 허용 여부는 사용자에게 보여주며 실제 접근 연결은 자동 수행하지 않는다.
- 승인된 경로 하나만 읽고 symlink/비정규 파일/과도한 크기/잘못된 owner·group/world 권한을 거부한다. open 시 nofollow/handle-relative 경계와 fstat를 확인해 검사 후 파일 바뀜의 위험을 제한한다. 비밀 buffer는 Debug/Serialize를 제공하지 않고 오류·추적·요청 본문에 포함하지 않는다.
- HTTPS 및 고정 승인 origin/path를 사용하고 redirect는 거부한다. endpoint 변경은 별도 사용자 대상 확인을 요구한다. Authorization을 새 origin이나 redirect 대상으로 전달하지 않는다. localhost mock endpoint는 테스트 전용 생성자에서만 허용하며 production config로 승격하지 않는다.
- 연결 검증은 사용자가 명시 실행한다. 최소 request 한 번, timeout/response 크기 상한/자동 retry 없음. 401/403/429/network 오류는 비밀 없는 분류만 출력한다. billing/quota를 자동 조회하거나 성공을 추정하지 않는다.
- 테스트는 비밀이 아닌 고정 dummy 문자열+고유 fixture+로컬 mock HTTP 서버를 쓴다. redaction은 output/log/audit/artifact 전체에 dummy 불포함을 확인한다. redirect 수신 서버 요청 0, permission/symlink 거부 요청 0, endpoint 변경 승인 필요, timeout/cancel/response-limit/중복검증 실행 상한을 검사한다.
- 실제 provider 두 종류의 복수 turn 대화와 재시작은 사용자 직접 안전한 입력 경로가 완성된 다음 명시 승인 범위로 검증한다. 이번 checkpoint에 runtime live LLM 결과는 없다.
