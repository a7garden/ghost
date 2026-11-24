import { useEffect, useId, useRef, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { Button, Input, Popover, PopoverContent, PopoverTrigger, SkeletonRows } from '../ui';

export type ModelChoice = { selector: string; name: string; provider: string };
type Choice = ModelChoice;
/**
 * The model of the conversation on screen. Choosing one types `/model <name>` into the agent, the way the owner would,
 * so the agent itself switches (and a later `/model` typed in the terminal shows here too). Only offered while the agent waits.
 */
export function HerdrModelChip({ agent, cwd, current, disabled, load, onPick }: {
  agent: string; cwd: string | null; current: string | null; disabled: boolean;
  /** Reads the models the agent offers (omp: for the directory; Claude: the aliases and the ids this Mac used). */
  load(cwd: string, signal: AbortSignal): Promise<readonly ModelChoice[]>;
  onPick(selector: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [models, setModels] = useState<readonly ModelChoice[]>();
  const [failed, setFailed] = useState(false);
  const id = useId();
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (!open || models || (agent === 'omp' && !cwd?.startsWith('/'))) return;
    const request = new AbortController();
    setFailed(false);
    loader.current(cwd ?? '', request.signal).then(list => { if (!request.signal.aborted) setModels(list); })
      .catch(() => { if (!request.signal.aborted) setFailed(true); });
    return () => request.abort();
  }, [open, agent, cwd, models]);
  const choices: readonly Choice[] = models ?? [];
  const needle = search.toLowerCase().trim();
  const visible = choices.filter(model => `${model.name} ${model.provider} ${model.selector}`.toLowerCase().includes(needle));
  const label = (current && (choices.find(model => model.selector === current)?.name ?? current.split('/').at(-1))) || '모델';
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setSearch(''); }}>
    <PopoverTrigger asChild><button type="button" className="coding-model" disabled={disabled} aria-label={`모델 · ${label}`} title="모델 바꾸기">
      <span>{label}</span><ChevronsUpDown aria-hidden="true"/>
    </button></PopoverTrigger>
    <PopoverContent className="herdr-models" aria-label="모델 선택" side="top" align="start">
      {choices.length > 6 && <Input value={search} onChange={event => setSearch(event.currentTarget.value)} aria-label="모델 검색" placeholder="모델 검색" aria-controls={id}/>}
      <div id={id} className="herdr-model-list" role="group" aria-label="모델 목록">
        {visible.map(model => <Button key={model.selector} type="button" variant="ghost" className="justify-between" aria-pressed={current === model.selector}
          onClick={() => { setOpen(false); if (current !== model.selector) onPick(model.selector); }}><span>{model.name}</span><small>{model.provider}</small></Button>)}
        {!visible.length && (failed || models ? <p className="coding-hint">{failed ? '모델 목록을 불러오지 못했습니다.' : '일치하는 모델이 없습니다.'}</p> : <SkeletonRows label="모델 목록을 불러오는 중…" rows={3} className="p-2"/>)}
      </div>
    </PopoverContent>
  </Popover>;
}
