import { useEffect, useId, useRef, useState } from 'react';
import { formatUiSubmission, type InteractiveUi, type UiChoices, type UiForm, type UiValues } from '@ghost/contract';
import { Button, Checkbox, FormField, Input, SelectField, Textarea } from '../../ui';

export type UiSubmit = (text: string, requestId: string) => Promise<void>;
type InputBlock = UiChoices | UiForm;
type InputState = {
  values: UiValues;
  status: 'idle' | 'pending' | 'sent' | 'error';
  attempt?: { text: string; requestId: string };
  error?: string;
};

function defaults(block: InputBlock): UiValues {
  return block.type === 'choices' ? { choice: '' } : Object.fromEntries(block.fields.map(field => [field.id,
    field.type === 'checkbox' ? field.value ?? false : String(field.value ?? ''),
  ]));
}

function restore(key: string, identity: string, block: InputBlock): InputState {
  const initial: InputState = { values: defaults(block), status: 'idle' };
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!saved || typeof saved !== 'object' || !('identity' in saved) || saved.identity !== identity || !('state' in saved)) return initial;
    const state = saved.state;
    if (!state || typeof state !== 'object' || !('values' in state) || !state.values || typeof state.values !== 'object') return initial;
    const values = state.values;
    initial.values = Object.fromEntries(Object.entries(initial.values).map(([id, fallback]) => {
      const value: unknown = Object.hasOwn(values, id) ? Reflect.get(values, id) : undefined;
      return [id, typeof fallback === 'boolean' && typeof value === 'boolean' || typeof fallback === 'string' && typeof value === 'string' && value.length <= 2000 ? value : fallback];
    }));
    if ('attempt' in state && state.attempt && typeof state.attempt === 'object' && 'text' in state.attempt && typeof state.attempt.text === 'string' && state.attempt.text.length <= 32768 && 'requestId' in state.attempt && typeof state.attempt.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(state.attempt.requestId)) {
      initial.attempt = { text: state.attempt.text, requestId: state.attempt.requestId };
      if ('status' in state && state.status === 'sent') initial.status = 'sent';
      else {
        initial.status = 'error';
        initial.error = '전송 결과를 확인하지 못했습니다. 같은 응답으로 다시 시도할 수 있습니다.';
      }
    }
  } catch { /* Tab storage is optional; denied access must not disable inputs. */ }
  return initial;
}

