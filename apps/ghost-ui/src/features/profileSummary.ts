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

// Profile names the Host creates for its starter Ghosts (src/host/mod.rs). They are identifiers, not names a person picked.
const starterNames: Record<string, string> = {
  primary: '주 Ghost',
  'specialist-research': '리서치',
  'specialist-engineering': '엔지니어링',
  'specialist-operations': '운영',
};

/** Name shown for a Ghost; owner-chosen names are shown as saved. */
export function ghostDisplayName(name: string) {
  return starterNames[name] ?? name;
}
