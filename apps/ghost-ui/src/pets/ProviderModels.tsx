import { useId, useMemo, useState } from 'react';
import { Cpu, X } from 'lucide-react';
import type { ModelInfo } from '@ghost/contract';
import { Button, Checkbox, InlineError, Input } from '../ui';
import { mergeModels, toggleModel } from './provider-models';

/** 128000 → '128K', 1500000 → '1.5M'; '' when unknown. */
function contextLabel(contextWindow: number | undefined): string {
  if (!contextWindow) return '';
  for (const [divisor, suffix] of [[1_000_000, 'M'], [1_000, 'K']] as const) {
    if (contextWindow >= divisor) {
      const scaled = contextWindow / divisor;
      return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}${suffix}`;
    }
  }
  return String(contextWindow);
}

type ModelRow = { model: ModelInfo; known: boolean; index: number };

/** Effective catalog with manual additions; automatic providers need no per-model enabling. */
export function ProviderModels({ catalog, selected, onChange, automatic = false, disabled = false }: {
  catalog: ModelInfo[];
  selected: ModelInfo[];
  onChange: (models: ModelInfo[]) => void;
  automatic?: boolean;
  disabled?: boolean;
}) {
  const idPrefix = useId();
  const [query, setQuery] = useState('');
  const [draftId, setDraftId] = useState('');
  const [error, setError] = useState('');

  const merged = useMemo(() => mergeModels(selected, catalog), [selected, catalog]);
  const selectedIds = useMemo(() => new Set(selected.map(model => model.id)), [selected]);
  const catalogIds = useMemo(() => new Set(catalog.map(model => model.id)), [catalog]);
  const rows = useMemo<ModelRow[]>(() => merged.map((model, index) => ({
    model, known: catalogIds.has(model.id), index,
  })), [merged, catalogIds]);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? rows.filter(row => row.model.id.toLowerCase().includes(needle) || row.model.name.toLowerCase().includes(needle))
    : rows;

  const addCustom = () => {
    const id = draftId.trim();
    if (!id) { setError('모델 ID를 입력해 주세요.'); return; }
    if (id.length > 256) { setError('모델 ID는 256자 이하로 입력해 주세요.'); return; }
    if (selectedIds.has(id) || (automatic && catalogIds.has(id))) { setError(`이미 등록된 모델 ID입니다: ${id}`); return; }
    if (selected.length >= 256) { setError('모델은 최대 256개까지 선택할 수 있습니다.'); return; }
    const known = catalog.find(model => model.id === id);
    onChange([...selected, known ? { ...known } : { id, name: '' }]);
    setDraftId('');
    setError('');
  };

  return <fieldset className="provider-models" disabled={disabled}>
    <legend>모델 · {automatic ? merged.length : selected.length}개</legend>
    <div className="flex min-w-0 items-center gap-2">
      <Input aria-label="모델 검색" placeholder="모델 검색" value={query} maxLength={200} spellCheck={false}
        className="min-w-0 flex-1" disabled={disabled}
        onChange={event => setQuery(event.target.value)}/>
      {query && <Button variant="ghost" size="icon" type="button" aria-label="검색 지우기" disabled={disabled}
        onClick={() => setQuery('')}><X size={15}/></Button>}
    </div>
    <div className="provider-models__list">
      {visible.map(row => {
        const rowId = `${idPrefix}-m${row.index}`;
        const meta = [contextLabel(row.model.contextWindow), row.model.reasoning ? '추론' : ''].filter(Boolean).join(' · ');
        const Row = automatic ? 'div' : 'label';
        return <Row key={row.model.id} htmlFor={automatic ? undefined : rowId} className="provider-models__row">
          {automatic ? <Cpu size={15} aria-hidden="true" className="text-ink-3"/> :
          <Checkbox id={rowId} className="flex-none" checked={selectedIds.has(row.model.id)} disabled={disabled || (!selectedIds.has(row.model.id) && selected.length >= 256)}
            aria-label={row.model.name || row.model.id} onCheckedChange={checked => onChange(toggleModel(selected, row.model, checked === true))}/>}
          <span className="provider-models__copy">
            <span className="model-row-title">{row.model.name || row.model.id}</span>
            <span className="model-meta">
              {[row.model.name && row.model.name !== row.model.id ? row.model.id : '', !row.known ? '직접 추가' : ''].filter(Boolean).join(' · ')}
            </span>
          </span>
          <span className="provider-models__value">
            {meta && <span>{meta}</span>}
            {automatic && !row.known && <Button variant="ghost" size="icon" type="button" aria-label={`${row.model.id} 삭제`} disabled={disabled}
              onClick={() => onChange(selected.filter(model => model.id !== row.model.id))}><X size={14}/></Button>}
          </span>
        </Row>;
      })}
      {needle && !visible.length && <p className="m-0 py-2 text-caption text-ink-3">"{query.trim()}" 검색 결과가 없습니다.</p>}
      {!needle && !rows.length && <p className="m-0 py-2 text-caption text-ink-3">카탈로그에 모델이 없습니다. 모델 ID를 직접 추가해 사용해 주세요.</p>}
    </div>
    {selected.length >= 256 && <p className="m-0 text-caption text-ink-3">모델은 최대 256개까지 선택할 수 있습니다.</p>}
    <details className="shrink-0">
      <summary className="connection-advanced">모델 ID 직접 추가</summary>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <Input aria-label="추가할 모델 ID" placeholder="모델 ID" value={draftId} maxLength={256} spellCheck={false}
          autoCapitalize="off" autoComplete="off" className="min-w-0 flex-1" disabled={disabled}
          onChange={event => setDraftId(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); addCustom(); } }}/>
        <Button className="flex-none" variant="add" type="button" onClick={addCustom} disabled={disabled || !draftId.trim()}>
          추가</Button>
      </div>
      {error && <div className="mt-2"><InlineError>{error}</InlineError></div>}
    </details>
  </fieldset>;
}
