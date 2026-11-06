import type { Snapshot } from './types';
import { taskDisplayLabel } from './taskLabel';
import { ghostDisplayName } from '../features/profileSummary';

export type SearchHit = { kind: 'ghost' | 'work' | 'space'; id: string; title: string; subtitle?: string; path: string; profile_id?: string };

// 작업실 검색의 단일 출처. 입력 상자 문구("Ghost, 맡긴 일, 문서 공간 검색")가 약속하는 범위 —
// Ghost 이름·역할, 목표, 대화와 대화 작업, 반복 작업, 문서 공간 이름 — 를 하나의 순서로 묶는다.
export function searchWorkspace(snapshot: Pick<Snapshot, 'profiles' | 'goals' | 'schedules' | 'spaces'>, query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  for (const p of snapshot.profiles) {
    const name = ghostDisplayName(p);
    if (`${p.name} ${name} ${p.persona}`.toLowerCase().includes(q)) hits.push({ kind: 'ghost', id: p.id, title: name, subtitle: p.persona, path: `/ghosts/${p.id}`, profile_id: p.id });
    for (const g of snapshot.goals) {
      if (g.profile_id !== p.id || !g.title.toLowerCase().includes(q)) continue;
      hits.push({ kind: 'work', id: `goal:${g.id}`, title: g.title, path: '/work' });
    }
    for (const c of p.conversations) {
      const emitted = new Set<string>();
      if (c.title.toLowerCase().includes(q)) {
        emitted.add(c.title);
        hits.push({ kind: 'work', id: `conversation:${c.id}`, title: c.title, subtitle: `${p.name} · 대화`, path: `/ghosts/${p.id}?conversation=${c.id}` });
      }
      for (const t of c.tasks) {
        const label = taskDisplayLabel(t, c);
        if (!label.toLowerCase().includes(q) || emitted.has(label)) continue;
        emitted.add(label);
        hits.push({ kind: 'work', id: `task:${t.id}`, title: label, subtitle: `${p.name} · ${c.title}`, path: `/ghosts/${p.id}?conversation=${c.id}` });
      }
    }
    for (const s of snapshot.schedules) {
      if (s.profile_id !== p.id || !s.prompt.toLowerCase().includes(q)) continue;
      hits.push({ kind: 'work', id: `schedule:${s.id}`, title: s.prompt, subtitle: `${p.name} · 반복 작업`, path: `/ghosts/${p.id}?conversation=${s.conversation_id}` });
    }
  }
  for (const s of snapshot.spaces) {
    if (s.name.toLowerCase().includes(q)) hits.push({ kind: 'space', id: s.id, title: s.name, path: `/spaces/${s.id}` });
  }
  return hits;
}
