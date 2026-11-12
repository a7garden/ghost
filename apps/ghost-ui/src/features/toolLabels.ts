import type { GhostTool } from '@ghost/contract';

/** The owner's name for every Ghost tool: 설정 → Ghost grants, activity tools and tool trails all read it. */
export const toolLabels: Record<GhostTool, string> = {
  work_create: '일 만들기', work_list: '일 목록', work_inspect: '일 자세히', work_update: '일 고치기', work_cancel: '일 취소',
  schedule_create: '반복 만들기', schedule_list: '반복 보기', schedule_cancel: '반복 취소',
  ghost_list: 'Ghost 목록', activity_propose: '활동 제안', read: '파일 읽기', write: '파일 쓰기', edit: '파일 고치기', bash: '명령 실행',
  publish_artifact: '결과물 공유', delegate: '다른 Ghost에게 맡기기',
  document_scopes: '문서 공간', document_list: '문서 목록', document_read: '문서 읽기', document_propose: '문서 수정 제안',
  web_search: '웹 검색', web_read: '웹 읽기', reach: '외부 읽기', skill_read: '스킬 읽기',
  connection_list: '연결 목록', connection_register: '연결 등록', connection_request: '연결 API 사용',
  host_status: 'Mac 상태', host_services: 'Mac 서비스', host_disk_scan: 'Mac 디스크 검색', host_disk_usage: 'Mac 디스크 사용량',
  host_list: 'Mac 파일 목록', host_read: 'Mac 파일 읽기', host_nodes: 'Tailscale 노드', host_command_propose: 'Mac 명령 제안', host_message_codes: '문자 인증번호 읽기',
  browser_open: '브라우저 열기', browser_snapshot: '브라우저 구조 읽기', browser_screenshot: '브라우저 캡처', browser_read: '브라우저 읽기',
  browser_click: '브라우저 클릭', browser_fill: '브라우저 채우기', browser_type: '브라우저 입력', browser_press: '브라우저 키 누르기',
  browser_select: '브라우저 선택', browser_check: '브라우저 체크', browser_scroll: '브라우저 스크롤', browser_navigate: '브라우저 이동',
  browser_tabs: '브라우저 탭', browser_wait: '브라우저 대기', browser_upload: '브라우저 올리기', browser_download: '브라우저 내려받기',
  browser_propose: '브라우저 클릭 제안', browser_handoff: '브라우저 넘겨주기', browser_fill_secret: '브라우저 금고 채우기', browser_fill_card: '브라우저 카드 채우기', browser_close: '브라우저 닫기',
  vault_list: '금고 목록', vault_request: '금고 저장 요청', vault_generate_login: '금고 로그인 만들기',
  desktop_apps: 'PC 앱 목록', desktop_snapshot: 'PC 화면 구조 읽기', desktop_screenshot: 'PC 화면 캡처', desktop_click: 'PC 클릭',
  desktop_fill: 'PC 값 채우기', desktop_type: 'PC 입력', desktop_select: 'PC 선택', desktop_check: 'PC 체크',
  desktop_scroll: 'PC 스크롤', desktop_press: 'PC 키 누르기', desktop_launch: 'PC 앱 열기', desktop_focus: 'PC 창 앞으로',
  desktop_wait: 'PC 대기', desktop_pointer: 'PC 포인터 직접 조작', desktop_keys: 'PC 키보드 직접 입력', desktop_propose: 'PC 클릭 제안',
  mail_search: '메일 찾기', mail_read: '메일 읽기', mail_update: '메일 정리', mail_send: '메일 보내기',
  toss_read: '토스증권 조회',
};
