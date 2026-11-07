import { useEffect, useState } from 'react';
import { InlineError, Input } from '../ui'
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
  return <fieldset className="m-0 flex min-w-0 flex-col gap-2.5"><legend className="text-caption text-ink-2">{label}</legend>
    <div className="flex flex-wrap gap-2">
      {presets.map(item => <button type="button" key={item.color}
        className="ghost-color-swatch"
        style={{ backgroundColor: item.color }} title={item.name} aria-label={item.name}
        aria-pressed={value === item.color} onClick={() => choose(item.color)}/>)}
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="inline-flex h-7 cursor-pointer items-center rounded-control px-3 text-ui font-medium transition-[color,background-color] outline-none hover:bg-hover hover:text-ink focus-visible:ring-[2px] focus-visible:ring-ring/40 aria-pressed:bg-secondary aria-pressed:text-secondary-foreground"
        aria-pressed={value === 'auto'} onClick={() => choose('auto')}>{resetLabel}</button>
      <label className="flex" title="직접 색 선택">
        <input type="color" className="h-7 w-9 cursor-pointer rounded-control border-0 bg-transparent p-0.5 outline-none"
          value={value === 'auto' ? fallback : value}
          onChange={e => choose(e.target.value)} aria-label={`${label} 직접 선택`}/>
      </label>
      <Input className="w-[100px] text-caption" aria-label={`${label} HEX`} placeholder="#RRGGBB"
        value={draft} maxLength={7} spellCheck={false} autoCapitalize="off" autoComplete="off"
        onChange={e => {
          setDraft(e.target.value);
          if (isHexColor(e.target.value)) onChange(e.target.value.toLowerCase());
        }}
        onBlur={() => setTouched(true)} aria-invalid={invalid || undefined}/>
    </div>
    {invalid && <InlineError># 뒤에 여섯 자리 색상 코드를 입력해 주세요.</InlineError>}
  </fieldset>;
}
