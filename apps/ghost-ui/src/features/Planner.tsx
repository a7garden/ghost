import { useState } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Circle, Pencil, Plus, Trash2 } from 'lucide-react';
import { ConnectedPlanner } from './ConnectedPlanner';
import { Modal } from '../components/Modal';
import type { CalendarEvent, Command, Snapshot, Todo } from '../client/types';

type Action = (command: Command) => Promise<Record<string, any>>;
export const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const localTime = (ms: number) => { const d = new Date(ms); return `${localDate(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export function dayRange(day: string) { const start = new Date(`${day}T00:00:00`); const end = new Date(start); end.setDate(end.getDate() + 1); return [start.getTime(), end.getTime()] as const; }
export function eventsOnDay(events: CalendarEvent[], day: string) { const [from, to] = dayRange(day); return events.filter(e => e.start_ms < to && e.end_ms > from).sort((a, b) => a.start_ms - b.start_ms); }
export function weekDays(day: string) { const start = new Date(`${day}T12:00:00`); start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return localDate(d); }); }
const todoData = (t: Todo) => ({ title: t.title, notes: t.notes, due: t.due, completed: t.completed });
export function Planner({ snapshot, action, query, busy, connected = true }: { snapshot: Snapshot; action: Action; query: Action; busy: boolean; connected?: boolean }) {
  const [day, setDay] = useState(() => localDate(new Date())), [filter, setFilter] = useState('open');
  const [editor, setEditor] = useState<{ kind: 'todo'; item?: Todo } | { kind: 'event'; item?: CalendarEvent } | null>(null);
  const [error, setError] = useState(''), [formError, setFormError] = useState('');
  const todos = snapshot.todos.filter(t => filter === 'completed' ? t.completed : filter === 'day' ? !t.completed && t.due === day : !t.completed).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  const events = eventsOnDay(snapshot.calendar_events, day);
  const run = async (data: Record<string, unknown>) => { setError(''); try { await action({ type: 'workspace', action: data }); } catch (e) { setError(e instanceof Error ? e.message : '저장하지 못했습니다.'); } };
  const open = (e: NonNullable<typeof editor>) => { setFormError(''); setEditor(e); };
  const shift = (amount: number) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + amount); setDay(localDate(d)); };
  const save = async (form: HTMLFormElement) => {
    if (!editor) return;
    setFormError('');
    const fields = new FormData(form), title = String(fields.get('title')).trim(), notes = String(fields.get('notes') ?? '');
    try {
      const data = editor.kind === 'todo' ? { type: 'save_todo', id: editor.item?.id ?? null, version: editor.item?.version ?? null, todo: { title, notes, due: fields.get('due') || null, completed: editor.item?.completed ?? false } } : { type: 'save_calendar_event', id: editor.item?.id ?? null, version: editor.item?.version ?? null, event: { title, notes, start_ms: new Date(String(fields.get('start'))).getTime(), end_ms: new Date(String(fields.get('end'))).getTime() } };
      if ('event' in data && data.event && (!Number.isFinite(data.event.start_ms) || !Number.isFinite(data.event.end_ms) || data.event.end_ms <= data.event.start_ms)) throw new Error('종료 시각을 시작 시각 이후로 정해 주세요.');
      await action({ type: 'workspace', action: data }); setEditor(null);
    } catch (e) { setFormError(e instanceof Error ? e.message : '저장하지 못했습니다.'); }
  };
  const remove = async () => {
    if (!editor?.item) return;
    try { await action({ type: 'workspace', action: { type: editor.kind === 'todo' ? 'delete_todo' : 'delete_calendar_event', id: editor.item.id, version: editor.item.version } }); setEditor(null); } catch (e) { setFormError(e instanceof Error ? e.message : '삭제하지 못했습니다.'); }
  };
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <div className="page-content planner-page">
    <div className="page-heading"><div><h1>할 일과 일정</h1></div><CalendarDays size={25} className="muted"/></div>
    <div className="planner-date"><button className="icon-button" aria-label="이전 날짜" onClick={() => shift(-1)}><ChevronLeft size={18}/></button><label><span className="sr-only">선택 날짜</span><input type="date" value={day} onChange={e => { if (e.target.value) setDay(e.target.value); }}/></label><button className="icon-button" aria-label="다음 날짜" onClick={() => shift(1)}><ChevronRight size={18}/></button><button className="button secondary" onClick={() => setDay(localDate(new Date()))}>오늘</button><span className="field-help">{zone}</span></div>
    <nav className="planner-week" aria-label="주간 선택">{weekDays(day).map(d => { const date = new Date(`${d}T12:00:00`); const count = snapshot.todos.filter(t => !t.completed && t.due === d).length + eventsOnDay(snapshot.calendar_events, d).length; return <button key={d} type="button" className={`planner-week-cell ${d === day ? 'selected' : ''}${d === localDate(new Date()) ? ' today' : ''}`} aria-pressed={d === day} aria-current={d === localDate(new Date()) ? 'date' : undefined} onClick={() => setDay(d)}><span className="planner-week-day">{date.toLocaleDateString('ko-KR', { weekday: 'short' })}</span><span className="planner-week-num">{date.getDate()}</span>{count > 0 && <span className="planner-week-count"><span className="mini-dot"/>{count}</span>}</button>; })}</nav>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="planner-columns"><section><div className="section-heading"><h2>Ghost에 저장한 할 일 <span className="muted">{snapshot.todos.filter(t => !t.completed).length}</span></h2><button className="button secondary" onClick={() => open({ kind: 'todo' })}><Plus size={15}/>할 일 추가</button></div>
      <div className="filter-options">{[['open', '미완료'], ['day', '선택한 날짜'], ['completed', '완료']].map(([id, label]) => <button key={id} className={`filter-button ${filter === id ? 'selected' : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
      <div className="planner-list">{todos.map(t => <article className="planner-row" key={t.id}><button className={`icon-button todo-check ${t.completed ? 'completed' : ''}`} aria-label={`${t.title} ${t.completed ? '다시 열기' : '완료'}`} disabled={busy} onClick={() => void run({ type: 'save_todo', id: t.id, version: t.version, todo: { ...todoData(t), completed: !t.completed } })}>{t.completed ? <Check size={19}/> : <Circle size={19}/>}</button><button className="planner-item" onClick={() => open({ kind: 'todo', item: t })}><strong className={t.completed ? 'completed-title' : ''}>{t.title}</strong>{t.notes && <span>{t.notes}</span>}{t.due && <small className={!t.completed && t.due < localDate(new Date()) ? 'overdue' : ''}>{t.due}{!t.completed && t.due < localDate(new Date()) ? ' · 기한 지남' : ''}</small>}</button><button className="icon-button" aria-label={`${t.title} 수정`} onClick={() => open({ kind: 'todo', item: t })}><Pencil size={14}/></button></article>)}</div>
      {!todos.length && <div className="quiet-empty"><Check size={18}/>{filter === 'completed' ? '완료한 일이 여기에 모입니다.' : '할 일을 추가하거나 Ghost에게 기록을 부탁하세요.'}</div>}
    </section><section><div className="section-heading"><h2>Ghost에 저장한 일정 <span className="muted">{events.length}</span></h2><button className="button secondary" onClick={() => open({ kind: 'event' })}><Plus size={15}/>일정 추가</button></div><p className="planner-caption">{new Date(`${day}T12:00:00`).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' })}</p>
      <div className="planner-list">{events.map(e => <button className="planner-event" key={e.id} onClick={() => open({ kind: 'event', item: e })}><span className="event-time">{new Date(e.start_ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}<small>{localDate(new Date(e.end_ms)) !== day ? localDate(new Date(e.end_ms)) + ' ' : ''}{new Date(e.end_ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</small></span><span className="planner-item"><strong>{e.title}</strong>{e.notes && <span>{e.notes}</span>}</span><Pencil size={14}/></button>)}</div>
      {!events.length && <div className="quiet-empty"><CalendarDays size={18}/>등록한 일정이 없는 날이에요.</div>}
    </section></div><p className="planner-footnote">이 목록은 Ghost에 저장됩니다. 연결된 목록으로 자동 이동하거나 복제하지 않습니다.</p>
    <ConnectedPlanner planner={snapshot.connected_planner} workspaceId={snapshot.workspace_id} query={query} action={action} busy={busy} connected={connected}/>
    {editor && <Modal title={`${editor.kind === 'todo' ? '할 일' : '일정'} ${editor.item ? '수정' : '추가'}`} onClose={() => { if (!busy) setEditor(null); }}><form className="form-stack" onSubmit={e => { e.preventDefault(); void save(e.currentTarget); }}><label>제목<input name="title" defaultValue={editor.item?.title} required maxLength={500} autoFocus placeholder={editor.kind === 'todo' ? '예: 세금 자료 정리하기' : '예: 점심 약속'}/></label>
      {editor.kind === 'todo' ? <label>마감일 <span className="muted">선택</span><input name="due" type="date" defaultValue={editor.item?.due ?? ''}/></label> : <div className="form-pair"><label>시작<input name="start" type="datetime-local" required defaultValue={editor.item ? localTime(editor.item.start_ms) : `${day}T09:00`}/></label><label>종료<input name="end" type="datetime-local" required defaultValue={editor.item ? localTime(editor.item.end_ms) : `${day}T10:00`}/></label></div>}
      <label>메모 <span className="muted">선택</span><textarea name="notes" rows={3} maxLength={8192} defaultValue={editor.item?.notes}/></label>{editor.kind === 'event' && <p className="field-help">{zone} 기준으로 저장합니다. 초대장이나 알림은 전송하지 않습니다.</p>}{formError && <p className="form-error" role="alert">{formError}</p>}<div className="form-actions">{editor.item && <button type="button" className="button secondary" disabled={busy} onClick={() => void remove()}><Trash2 size={15}/>삭제</button>}<button className="button primary" disabled={busy}>{busy ? '저장 중…' : '저장'}<Check size={15}/></button></div>
    </form></Modal>}
  </div>;
}
