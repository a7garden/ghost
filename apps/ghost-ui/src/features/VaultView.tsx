import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FileUp, KeyRound, LockKeyhole, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, InlineError, SkeletonRows } from '../ui';
import type { Ghost, VaultItem, VaultItemKind } from '@ghost/contract';
import type { VaultItemWrite } from '../host/client';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { visibleGhosts } from './ghostState';
import { absoluteTime } from './time';
import { ShadeSettings } from './ShadeSettings';
import { previewVaultCsv, vaultCsvByteLimit, type CsvPreview } from './vaultCsvPreview';
import './vault.css';

const kindLabels: Record<VaultItemKind, string> = { login: '로그인', card: '카드', contact: '연락처', secret: '비밀', api: 'API 키' };

/** Every editable vault field. Secret fields start empty and never receive a stored value. */
export type VaultForm = {
  kind: VaultItemKind;
  title: string; origin: string; username: string; password: string; totp: string;
  /** More exact login addresses, separated by commas or scopes; `hadExtraOrigins` lets an edit clear them. */
  extraOrigins: string; hadExtraOrigins: boolean;
  cardNumber: string; cardExpiry: string; cardCvc: string; cardName: string;
  contactName: string; contactPhone: string; contactEmail: string; contactAddress: string;
  contactAddressDetail: string; contactPostalCode: string;
  value: string; hints: string; ghostIds: string[];
};

export const emptyVaultForm: VaultForm = {
  kind: 'login', title: '', origin: '', username: '', password: '', totp: '',
  extraOrigins: '', hadExtraOrigins: false,
  cardNumber: '', cardExpiry: '', cardCvc: '', cardName: '',
  contactName: '', contactPhone: '', contactEmail: '', contactAddress: '',
  contactAddressDetail: '', contactPostalCode: '',
  value: '', hints: '', ghostIds: [],
};

/** The editable shape of one stored item: non-secret fields prefill, secret fields stay empty. Pure; tests pin it. */
export function vaultFormFromItem(item: VaultItem): VaultForm {
  return {
    ...emptyVaultForm, kind: item.kind, title: item.title, origin: item.origin ?? '', username: item.username ?? '',
    extraOrigins: (item.extraOrigins ?? []).join(', '), hadExtraOrigins: Boolean(item.extraOrigins?.length),
    cardExpiry: item.cardExpiry ?? '',
    contactName: item.contact?.name ?? '', contactPhone: item.contact?.phone ?? '',
    contactEmail: item.contact?.email ?? '', contactAddress: item.contact?.address ?? '',
    contactAddressDetail: item.contact?.addressDetail ?? '', contactPostalCode: item.contact?.postalCode ?? '',
    hints: item.hints, ghostIds: [...item.ghostIds],
  };
}

/** One Ghost added to or removed from an item's grant list, unique, in picking order. Pure; tests pin it. */
export function toggleGhostGrant(ghostIds: readonly string[], ghostId: string, on: boolean): string[] {
  return on ? (ghostIds.includes(ghostId) ? [...ghostIds] : [...ghostIds, ghostId]) : ghostIds.filter(id => id !== ghostId);
}

/**
 * The wire body for one vault write, built only from the selected kind's fields —
 * the host rejects fields of other kinds. Text fields trim; passwords and secret
 * values stay verbatim (scopes can be part of a secret). Empty secret fields drop
 * out, so an edit leaves them unchanged; the card travels only as a whole
 * replacement. A cleared login or api username and a cleared contact travel explicitly.
 * Pure; tests pin it.
 */