export function UiInputBlock({ ui, block, conversationId, messageId, onUiSubmit }: {
  ui: InteractiveUi; block: InputBlock; conversationId: string; messageId: string; onUiSubmit?: UiSubmit;
}) {
  const storageKey = `ghost:ui:1:${JSON.stringify([conversationId, messageId, block.id])}`;
  const identity = JSON.stringify([ui.title, block]);
  const [state, setState] = useState(() => restore(storageKey, identity, block));
  const current = useRef(state);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const headingId = useId();
  const feedbackId = useId();
  const radioName = useId();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const update = (next: InputState) => {
    current.current = next;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ identity, state: next })); } catch { /* Keep working without storage. */ }
    if (mounted.current) setState(next);
  };
  const change = (id: string, value: string | boolean) => {
    if (inFlight.current || current.current.status === 'sent') return;
    update({ values: Object.fromEntries(Object.entries(current.current.values).map(([key, previous]) => [key, key === id ? value : previous])), status: 'idle' });
  };
  const submit = async () => {
    if (!onUiSubmit || inFlight.current || current.current.status === 'sent') return;
    let text: string;
    try {
      const values = block.type === 'choices' ? current.current.values : Object.fromEntries(block.fields.map(field => {
        const raw = Object.hasOwn(current.current.values, field.id) ? current.current.values[field.id] : '';
        return [field.id, field.type === 'number' && raw !== '' ? Number(raw) : raw];
      }));
      text = formatUiSubmission(ui, block.id, values);
    } catch (error) {
      update({ ...current.current, status: 'error', error: `입력값을 확인해 주세요. ${error instanceof Error ? error.message : ''}` });
      return;
    }
    inFlight.current = true;
    const attempt = current.current.attempt?.text === text ? current.current.attempt : { text, requestId: crypto.randomUUID() };
    update({ values: current.current.values, status: 'pending', attempt });
    try {
      await onUiSubmit(text, attempt.requestId);
      update({ values: current.current.values, status: 'sent', attempt });
    } catch (error) {
      update({ values: current.current.values, status: 'error', attempt, error: `전송을 확인하지 못했습니다. 다시 시도해 주세요.${error instanceof Error ? ` ${error.message}` : ''}` });
    } finally { inFlight.current = false; }
  };
  const disabled = !onUiSubmit || state.status === 'pending' || state.status === 'sent';
  return <section className="ghost-ui-block" aria-labelledby={headingId}>
    <h3 id={headingId}>{block.title}</h3>
    <form className="ghost-ui-input" aria-labelledby={headingId} aria-describedby={feedbackId} aria-busy={state.status === 'pending'} onSubmit={event => { event.preventDefault(); void submit(); }}>
      {block.type === 'choices' ? <fieldset className="ghost-ui-choices" disabled={disabled}>
        <legend className="sr-only">{block.title}</legend>
        {block.options.map(option => <label key={option.id} className="ghost-ui-choice">
          <input type="radio" name={radioName} value={option.id} required checked={state.values.choice === option.id} onChange={() => change('choice', option.id)}/>
          <span><span className="ghost-ui-choice__label">{option.label}</span>{option.description && <span className="ghost-ui-choice__description">{option.description}</span>}</span>
        </label>)}
      </fieldset> : <div className="ghost-ui-fields">{block.fields.map(field => <FormField key={field.id} label={field.label} required={field.required}>
        {props => {
          const value = Object.hasOwn(state.values, field.id) ? state.values[field.id] : '';
          if (field.type === 'checkbox') return <Checkbox {...props} disabled={disabled} checked={value === true} onCheckedChange={checked => change(field.id, checked === true)}/>;
          if (field.type === 'select') return <SelectField {...props} label={field.label} disabled={disabled} value={String(value)} onValueChange={next => change(field.id, next)} options={field.options} className="ghost-ui-select"/>;
          if (field.type === 'text' && field.multiline) return <Textarea {...props} disabled={disabled} value={String(value)} maxLength={2000} placeholder={field.placeholder} onChange={event => change(field.id, event.target.value)}/>;
          if (field.type === 'text') return <Input {...props} disabled={disabled} value={String(value)} maxLength={2000} placeholder={field.placeholder} onChange={event => change(field.id, event.target.value)}/>;
          return <Input {...props} disabled={disabled} type="number" min={field.min} max={field.max} step={field.step ?? 'any'} value={String(value)} onChange={event => change(field.id, event.target.value)}/>;
        }}
      </FormField>)}</div>}
      <div className="ghost-ui-input__actions">
        {onUiSubmit && state.status !== 'sent' && <Button type="submit" disabled={state.status === 'pending'}>{state.status === 'pending' ? '보내는 중…' : state.status === 'error' && state.attempt ? '다시 보내기' : block.type === 'form' ? block.submitLabel : '선택 보내기'}</Button>}
        {onUiSubmit && state.status === 'sent' && <Button type="button" variant="secondary" onClick={() => update({ values: current.current.values, status: 'idle' })}>응답 수정</Button>}
        {onUiSubmit && state.status !== 'sent' && <Button type="button" variant="ghost" disabled={state.status === 'pending'} onClick={() => update({ values: defaults(block), status: 'idle' })}>초기화</Button>}
        <p id={feedbackId} className="ghost-ui-feedback" role={state.status === 'error' ? 'alert' : 'status'}>
          {!onUiSubmit ? '읽기 전용' : state.status === 'sent' ? '메시지로 보냈습니다.' : state.status === 'pending' ? '메시지를 보내고 있습니다.' : state.status === 'error' ? state.error : ''}
        </p>
      </div>
    </form>
  </section>;
}
