/** Display a short excerpt; never change the saved model instructions. */
export function profileSummary(persona: string) {
  const first = persona.trim().split(/(?<=[.!?。！？])\s+|\n+/)[0];
  if (!first) return '역할 미설정';
  // Tool identifiers belong in the full instructions, not the role introduction.
  if (/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/.test(first)) return '역할 지시가 설정되어 있습니다.';
  return first.replaceAll('오케스트레이터', '작업 조율자').replaceAll('bounded task', '범위가 정해진 작업');
}
