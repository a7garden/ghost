import type { Look, LookFace, LookMark } from '@ghost/contract';
import { GhostCharacter } from './GhostCharacter';
import { GHOST_PALETTE, defaultBodyColor } from './appearance';

const faces: { value: LookFace; label: string }[] = [
  { value: 'bars', label: '기본 눈' }, { value: 'dots', label: '동그란 눈' }, { value: 'arcs', label: '웃는 눈' }, { value: 'tall', label: '긴 눈' },
];
const marks: { value: LookMark; label: string }[] = [
  { value: 'none', label: '장식 없음' }, { value: 'halo', label: '후광' }, { value: 'antenna', label: '안테나' },
  { value: 'sprout', label: '새싹' }, { value: 'ring', label: '고리' }, { value: 'spark', label: '반짝임' },
];
const backgrounds = [
  { name: '없음', color: '' }, { name: '안개', color: '#eef0f3' }, { name: '하늘', color: '#dbeaff' }, { name: '민트', color: '#d7f0e4' },
  { name: '라일락', color: '#e9e1fa' }, { name: '복숭아', color: '#fbe3d6' }, { name: '모래', color: '#f3e8cf' }, { name: '먹', color: '#202125' },
];

/**
 * The built-in Ghost's look in one place: a live preview, then color, eyes, accent and tile.
 * Every choice is a picture of the result, so the editor reads without labels.
 */
export function LookEditor({ ghostId, look, disabled, onChange }: { ghostId: string; look: Look; disabled: boolean; onChange(patch: Partial<Look>): void }) {
  const body = look.body || '';
  const face = look.face ?? 'bars';
  const mark = look.mark ?? 'none';
  const fallback = defaultBodyColor(ghostId);
  return <div className="look-editor"><div className="look-editor__layout">
    <div className="look-editor__stage" style={{ backgroundColor: look.background || undefined }}>
      <GhostCharacter size={128} color={body} fallback={fallback} face={face} mark={mark} animate={false}/>
    </div>
    <div className="look-editor__rows">
      <fieldset className="look-editor__row"><legend>색</legend>
        <div className="look-editor__swatches">
          <button type="button" className="look-swatch" data-auto aria-pressed={!body} disabled={disabled} title="자동" aria-label="자동 색" onClick={() => onChange({ body: '' })}
            style={{ background: `conic-gradient(${fallback} 0 50%, var(--ghost-hover2) 50%)` }}/>
          {GHOST_PALETTE.map(item => <button key={item.color} type="button" className="look-swatch" aria-pressed={body === item.color} disabled={disabled}
            title={item.name} aria-label={item.name} style={{ background: item.color }} onClick={() => onChange({ body: item.color })}/>)}
          <label className="look-swatch look-swatch--custom" title="직접 고르기">
            <input type="color" value={body || fallback} disabled={disabled} aria-label="색 직접 고르기" onChange={event => onChange({ body: event.target.value })}/>
          </label>
        </div>
      </fieldset>
      <fieldset className="look-editor__row"><legend>눈</legend>
        <div className="look-editor__options">{faces.map(item => <button key={item.value} type="button" className="look-option" aria-pressed={face === item.value} disabled={disabled}
          title={item.label} aria-label={item.label} onClick={() => onChange({ face: item.value })}>
          <GhostCharacter size={40} color={body} fallback={fallback} face={item.value} animate={false}/>
        </button>)}</div>
      </fieldset>
      <fieldset className="look-editor__row"><legend>장식</legend>
        <div className="look-editor__options">{marks.map(item => <button key={item.value} type="button" className="look-option" aria-pressed={mark === item.value} disabled={disabled}
          title={item.label} aria-label={item.label} onClick={() => onChange({ mark: item.value })}>
          <GhostCharacter size={40} color={body} fallback={fallback} face={face} mark={item.value} animate={false}/>
        </button>)}</div>
      </fieldset>
      <fieldset className="look-editor__row"><legend>배경</legend>
        <div className="look-editor__swatches">{backgrounds.map(item => <button key={item.name} type="button" className="look-swatch" data-empty={!item.color || undefined}
          aria-pressed={(look.background || '') === item.color} disabled={disabled} title={item.name} aria-label={`배경 ${item.name}`}
          style={item.color ? { background: item.color } : undefined} onClick={() => onChange({ background: item.color })}/>)}</div>
      </fieldset>
    </div>
  </div></div>;
}
