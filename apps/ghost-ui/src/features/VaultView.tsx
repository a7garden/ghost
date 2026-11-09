import { useCallback, useEffect, useRef, useState } from 'react';
import { FileUp, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Checkbox, FormField, InlineError, Input, SegmentedControl, SettingsGroup, SettingsRow, Textarea } from '../ui'
import type { Ghost, VaultItem, VaultItemKind } from '@ghost/contract';
import type { VaultItemWrite } from '../host/client';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { visibleGhosts } from './ghostState';
import { absoluteTime } from './time';

const kindLabels: Record<VaultItemKind, string> = { login: '로그인', card: '카드', contact: '연락처', secret: '비밀' };

/** Every field the vault dialog edits. Secret fields start empty and never receive a stored value. */
export type VaultForm = {
  kind: VaultItemKind;
  title: string; origin: string; username: string; password: string; totp: string;
  cardNumber: string; cardExpiry: string; cardCvc: string; cardName: string;
  contactName: string; contactPhone: string; contactEmail: string; contactAddress: string;
  value: string; hints: string; ghostIds: string[];
};

export const emptyVaultForm: VaultForm = {
  kind: 'login', title: '', origin: '', username: '', password: '', totp: '',
  cardNumber: '', cardExpiry: '', cardCvc: '', cardName: '',
  contactName: '', contactPhone: '', contactEmail: '', contactAddress: '',
  value: '', hints: '', ghostIds: [],
};

