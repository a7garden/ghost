import { expect, it } from 'vitest';
import { changeStatus, diffLines } from './codingChangesDisplay';

it('distinguishes diff metadata and hunk rows from source lines starting with extra +/-', () => {
  const lines = diffLines('diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n---literal\n+++literal\n same\n\\ No newline at end of file');
  expect(lines.map(line => line.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'deletion', 'addition', 'context', 'meta']);
  expect(lines[5]?.text).toBe('+++literal');
  expect(Object.values(changeStatus).map(item => [item.mark, item.label])).toEqual([
    ['A', '추가'], ['M', '수정'], ['D', '삭제'], ['R', '이름 변경'], ['?', '추적 안 됨'],
  ]);
});
