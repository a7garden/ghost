import { useEffect, useState } from 'react';
import { isHexColor } from './appearance';

export type ColorPreset = { name: string; color: string };
const defaultPresets = [{ name: '검정', color: '#000000' }, { name: '흰색', color: '#ffffff' }];

export function GhostColorPicker({
  value, onChange, label = '기본 Ghost 색', resetLabel = '테마에 맞춤', fallback = '#000000', presets = defaultPresets,
}: {
  value: string; onChange: (color: string) => void; label?: string; resetLabel?: string;
  fallback?: string; presets?: readonly ColorPreset[];
}) {
  const [draft, setDraft] = useState(value === 'auto' ? '' : value), [touched, setTouched] = useState(false);
  useEffect(() => { setDraft(value === 'auto' ? '' : value); setTouched(false); }, [value]);
  const invalid = touched && Boolean(draft) && !isHexColor(draft);
  const choose = (color: string) => {
    setDraft(color === 'auto' ? '' : color);
    setTouched(false);
    onChange(color);
  };
  return <fieldset className="ghost-color-setting pet-fieldset"><legend>{label}</legend>
    <div className="ghost-color-palette">
      {presets.map(item => <button type="button" className="ghost-color-swatch" key={item.color}
        style={{ backgroundColor: item.color }} title={item.name} aria-label={item.name}
        aria-pressed={value === item.color} onClick={() => choose(item.color)}/>)}
    </div>
    <div className="ghost-color-controls">
      <button type="button" className="filter-button" aria-pressed={value === 'auto'} onClick={() => choose('auto')}>{resetLabel}</button>
      <label className="ghost-custom-color" title="직접 색 선택">
        <input type="color" value={value === 'auto' ? fallback : value}
          onChange={e => choose(e.target.value)} aria-label={`${label} 직접 선택`}/>
      </label>
      <input className="ghost-color-value" aria-label={`${label} HEX`} placeholder="#RRGGBB"
        value={draft} maxLength={7} spellCheck={false} autoCapitalize="off" autoComplete="off"
        onChange={e => {
          setDraft(e.target.value);
          if (isHexColor(e.target.value)) onChange(e.target.value.toLowerCase());
        }}
        onBlur={() => setTouched(true)} aria-invalid={invalid}/>
    </div>
    {invalid && <p className="form-error" role="alert"># 뒤에 여섯 자리 색상 코드를 입력해 주세요.</p>}
  </fieldset>;
}
