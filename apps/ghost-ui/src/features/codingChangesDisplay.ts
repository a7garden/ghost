import type { CodingSessionChanges } from '../host/client';

export const changeStatus: Record<CodingSessionChanges['files'][number]['status'], { mark: string; label: string; tone: string }> = {
  added: { mark: 'A', label: '추가', tone: 'positive' },
  modified: { mark: 'M', label: '수정', tone: 'neutral' },
  deleted: { mark: 'D', label: '삭제', tone: 'negative' },
  renamed: { mark: 'R', label: '이름 변경', tone: 'neutral' },
  untracked: { mark: '?', label: '추적 안 됨', tone: 'positive' },
};

export function diffLines(diff: string) {
  let inHunk = false;
  return diff.split('\n').map(text => {
    if (text.startsWith('diff --git ')) inHunk = false;
    if (text.startsWith('@@')) {
      inHunk = true;
      return { text, kind: 'hunk' } as const;
    }
    const kind = !inHunk || text.startsWith('\\') ? 'meta'
      : text.startsWith('+') ? 'addition' : text.startsWith('-') ? 'deletion' : 'context';
    return { text, kind } as const;
  });
}
