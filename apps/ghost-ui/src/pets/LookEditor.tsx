import { Shuffle } from 'lucide-react';
import type { Look, LookFace, LookMark, LookShape } from '@ghost/contract';
import { GhostCharacter } from './GhostCharacter';
import { GHOST_PALETTE, defaultBodyColor } from './appearance';

const shapes: { value: LookShape; label: string }[] = [
  { value: 'round', label: '동그라미' }, { value: 'egg', label: '달걀' }, { value: 'squircle', label: '둥근 네모' }, { value: 'sheet', label: '유령' },
];
const faces: { value: LookFace; label: string }[] = [
  { value: 'bars', label: '기본 눈' }, { value: 'dots', label: '동그란 눈' }, { value: 'arcs', label: '웃는 눈' }, { value: 'tall', label: '긴 눈' },
];
const marks: { value: LookMark; label: string }[] = [
  { value: 'none', label: '장식 없음' }, { value: 'halo', label: '후광' }, { value: 'antenna', label: '안테나' },
  { value: 'sprout', label: '새싹' }, { value: 'ring', label: '고리' }, { value: 'spark', label: '반짝임' },
  { value: 'crown', label: '왕관' }, { value: 'bow', label: '리본' }, { value: 'ears', label: '고양이 귀' },
  { value: 'horns', label: '뿔' }, { value: 'headphones', label: '헤드폰' }, { value: 'glasses', label: '안경' },
];
const backgrounds = [
  { name: '없음', color: '' }, { name: '안개', color: '#eef0f3' }, { name: '하늘', color: '#dbeaff' }, { name: '민트', color: '#d7f0e4' },
  { name: '라일락', color: '#e9e1fa' }, { name: '복숭아', color: '#fbe3d6' }, { name: '모래', color: '#f3e8cf' }, { name: '먹', color: '#202125' },
];

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

/** A different look in every part, so a shuffle always visibly changes the Ghost. */
function shuffled(current: Look): Partial<Look> {
  const other = <T extends { value: string }>(items: readonly T[], value: string | undefined) => pick(items.filter(item => item.value !== value)).value;
  return {
    body: pick(GHOST_PALETTE.filter(item => item.color !== current.body)).color,
    shape: other(shapes, current.shape ?? 'round') as LookShape,
    face: other(faces, current.face ?? 'bars') as LookFace,
    mark: other(marks, current.mark ?? 'none') as LookMark,
    background: pick(backgrounds.filter(item => item.color !== (current.background || ''))).color,
  };
}

/**
 * The built-in Ghost's look in one place: a live preview, then color, body, eyes, accent and tile.
 * Every choice is a picture of the result; the legend names the current pick.
 */
export function LookEditor({ ghostId, look, disabled, onChange }: { ghostId: string; look: Look; disabled: boolean; onChange(patch: Partial<Look>): void }) {
  const body = look.body || '';
  const shape = look.shape ?? 'round';
  const face = look.face ?? 'bars';
  const mark = look.mark ?? 'none';
  const fallback = defaultBodyColor(ghostId);
  const colorName = body ? GHOST_PALETTE.find(item => item.color === body)?.name ?? '직접 고른 색' : '자동';
  const signature = `${body}|${shape}|${face}|${mark}`;
  return <div className="look-editor"><div className="look-editor__layout">
    <div className="look-editor__preview">
      <div className="look-editor__stage" style={{ backgroundColor: look.background || undefined }}>
        {/* Remounting on each change replays the pop; the inner layer floats. */}
        <div key={signature} className="look-editor__figure">
          <div className="look-editor__float"><GhostCharacter size={136} color={body} fallback={fallback} shape={shape} face={face} mark={mark} animate={false}/></div>
        </div>
      </div>
      <button type="button" className="look-editor__shuffle" disabled={disabled} onClick={() => onChange(shuffled(look))}>
        <Shuffle size={14} aria-hidden="true"/>무작위
      </button>
    </div>
    <div className="look-editor__rows">
      <fieldset className="look-editor__row"><legend>색<span>{colorName}</span></legend>
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
      <fieldset className="look-editor__row"><legend>모양<span>{shapes.find(item => item.value === shape)?.label}</span></legend>
        <div className="look-editor__options">{shapes.map(item => <button key={item.value} type="button" className="look-option" aria-pressed={shape === item.value} disabled={disabled}
          title={item.label} aria-label={item.label} onClick={() => onChange({ shape: item.value })}>
          <GhostCharacter size={40} color={body} fallback={fallback} shape={item.value} face={face} animate={false}/>
        </button>)}</div>
      </fieldset>
      <fieldset className="look-editor__row"><legend>눈<span>{faces.find(item => item.value === face)?.label}</span></legend>
        <div className="look-editor__options">{faces.map(item => <button key={item.value} type="button" className="look-option" aria-pressed={face === item.value} disabled={disabled}
          title={item.label} aria-label={item.label} onClick={() => onChange({ face: item.value })}>
          <GhostCharacter size={40} color={body} fallback={fallback} shape={shape} face={item.value} animate={false}/>
        </button>)}</div>
      </fieldset>
      <fieldset className="look-editor__row"><legend>장식<span>{marks.find(item => item.value === mark)?.label}</span></legend>
        <div className="look-editor__options">{marks.map(item => <button key={item.value} type="button" className="look-option" aria-pressed={mark === item.value} disabled={disabled}
          title={item.label} aria-label={item.label} onClick={() => onChange({ mark: item.value })}>
          <GhostCharacter size={40} color={body} fallback={fallback} shape={shape} face={face} mark={item.value} animate={false}/>
        </button>)}</div>
      </fieldset>
      <fieldset className="look-editor__row"><legend>배경<span>{backgrounds.find(item => item.color === (look.background || ''))?.name ?? '직접 고른 색'}</span></legend>
        <div className="look-editor__swatches">{backgrounds.map(item => <button key={item.name} type="button" className="look-swatch" data-empty={!item.color || undefined}
          aria-pressed={(look.background || '') === item.color} disabled={disabled} title={item.name} aria-label={`배경 ${item.name}`}
          style={item.color ? { background: item.color } : undefined} onClick={() => onChange({ background: item.color })}/>)}</div>
      </fieldset>
    </div>
  </div></div>;
}