/** The editable shape of one stored item: non-secret fields prefill, secret fields stay empty. Pure; tests pin it. */
export function vaultFormFromItem(item: VaultItem): VaultForm {
  return {
    ...emptyVaultForm, kind: item.kind, title: item.title, origin: item.origin ?? '', username: item.username ?? '',
    cardExpiry: item.cardExpiry ?? '',
    contactName: item.contact?.name ?? '', contactPhone: item.contact?.phone ?? '',
    contactEmail: item.contact?.email ?? '', contactAddress: item.contact?.address ?? '',
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
 * values stay verbatim (spaces can be part of a secret). Empty secret fields drop
 * out, so an edit leaves them unchanged; the card travels only as a whole
 * replacement. A cleared login username and a cleared contact travel explicitly.
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
    return { body: { ...base, kind: form.kind, origin, username: form.username.trim(),
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
    const fields = { name: form.contactName.trim(), phone: form.contactPhone.trim(), email: form.contactEmail.trim(), address: form.contactAddress.trim() };
    const contact = Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
    if (mode === 'create' && !Object.keys(contact).length) return { error: '한 항목 이상 입력해 주세요.' };
    return { body: { ...base, kind: form.kind, contact } };
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
  const [editing, setEditing] = useState<VaultItem | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<VaultItem>();

  const reload = useCallback(() => {
    return client.vaultItems()
      .then(result => { setItems(result.items); setLoadError(''); })
      .catch(reason => setLoadError(reason instanceof Error ? reason.message : '금고를 읽지 못했습니다.'));
  }, [client]);
  useEffect(() => { void reload(); }, [reload]);

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
        <Button variant="outline" type="button" disabled={!state} onClick={() => setImporting(true)}><FileUp size={15}/>CSV 가져오기</Button>
        <Button type="button" disabled={!state} onClick={() => setEditing('new')}><Plus size={15}/>새 항목</Button>
      </span>
    </div>
    {loadError && <InlineError>{loadError}</InlineError>}
    {items === null && !loadError && <p className="m-0 text-ui text-ink-2" role="status">금고를 불러오는 중…</p>}
    {items?.length
      ? <SettingsGroup title={<span className="sr-only">금고</span>}>{items.map(item => <SettingsRow key={item.id}
        label={<span className="flex min-w-0 flex-col gap-1.5">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant="outline">{kindLabels[item.kind]}</Badge>
            {item.expiresAt && <Badge variant="warning">일회용</Badge>}
            <span className="text-ui font-medium text-ink [overflow-wrap:anywhere]">{item.title}</span>
          </span>
          {vaultRowDetail(item) && <span className="text-caption font-normal text-ink-3 [overflow-wrap:anywhere]">{vaultRowDetail(item)}</span>}
        </span>}
        description={vaultGrantsLabel(item, ghostName)}>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="sm" type="button" onClick={() => { setError(''); setEditing(item); }}><Pencil size={14}/>고치기</Button>
          <Button variant="ghost" size="icon" type="button" aria-label="금고 항목 삭제" onClick={() => { setError(''); setRemoving(item); }}><Trash2 size={15}/></Button>
        </span>
      </SettingsRow>)}</SettingsGroup>
      : items && <div className="calm"><KeyRound size={16} aria-hidden="true"/><p>금고 항목 없음</p></div>}
    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
    {editing && <VaultItemDialog item={editing} ghosts={ghosts} onClose={() => setEditing(null)}
      onSave={async (body, id) => {
        // Errors throw so the dialog shows them and clears 저장 중…; it closes only on success.
        if (id) await client.vaultUpdate(id, body); else await client.vaultCreate(body);
        setNotice('금고 항목을 저장했습니다.');
        await reload();
        setEditing(null);
      }}/>}
    {importing && <VaultImportDialog onClose={() => setImporting(false)} onImport={async csv => {
      const result = await client.vaultImportCsv(csv);
      setImporting(false);
      setNotice(`가져옴 ${result.imported} · 건너뜀 ${result.skipped} · 거부됨 ${result.rejected}`);
      await reload();
    }}/>}
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

/** One item's create/edit sheet. Secret fields start empty; an empty field keeps what is stored. */
function VaultItemDialog({ item, ghosts, onClose, onSave }: {
  item: VaultItem | 'new';
  ghosts: Ghost[];
  onClose(): void;
  onSave(body: VaultItemWrite, id?: string): Promise<void>;
}) {
  const editing = item !== 'new';
  const [form, setForm] = useState<VaultForm>(() => editing ? vaultFormFromItem(item) : emptyVaultForm);
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const set = (key: keyof VaultForm, value: string | string[]) => setForm(current => ({ ...current, [key]: value }));
  const save = async () => {
    const built = vaultWriteBody(form, editing ? 'edit' : 'create');
    if ('error' in built) { setError(built.error); return; }
    setSaving(true); setError('');
    try { await onSave(built.body, editing ? item.id : undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '금고에 저장하지 못했습니다.'); setSaving(false); }
  };
  const field = (key: keyof VaultForm, label: string, options: {
    required?: boolean; password?: boolean; description?: string; placeholder?: string; autoComplete?: string; inputMode?: 'numeric' | 'tel' | 'email'; generate?: boolean;
  } = {}) => <FormField label={label} description={options.description} required={options.required}>
    {control => options.generate
      ? <span className="vault-gen">
        <Input {...control} type="password" autoComplete={options.autoComplete}
          placeholder={options.placeholder} value={form[key] as string} disabled={saving}
          onChange={event => set(key, event.target.value)}/>
        <Button variant="outline" type="button" disabled={saving}
          onClick={() => set('password', generatePassword())}>자동 생성</Button>
      </span>
      : <Input {...control} type={options.password ? 'password' : 'text'} autoComplete={options.autoComplete}
        inputMode={options.inputMode} placeholder={options.placeholder} value={form[key] as string} disabled={saving}
        onChange={event => set(key, event.target.value)}/>}
  </FormField>;
  const kind = form.kind;
  return <Modal title={editing ? '금고 항목 고치기' : '새 금고 항목'} onClose={() => !saving && onClose()} className="w-[min(560px,calc(100vw-2rem))] sm:max-w-[560px]">
    <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      {!editing && <SegmentedControl aria-label="항목 종류" value={kind} onValueChange={value => set('kind', value)}
        options={Object.entries(kindLabels).map(([value, label]) => ({ value, label }))}/>}
      {field('title', '이름', { required: true })}
      {(kind === 'login' || kind === 'secret') && field('origin', '주소', { placeholder: 'https://example.com', autoComplete: 'off',
        description: kind === 'login' ? '이 주소의 로그인에만 씁니다.' : '비우면 저장된 주소를 유지합니다.' })}
      {kind === 'login' && <>
        {field('username', '사용자 이름', { autoComplete: 'off' })}
        {field('password', '비밀번호', { password: true, generate: true, autoComplete: 'off',
          description: editing && item.hasPassword ? '저장됨 · 새 값을 입력하면 바꿉니다.' : undefined })}
        {field('totp', '일회용 코드 시드', { password: true, autoComplete: 'off',
          description: editing && item.hasTotp ? '저장됨 · 새 값을 입력하면 바꿉니다.' : '비워 두어도 됩니다. 저장하면 Ghost가 코드를 직접 만듭니다.' })}
      </>}
      {kind === 'card' && <>
        {field('cardNumber', '카드 번호', { required: true, autoComplete: 'cc-number', inputMode: 'numeric',
          description: editing ? '저장됨 · 번호와 유효기간, CVC, 이름을 새로 입력하면 카드 정보를 모두 바꿉니다.' : undefined })}
        <div className="grid gap-4 sm:grid-cols-2">
          {field('cardExpiry', '유효기간', { required: true, placeholder: 'MM/YY', autoComplete: 'cc-exp' })}
          {field('cardCvc', 'CVC', { required: true, password: true, autoComplete: 'cc-csc' })}
        </div>
        {field('cardName', '카드 소유자 이름', { required: true, autoComplete: 'cc-name' })}
      </>}
      {kind === 'contact' && <>
        {field('contactName', '이름', { autoComplete: 'off' })}
        {field('contactPhone', '전화', { autoComplete: 'off', inputMode: 'tel' })}
        {field('contactEmail', '이메일', { autoComplete: 'off', inputMode: 'email' })}
        {field('contactAddress', '주소', { autoComplete: 'off' })}
      </>}
      {kind === 'secret' && field('value', '값', { password: true, autoComplete: 'off', description: '저장한 뒤에는 다시 볼 수 없습니다.' })}
      <FormField label="메모" description="어떤 때 쓸지 Ghost에게 알려 주는 메모입니다.">
        {control => <Textarea {...control} value={form.hints} rows={2} maxLength={1024} disabled={saving}
          onChange={event => set('hints', event.target.value)}/>}
      </FormField>
      <fieldset className="vault-grants">
        <legend>이 Ghost가 쓸 수 있음</legend>
        {ghosts.map(ghost => <label key={ghost.id} className="vault-grant">
          <Checkbox disabled={saving} checked={form.ghostIds.includes(ghost.id)}
            onCheckedChange={on => set('ghostIds', toggleGhostGrant(form.ghostIds, ghost.id, on === true))}/>
          <span>{ghost.name}</span>
        </label>)}
        {!ghosts.length && <p className="ghost-form-field-help">권한을 줄 Ghost 없음</p>}
      </fieldset>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={saving} onClick={onClose}>취소</Button>
        <Button type="submit" disabled={saving || !form.title.trim()}>{saving ? '저장 중…' : '저장'}</Button>
      </div>
    </form>
  </Modal>;
}

/** Apple Passwords/Chrome CSV import. The file travels once as text; counts come back. */
function VaultImportDialog({ onClose, onImport }: {
  onClose(): void;
  onImport(csv: string): Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const importFile = async (file: File) => {
    setBusy(true); setError('');
    try { await onImport(await file.text()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '가져오지 못했습니다.'); setBusy(false); }
  };
  return <Modal title="CSV 가져오기" onClose={() => !busy && onClose()}>
    <p className="m-0">Apple 암호나 Chrome에서 내려받은 비밀번호 CSV 파일을 가져옵니다. 이미 있는 항목은 건너뜁니다.</p>
    <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) { setFileName(file.name); void importFile(file); }
    }}/>
    <div className="mt-4 flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-caption text-ink-3">{fileName || '파일을 고르세요.'}</span>
      <Button variant="outline" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>파일 고르기</Button>
    </div>
    {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
  </Modal>;
}
