import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Plus, Search, X } from 'lucide-react';
import type { ModelRef } from '@ghost/contract';
import { Popover, PopoverContent, PopoverTrigger } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { usableProviders } from '../pets/ModelPicker';
import { blurTouchSearchOnEnter } from '../ui/adaptive';
import './ghost-settings.css';

/*
 * 대체 모델 목록 — Ghost 설정의 모델 경로와 모델 설정의 기본 대체 모델이 함께 쓴다.
 * 2026.11.11 : 모델 설정이 Ghost 설정 화면 전체를 끌어오지 않도록 GhostSettings 에서 떼어 냈다.
 */

export const MAX_FALLBACKS = 3;

/** One owner edit of the fallback list. Pure; tests pin what each action saves. */
export type FallbackAction =
  | { kind: 'add'; model: ModelRef }
  | { kind: 'replace'; index: number; model: ModelRef }
  | { kind: 'remove'; index: number }
  | { kind: 'move'; index: number; delta: 1 | -1 };

/** The next fallback list after an owner edit; adds cap at three and moves clamp at the ends. */
export function editFallbacks(fallbacks: readonly ModelRef[], action: FallbackAction): ModelRef[] {
  const next = [...fallbacks];
  const inside = (index: number) => Number.isInteger(index) && index >= 0 && index < next.length;
  if (action.kind === 'add') { if (next.length < MAX_FALLBACKS) next.push(action.model); }
  else if (action.kind === 'replace') { if (inside(action.index)) next[action.index] = action.model; }
  else if (action.kind === 'remove') { if (inside(action.index)) next.splice(action.index, 1); }
  else { const to = action.index + action.delta; if (inside(action.index) && inside(to)) [next[action.index], next[to]] = [next[to], next[action.index]]; }
  return next;
}

/** A model's display name from the settings, falling back to its id. */
export function modelName(settings: { providers: readonly { id: string; models: readonly { id: string; name?: string }[] }[] } | undefined, ref: ModelRef): string {
  const model = settings?.providers.find(item => item.id === ref.provider)?.models.find(item => item.id === ref.model);
  return model?.name || ref.model;
}

/**
 * The ordered fallback steps and the add step, shared by a Ghost's route and the owner's default list.
 * 2026.11.11 : 기본 대체 모델을 설정에 더하면서 Ghost 설정의 목록을 떼어 냈다 — 두 곳이 같은 손놀림이어야 한다.
 */
export function FallbackSteps({ fallbacks, primary, pending, onAction }: {
  fallbacks: readonly ModelRef[];
  primary: ModelRef | null;
  pending: boolean;
  onAction(action: FallbackAction): void;
}) {
  const used = [primary, ...fallbacks].filter((ref): ref is ModelRef => !!ref);
  return <>
    {fallbacks.map((fallback, index) => <li key={`${fallback.provider}/${fallback.model}:${index}`} className="model-route__step">
      <span className="model-route__node" aria-hidden="true">{index + 1}</span>
      <div className="model-route__choice">
        <span className="model-route__label">대체 {index + 1}</span>
        <ModelChoice label={`${index + 1}번 대체 모델 선택`} value={fallback} inherit={false} disabled={pending}
          excluded={used.filter(ref => ref.provider !== fallback.provider || ref.model !== fallback.model)}
          onChange={model => model && onAction({ kind: 'replace', index, model })}/>
      </div>
      <div className="model-route__actions" role="group" aria-label={`대체 ${index + 1} 순서와 삭제`}>
        <button type="button" aria-label={`${index + 1}번 위로`} title="앞으로" disabled={pending || index === 0} onClick={() => onAction({ kind: 'move', index, delta: -1 })}><ArrowUp aria-hidden="true"/></button>
        <button type="button" aria-label={`${index + 1}번 아래로`} title="뒤로" disabled={pending || index === fallbacks.length - 1} onClick={() => onAction({ kind: 'move', index, delta: 1 })}><ArrowDown aria-hidden="true"/></button>
        <button type="button" aria-label={`${index + 1}번 대체 모델 지우기`} title="삭제" disabled={pending} onClick={() => onAction({ kind: 'remove', index })}><X aria-hidden="true"/></button>
      </div>
    </li>)}
    {fallbacks.length < MAX_FALLBACKS && <li className="model-route__step" data-add>
      <span className="model-route__node" aria-hidden="true"><Plus/></span>
      <ModelChoice add value={null} excluded={used} disabled={pending} onChange={model => model && onAction({ kind: 'add', model })}/>
    </li>}
  </>;
}