export function vaultWriteBody(form: VaultForm, mode: 'create' | 'edit'): { body: VaultItemWrite } | { error: string } {
  const title = form.title.trim();
  if (!title) return { error: '이름을 입력해 주세요.' };
  const base = { title, hints: form.hints.trim(), ghostIds: [...form.ghostIds] };
  if (form.kind === 'login') {
    const origin = form.origin.trim();
    if (!origin || !origin.startsWith('https://')) return { error: '로그인에는 https://로 시작하는 주소가 필요합니다.' };
    if (mode === 'create' && (!form.username.trim() || !form.password)) return { error: '사용자 이름과 비밀번호를 입력해 주세요.' };
    const extraOrigins = form.extraOrigins.split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
    if (extraOrigins.some(value => !value.startsWith('https://'))) return { error: '추가 로그인 주소도 https://로 시작해야 합니다.' };
    if (extraOrigins.length > 8) return { error: '추가 로그인 주소는 8개까지 적을 수 있습니다.' };
    return { body: { ...base, kind: form.kind, origin, username: form.username.trim(),
      ...(extraOrigins.length || form.hadExtraOrigins ? { extraOrigins } : {}),
      ...(form.password ? { password: form.password } : {}), ...(form.totp.trim() ? { totp: form.totp.trim() } : {}) } };
  }
  if (form.kind === 'card') {
    const full = form.cardNumber.trim() && form.cardExpiry.trim() && form.cardCvc.trim() && form.cardName.trim();
    if (mode === 'create' || form.cardNumber.trim() || form.cardCvc.trim()) {
      if (!full) return { error: '카드 번호와 유효기간, CVC, 이름을 모두 입력해 주세요.' };
    }
    return { body: { ...base, kind: form.kind, ...(full ? { card: {
      number: form.cardNumber.trim(), expiry: form.cardExpiry.trim(), cvc: form.cardCvc.trim(), name: form.cardName.trim() } } : {}) } };
  }
  if (form.kind === 'contact') {
    const fields = { name: form.contactName.trim(), phone: form.contactPhone.trim(), email: form.contactEmail.trim(), address: form.contactAddress.trim(),
      addressDetail: form.contactAddressDetail.trim(), postalCode: form.contactPostalCode.trim() };
    const contact = Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
    if (mode === 'create' && !Object.keys(contact).length) return { error: '한 항목 이상 입력해 주세요.' };
    return { body: { ...base, kind: form.kind, contact } };
  }
  if (form.kind === 'api') {
    const origin = form.origin.trim();
    if (!origin.startsWith('https://')) return { error: 'https://로 시작하는 주소를 입력해 주세요.' };
    if (mode === 'create' && !form.value) return { error: '값을 입력해 주세요.' };
    const username = form.username.trim();
    return { body: { ...base, kind: form.kind, origin,
      ...(mode === 'edit' || username ? { username } : {}),
      ...(form.value ? { value: form.value } : {}) } };
  }
  if (mode === 'create' && !form.value) return { error: '값을 입력해 주세요.' };
  return { body: { ...base, kind: form.kind, ...(form.origin.trim() ? { origin: form.origin.trim() } : {}),
    ...(form.value ? { value: form.value } : {}) } };
}

const passwordAlphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';

/**
 * A generated password: 20 characters over a look-alike-free alphabet. Bytes come from
 * `crypto.getRandomValues` and are rejected past the largest whole multiple of the
 * alphabet, so every character stays equally likely. Pure given `random`; tests pin it.
 */
export function generatePassword(length = 20, random: (size: number) => Uint8Array =
  size => crypto.getRandomValues(new Uint8Array(size))): string {
  const limit = 256 - (256 % passwordAlphabet.length);
  const characters: string[] = [];
  while (characters.length < length) {
    for (const byte of random(length)) {
      if (characters.length === length) break;
      if (byte < limit) characters.push(passwordAlphabet[byte % passwordAlphabet.length]);
    }
  }
  return characters.join('');
}

/** The second line of one list row: what is stored, without a single secret value. */
export function vaultRowDetail(item: VaultItem): string {
  const parts = [
    item.origin,
    item.username,
    item.cardLast4 ? `•••• ${item.cardLast4}` : '',
    item.cardExpiry,
    item.contact?.name, item.contact?.phone, item.contact?.email, item.contact?.address,
    item.contact?.addressDetail, item.contact?.postalCode,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' · ');
}

/** Whom the item serves, for the row description; the 일회용 badge already says the kind of expiry. Pure; tests pin the wording. */
export function vaultGrantsLabel(item: VaultItem, ghostName: (id: string) => string): string {
  const names = item.ghostIds.map(ghostName);
  const expiry = item.expiresAt ? `${absoluteTime(item.expiresAt)}에 삭제` : '';
  return [names.length ? `${names.join(', ')} 사용 가능` : 'Ghost 권한 없음', expiry].filter(Boolean).join(' · ');
}

