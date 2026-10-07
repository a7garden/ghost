import { useEffect, useState } from 'react';
import { isGhostColor } from './appearance';

export function GhostColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const [draft, setDraft] = useState(value === 'auto' ? '' : value), [touched, setTouched] = useState(false);
  useEffect(() => { setDraft(value === 'auto' ? '' : value); setTouched(false); }, [value]);
  return <fieldset className="ghost-color-setting pet-fieldset"><legend>기본 Ghost 색</legend><div className="ghost-color-controls">
    <button className="filter-button" aria-pressed={value === 'auto'} onClick={() => onChange('auto')}>테마에 맞춤</button>
    {[{ name: '검정', color: '#000000' }, { name: '흰색', color: '#ffffff' }].map(item => <button className="ghost-color-swatch" key={item.color} style={{ backgroundColor: item.color }} aria-label={item.name} aria-pressed={value === item.color} onClick={() => onChange(item.color)}/>)}
    <label className="ghost-custom-color"><span className="sr-only">직접 색 선택</span><input type="color" value={value === 'auto' ? '#000000' : value} onChange={e => onChange(e.target.value)} aria-label="직접 색 선택"/></label>
    <input className="ghost-color-value" aria-label="Ghost 색 HEX" placeholder="#RRGGBB" value={draft} maxLength={7} spellCheck={false} onChange={e => { setDraft(e.target.value); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value.toLowerCase()); }} onBlur={() => setTouched(true)} aria-invalid={touched && Boolean(draft) && !isGhostColor(draft)}/>
  </div>{touched && draft && !isGhostColor(draft) && <p className="form-error" role="alert"># 뒤에 여섯 자리 색상 코드를 입력해 주세요.</p>}</fieldset>;
}