export function ModelChoice({ value, onChange, add = false, inherit = true, excluded = [], disabled = false, label }: {
  value: ModelRef | null;
  onChange(model: ModelRef | null): void;
  add?: boolean;
  inherit?: boolean;
  excluded?: readonly ModelRef[];
  disabled?: boolean;
  label?: string;
}) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const settings = state?.settings;
  const providers = usableProviders(settings);
  const nameOf = (ref: ModelRef | null | undefined) => {
    if (!ref) return null;
    const provider = settings?.providers.find(item => item.id === ref.provider);
    const model = provider?.models.find(item => item.id === ref.model);
    return { provider: provider?.name ?? ref.provider, model: model?.name || ref.model };
  };
  const current = nameOf(value);
  const fallback = nameOf(settings?.defaultModel);
  const search = query.trim().toLocaleLowerCase();
  const matches = providers.map(provider => ({
    ...provider, models: provider.models.filter(model => `${provider.name} ${model.name} ${model.id}`.toLocaleLowerCase().includes(search)),
  })).filter(provider => provider.models.length);
  const pick = (model: ModelRef | null) => { setOpen(false); onChange(model); };
  return <Popover open={open && !disabled} onOpenChange={next => { setOpen(next); if (next) setQuery(''); }}>
    <PopoverTrigger asChild>
      <button type="button" className="model-choice" disabled={disabled} data-add={add || undefined} data-default={(!value && !add) || undefined}>
        {label && <span className="sr-only">{label}: </span>}
        {add ? <span>대체 모델 추가</span> : <span className="model-choice__copy">
          <span className="model-choice__model">{current?.model ?? fallback?.model ?? '모델 없음'}</span>
          <span className="model-choice__provider">{current ? current.provider : `기본 모델 따름${fallback ? ` · ${fallback.provider}` : ''}`}</span>
        </span>}
        <ChevronDown aria-hidden="true"/>
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" className="model-menu w-[min(380px,calc(100vw-32px))] p-1.5" aria-label={label ?? '대체 모델 추가'}>
      <label className="model-menu__search"><Search aria-hidden="true"/>
        <input type="text" enterKeyHint="search" aria-label="모델 검색" placeholder="모델 검색" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={blurTouchSearchOnEnter}/>
      </label>
      <div className="model-menu__list">
        {!add && inherit && !search && <button type="button" className="menu-row w-full" aria-pressed={!value} onClick={() => pick(null)}>
          <span className="flex-1">기본 모델 따름</span>{!value && <Check size={14} aria-hidden="true"/>}
        </button>}
        {matches.map(provider => <div key={provider.id}>
          <p className="menu-heading">{provider.name}</p>
          {provider.models.map(model => {
            const chosen = value?.provider === provider.id && value.model === model.id;
            const used = excluded.some(ref => ref.provider === provider.id && ref.model === model.id);
            return <button key={model.id} type="button" className="menu-row w-full" disabled={used} aria-pressed={chosen} onClick={() => pick({ provider: provider.id, model: model.id })}>
              <span className="model-menu__name">{model.name || model.id}</span>
              {used ? <span className="model-menu__used">이미 사용 중</span> : chosen && <Check size={14} aria-hidden="true"/>}
            </button>;
          })}
        </div>)}
        {!matches.length && <p className="model-menu__empty">{providers.length ? '일치하는 모델이 없습니다.' : '연결된 모델이 없습니다.'}</p>}
        {!providers.length && <a className="menu-row" href="#/settings?tab=models">모델 설정</a>}
      </div>
    </PopoverContent>
  </Popover>;
}