/** 금고: 항목 목록과 만들기·고치기·삭제, CSV 가져오기. 값은 저장할 때만 보내고 다시는 보이지 않습니다. */
export function VaultView() {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const ghosts = visibleGhosts(state?.ghosts ?? []);
  const ghostName = (id: string) => state?.ghosts.find(ghost => ghost.id === id)?.name ?? id;
  const [items, setItems] = useState<VaultItem[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [active, setActive] = useState<'new' | 'import' | { itemId: string } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [removing, setRemoving] = useState<VaultItem>();

  const reload = useCallback(() => {
    return client.vaultItems()
      .then(result => { setItems(result.items); setLoadError(''); })
      .catch(reason => setLoadError(reason instanceof Error ? reason.message : '금고를 읽지 못했습니다.'));
  }, [client]);
  useEffect(() => { void reload(); }, [reload]);
  useLayoutEffect(() => {
    if (active === null && returnFocus.current) {
      const target = returnFocus.current;
      (target.querySelector<HTMLElement>('[data-vault-edit]') ?? target).focus();
      returnFocus.current = null;
    }
  }, [active]);

  const open = (next: NonNullable<typeof active>, target: HTMLElement) => {
    returnFocus.current = target;
    setNotice('');
    setActive(next);
  };
  const saveItem = async (body: VaultItemWrite, id?: string) => {
    if (id) await client.vaultUpdate(id, body); else await client.vaultCreate(body);
    setNotice('금고 항목을 저장했습니다.');
    await reload();
    setActive(null);
  };

  const run = async (work: () => Promise<unknown>, done: string) => {
    setError(''); setNotice('');
    try {
      await work();
      setNotice(done);
      await reload();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.');
      return false;
    }
  };

  return <section className="flex min-w-0 flex-col gap-6" aria-label="금고">
    <div className="settings-section-header flex flex-wrap items-center justify-between gap-3">
      <h2 className="section-title">금고</h2>
      <span className="flex items-center gap-2">
        <Button variant="outline" type="button" disabled={!state || active !== null} onClick={event => open('import', event.currentTarget)}><FileUp size={15}/>CSV 가져오기</Button>
        <Button type="button" disabled={!state || active !== null} onClick={event => open('new', event.currentTarget)}><Plus size={15}/>새 항목</Button>
      </span>
    </div>
    {loadError && <InlineError>{loadError}</InlineError>}
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
    {items === null && active === null && !loadError && <SkeletonRows label="금고를 불러오는 중…" rows={4}/>}
    {(active !== null || !!items?.length) && <ul className="vault-list" aria-label="금고 항목" role="list">
      {active === 'new' && <li key="new"><VaultCardEditor ghosts={ghosts} onClose={() => setActive(null)} onSave={saveItem}/></li>}
      {active === 'import' && <li key="import"><VaultCsvPreview onClose={() => setActive(null)} onImport={async csv => {
        const result = await client.vaultImportCsv(csv);
        setNotice(`가져옴 ${result.imported} · 건너뜀 ${result.skipped} · 거부됨 ${result.rejected}`);
        await reload();
        setActive(null);
      }}/></li>}
      {items?.map(item => <li key={item.id}>
        {typeof active === 'object' && active?.itemId === item.id
          ? <VaultCardEditor item={item} ghosts={ghosts} onClose={() => setActive(null)} onSave={saveItem}/>
          : <VaultCard item={item} ghostName={ghostName} actions={<>
            <Button variant="ghost" size="sm" type="button" disabled={active !== null} data-vault-edit
              onClick={event => open({ itemId: item.id }, event.currentTarget.closest('li') ?? event.currentTarget)}><Pencil size={14}/>고치기</Button>
            <Button variant="ghost" size="icon" type="button" disabled={active !== null} aria-label="금고 항목 삭제"
              onClick={() => { setError(''); setRemoving(item); }}><Trash2 size={15}/></Button>
          </>}/>}
      </li>)}
    </ul>}
    {items?.length === 0 && active === null && <div className="calm"><KeyRound size={16} aria-hidden="true"/><p>금고 항목 없음</p></div>}
    <ShadeSettings/>
    {error && <InlineError>{error}</InlineError>}
    {removing && <Modal title="금고 항목 삭제" onClose={() => setRemoving(undefined)}>
      <p className="m-0">이 항목과 저장된 이전 값을 모두 삭제할까요? 다시 볼 수 없습니다.</p>
      {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" type="button" onClick={() => setRemoving(undefined)}>취소</Button>
        <Button variant="destructive" type="button" onClick={() => void run(async () => { await client.vaultDelete(removing.id); setRemoving(undefined); }, '금고 항목을 삭제했습니다.')}>삭제</Button>
      </div>
    </Modal>}
  </section>;
}

/** Identity, sealed values, and who may use them stay in the same places in both card states. */
function CredentialFace({ kind, title, facts, sealed, notes, grants, actions, expires }: {
  kind: ReactNode; title: ReactNode; facts?: ReactNode; sealed?: ReactNode; notes?: ReactNode;
  grants: ReactNode; actions: ReactNode; expires?: boolean;
}) {
  return <>
    <header className="vault-card__head">
      <div className="vault-card__kind">{kind}{expires && <Badge variant="warning">일회용</Badge>}</div>
      {title}
    </header>
    {(facts || sealed) && <div className="vault-card__body">
      {facts && <div className="vault-card__facts">{facts}</div>}
      {sealed && <div className="vault-card__seal"><LockKeyhole size={15} aria-hidden="true"/><div>{sealed}</div></div>}
    </div>}
    {notes}
    <footer className="vault-card__foot">
      {grants}<div className="vault-card__actions">{actions}</div>
    </footer>
  </>;
}

function VaultCard({ item, ghostName, actions }: {
  item: VaultItem; ghostName(id: string): string; actions: ReactNode;
}) {
  const sealed = item.kind === 'card' ? '카드 번호' : item.kind === 'login'
    ? [item.hasPassword && '비밀번호', item.hasTotp && '일회용 코드 시드'].filter(Boolean).join(' · ')
    : item.kind === 'api' ? '비밀 키' : item.kind === 'secret' ? '비밀 값' : '';
  return <article className="vault-card" aria-label={item.title}>
    <CredentialFace kind={kindLabels[item.kind]} title={<h3 className="vault-card__title">{item.title}</h3>}
      expires={!!item.expiresAt}
      facts={item.kind === 'card' ? item.cardExpiry : vaultRowDetail(item)}
      sealed={sealed && <><span>{sealed}</span>
        <span className="vault-card__mask" aria-hidden="true">{item.cardLast4 ? `•••• ${item.cardLast4}` : '••••••••'}</span>
        <span className="sr-only">저장됨{item.cardLast4 && ` · 끝 네 자리 ${item.cardLast4}`}</span>
      </>}
      notes={item.hints && <p className="vault-card__notes">{item.hints}</p>}
      grants={<span className="vault-card__grant-note">{vaultGrantsLabel(item, ghostName)}</span>} actions={actions}/>
  </article>;
}

type TextField = Exclude<keyof VaultForm, 'kind' | 'hadExtraOrigins' | 'ghostIds'>;

function VaultCardEditor({ item, ghosts, onClose, onSave }: {
  item?: VaultItem;
  ghosts: Ghost[];
  onClose(): void;
  onSave(body: VaultItemWrite, id?: string): Promise<void>;
}) {
  const [form, setForm] = useState<VaultForm>(() => item ? vaultFormFromItem(item) : emptyVaultForm);
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const keepId = useId();
  const set = <K extends keyof VaultForm>(key: K, value: VaultForm[K]) => setForm(current => ({ ...current, [key]: value }));
  const save = async () => {
    if (saving) return;
    const built = vaultWriteBody(form, item ? 'edit' : 'create');
    if ('error' in built) { setError(built.error); return; }
    setSaving(true); setError('');
    try { await onSave(built.body, item?.id); }
    catch { setError('금고에 저장하지 못했습니다.'); setSaving(false); }
  };
  const keys = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.nativeEvent.isComposing || saving) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); onClose();
    } else if (event.key === 'Enter') {
      if (event.metaKey || event.ctrlKey) { event.preventDefault(); void save(); }
      else if (event.target instanceof HTMLInputElement && event.target.hasAttribute('data-vault-field')) {
        event.preventDefault();
        const fields = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-vault-field]'));
        fields[fields.indexOf(event.target) + 1]?.focus();
      }
    }
  };
  const field = (key: TextField, label: string, options: {
    required?: boolean; masked?: boolean; stored?: boolean; placeholder?: string; autoComplete?: string;
    inputMode?: 'numeric' | 'tel' | 'email';
  } = {}) => <label className="vault-card__field">
    <span>{label}</span>
    <input data-vault-field type={options.masked ? 'password' : 'text'} autoComplete={options.autoComplete ?? 'off'}
      aria-required={options.required || undefined} aria-describedby={options.stored ? keepId : undefined}
      inputMode={options.inputMode} placeholder={options.stored ? options.placeholder ?? '••••••••' : options.placeholder}
      value={form[key]} readOnly={saving} onChange={event => set(key, event.target.value)}/>
  </label>;
  const { kind } = form;
  const facts = <>
    {(kind === 'login' || kind === 'secret' || kind === 'api') && field('origin', '주소', {
      placeholder: 'https://', required: kind !== 'secret',
    })}
    {kind === 'login' && <>
      {field('username', '사용자 이름', { required: !item })}
      {field('extraOrigins', '추가 로그인 주소', { placeholder: '쉼표로 구분' })}
    </>}
    {kind === 'api' && field('username', '클라이언트 ID')}
    {kind === 'card' && <>
      {field('cardName', '카드 소유자 이름', { required: !item, autoComplete: 'cc-name' })}
      {field('cardExpiry', '유효기간', { required: !item, placeholder: 'MM/YY', autoComplete: 'cc-exp' })}
    </>}
    {kind === 'contact' && <>
      {field('contactName', '이름')}
      {field('contactPhone', '전화', { inputMode: 'tel' })}
      {field('contactEmail', '이메일', { inputMode: 'email' })}
      {field('contactAddress', '주소')}
      {field('contactAddressDetail', '상세주소')}
      {field('contactPostalCode', '우편번호')}
    </>}
  </>;
  const stored = !!item && (kind === 'login' ? item.hasPassword || item.hasTotp : kind !== 'contact');
  return <form className="vault-card" data-editing="" aria-label={item ? '금고 항목 고치기' : '새 금고 항목'} aria-busy={saving}
    onSubmit={event => { event.preventDefault(); void save(); }} onKeyDown={keys}>
    <CredentialFace
      kind={item ? kindLabels[kind] : <select aria-label="항목 종류" value={kind} disabled={saving}
        onChange={event => set('kind', event.target.value as VaultItemKind)}>
        {Object.entries(kindLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>}
      expires={!!item?.expiresAt}
      title={<input className="vault-card__title" data-vault-field aria-label="항목 이름" autoComplete="off" autoFocus aria-required
        placeholder="항목 이름" value={form.title} readOnly={saving} onChange={event => set('title', event.target.value)}/>}
      facts={facts}
      sealed={kind !== 'contact' && <>
        {kind === 'login' && <>
          <div className="vault-card__generate">
            {field('password', '비밀번호', { masked: true, required: !item, stored: item?.hasPassword })}
            <Button variant="ghost" size="sm" type="button" disabled={saving} onClick={() => set('password', generatePassword())}>자동 생성</Button>
          </div>
          {field('totp', '일회용 코드 시드', { masked: true, stored: item?.hasTotp })}
        </>}
        {kind === 'card' && <>
          {field('cardNumber', '카드 번호', { masked: true, required: !item, stored, autoComplete: 'cc-number',
            inputMode: 'numeric', placeholder: item?.cardLast4 ? `•••• ${item.cardLast4}` : undefined })}
          {field('cardCvc', 'CVC', { masked: true, required: !item, stored, autoComplete: 'cc-csc' })}
        </>}
        {(kind === 'api' || kind === 'secret') && field('value', kind === 'api' ? '비밀 키' : '값', { masked: true, required: !item, stored })}
        {stored && <p id={keepId} className="vault-card__hint">
          {kind === 'card' ? '저장됨 · 카드 정보는 모두 입력해야 바뀝니다.' : '저장됨 · 비워 두면 바뀌지 않습니다.'}
        </p>}
      </>}
      notes={<label className="vault-card__notes vault-card__field">
        <span>메모</span>
        <textarea data-vault-field rows={1} maxLength={1024} value={form.hints} readOnly={saving}
          onChange={event => set('hints', event.target.value)}/>
      </label>}
      grants={<fieldset className="vault-grants" disabled={saving}>
        <legend>쓸 수 있는 Ghost</legend>
        {ghosts.map(ghost => <label key={ghost.id} className="vault-grant">
          <input type="checkbox" checked={form.ghostIds.includes(ghost.id)}
            onChange={event => set('ghostIds', toggleGhostGrant(form.ghostIds, ghost.id, event.target.checked))}/>
          <span>{ghost.name}</span>
        </label>)}
        {!ghosts.length && <span className="vault-card__hint">권한을 줄 Ghost 없음</span>}
      </fieldset>}
      actions={<>
        <Button variant="ghost" type="button" disabled={saving} onClick={onClose}>취소</Button>
        <Button type="submit" disabled={saving || !form.title.trim()}>{saving ? '저장 중…' : '저장'}</Button>
      </>}/>
    {error && <InlineError>{error}</InlineError>}
  </form>;
}

/** Keep the preview metadata and the original, write-only upload apart. */
function VaultCsvPreview({ onClose, onImport }: { onClose(): void; onImport(csv: string): Promise<void> }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const rawCsv = useRef('');
  const [preview, setPreview] = useState<({ name: string } & CsvPreview) | null>(null);
  const [phase, setPhase] = useState<'reading' | 'importing' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const load = async (files: FileList) => {
    if (phase || !files.length) return;
    if (files.length !== 1) { setError('CSV 파일은 한 번에 하나씩 가져올 수 있습니다.'); return; }
    const file = files[0];
    if (file.size > vaultCsvByteLimit) { setError('1MB 이하의 CSV 파일을 골라 주세요.'); return; }
    setPhase('reading'); setError('');
    try {
      const csv = await file.text();
      const parsed = previewVaultCsv(csv);
      if (!parsed) { setError('Apple 암호 또는 Chrome에서 내보낸 비밀번호 CSV 파일을 골라 주세요.'); return; }
      rawCsv.current = csv;
      setPreview({ name: file.name, ...parsed });
    } catch { setError('CSV 파일을 읽지 못했습니다.'); }
    finally { setPhase(null); }
  };
  const commit = async () => {
    if (phase || !preview?.rows.length) return;
    setPhase('importing'); setError('');
    try { await onImport(rawCsv.current); }
    catch { setError('금고로 가져오지 못했습니다.'); setPhase(null); }
  };
  return <section className="vault-csv" aria-label="CSV 가져오기 미리보기" aria-busy={phase !== null} data-dragging={dragging || undefined}
    onKeyDown={event => {
      if (event.key === 'Escape' && !phase && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}
    onDragOver={event => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault(); event.dataTransfer.dropEffect = phase ? 'none' : 'copy';
      if (!phase) setDragging(true);
    }}
    onDragLeave={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
    }}
    onDrop={event => {
      event.preventDefault(); setDragging(false);
      void load(event.dataTransfer.files);
    }}>
    <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={event => {
      if (event.target.files) void load(event.target.files);
      event.target.value = '';
    }}/>
    {preview ? <>
      <header className="vault-csv__file"><FileUp size={16} aria-hidden="true"/><strong>{preview.name}</strong><span>{preview.rows.length}개 항목</span></header>
      {preview.rows.length > 0
        ? <ol className="vault-csv__rows" aria-label="가져올 항목" tabIndex={0} role="list">
          {preview.rows.map(row => <li key={row.record}>
            <div>
              <strong>{row.title}</strong>
              <span>{row.origin}{row.username && ` · ${row.username}`}</span>
              <LockKeyhole size={15} aria-label="비밀번호 숨김" role="img"/>
            </div>
          </li>)}
        </ol>
        : <p className="vault-card__hint">미리 볼 수 있는 항목이 없습니다.</p>}
      <p className="vault-card__hint">
        {preview.omitted > 0 && `미리 볼 수 없는 행 ${preview.omitted}개 · `}이미 있는 항목은 건너뜁니다.
      </p>
    </> : <div className="vault-csv__drop"><FileUp size={21} aria-hidden="true"/><span>CSV 파일을 여기에 놓으세요</span></div>}
    {error && <InlineError>{error}</InlineError>}
    <div className="vault-csv__actions">
      <Button variant="outline" type="button" autoFocus disabled={!!phase}
        onClick={() => fileInput.current?.click()}>{phase === 'reading' ? '파일 읽는 중…' : preview ? '다른 파일 고르기' : '파일 고르기'}</Button>
      <Button variant="ghost" type="button" disabled={!!phase} onClick={onClose}>취소</Button>
      {preview && <Button type="button" disabled={!!phase || !preview.rows.length}
        onClick={() => void commit()}>{phase === 'importing' ? '가져오는 중…' : '가져오기'}</Button>}
    </div>
  </section>;
}
