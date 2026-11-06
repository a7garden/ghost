import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Page } from '../client/types';
import { initialWorkspace } from '../fixtures/workspace';
import { DocumentList, SpacesView } from './SpacesView';

const page = (overrides: Partial<Page>): Page => ({
  id: 'page-1', locator: 'note.md', title: '주간 기록', profile: 'pdc-markdown/1', ...overrides,
});

function renderSpace(selectedSpace?: string) {
  const snapshot = initialWorkspace();
  snapshot.capabilities.documents = true;
  return renderToStaticMarkup(createElement(SpacesView, {
    snapshot, selectedSpace, query: async () => [], action: async () => ({}), onReview: () => {},
    connected: true, busy: false, mode: 'live', onSelectFolder: () => {}, theme: 'light',
  }));
}

it('titles the project page with the project name and offers a new document', () => {
  const html = renderSpace('space-ghost');
  expect(html).toContain('Ghost 프로젝트');
  expect(html).toContain('저장된 문서');
  expect(html).toContain('새 문서');
});

it('reports a missing project instead of an empty list', () => {
  const html = renderSpace('space-missing');
  expect(html).toContain('프로젝트를 찾을 수 없습니다.');
});

it('lists the project documents with their state', () => {
  const html = renderToStaticMarkup(createElement(DocumentList, {
    pages: [page({}), page({ id: 'page-2', locator: 'old.md', title: '이전 문서', deleted: true }),
      page({ id: 'page-3', locator: 'legacy.md', title: '이전 형식 문서', legacy: true })],
    opening: false,
    onOpen: () => {},
  }));
  expect(html).toContain('문서 목록');
  expect(html).toContain('주간 기록');
  expect(html).toContain('삭제됨');
  expect(html).toContain('읽기 전용');
});

it('keeps document rows as the control that opens a document', () => {
  const html = renderToStaticMarkup(createElement(DocumentList, {
    pages: [page({})], opening: false, onOpen: () => {},
  }));
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain('주간 기록');
});
