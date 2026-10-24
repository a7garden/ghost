/** Display a short excerpt; never change the saved model instructions. */
export function profileSummary(persona: string) {
  // lookbehind를 쓰지 않는다: macOS 13.0–13.2 WKWebView(Safari < 16.4)는 문법 자체가
  // SyntaxError라 번들 전체가 깨진다. 첫 문장 종결부호 뒤에서 잘라낸다.
  const first = persona.trim().split(/\n+/)[0].replace(/([.!?。！？])\s+[\s\S]*$/, '$1');
  if (!first) return '역할 미설정';
  // Tool identifiers belong in the full instructions, not the role introduction.
  if (/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/.test(first)) return '역할 지시가 설정되어 있습니다.';
  return first.replaceAll('오케스트레이터', '작업 조율자').replaceAll('bounded task', '범위가 정해진 작업');
}
