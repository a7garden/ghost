import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { MailPlus, MailX, Paperclip, RotateCw, Search, Star } from 'lucide-react';
import { Button, EmptyState, InlineError, Skeleton } from '../../ui';
import type { MailAccounts, MailboxInfo, MailMessage } from '../../host/client';
import { useHost } from '../../host/context';
import { relativeTime, useNow } from '../time';
import { MailCompose, type ComposeSeed } from './MailCompose';
import { MailReader, type MailReaderAction } from './MailReader';
import {
  ALL_ACCOUNTS, ALL_INBOX, appendMailPage, defaultMailbox, emptyMailList, inboxMailbox, mailboxLabel, mailAddressName,
  mergeUnifiedPages, orderMailboxes, patchMailMessage, refreshMailPage, removeMailMessage, shiftMailboxUnseen,
  unifiedHasMore, type ListedMail, type MailListState, type UnifiedPage,
} from './mail-data';

type Account = MailAccounts['accounts'][number];
/** Where one message lives. Uids repeat across accounts, so every action names its own account. */
interface Target { accountId: string; mailboxPath: string }

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE = 400;
/** New mail shows up by itself; this is how often the visible list asks the server. */
const QUIET_REFRESH_MS = 90_000;
/** The account (or 전체 계정) the owner last chose; opens first next time while that account still exists. */
const VIEW_KEY = 'ghost-mail:view';
const savedView = () => { try { return localStorage.getItem(VIEW_KEY); } catch { return null; } };
const rememberView = (id: string) => { try { localStorage.setItem(VIEW_KEY, id); } catch { /* a private window cannot save; the choice holds for this screen only. */ } };
const rowKey = (message: ListedMail) => `${message.accountId ?? ''}:${message.uid}`;

// Match mail.css even in a narrow native Mac window; shell chrome is a separate concern.
const compactQuery = '(max-width: 55.999rem)';
function subscribeMailWidth(listener: () => void) {
  const media = matchMedia(compactQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

/**
 * 메일: the owner's mail accounts as a familiar three-pane client — mailboxes, list, reader.
 * With two or more accounts the view opens on 전체 계정, every 받은편지함 merged newest first.
 * Below 56rem the panes stack: account and mailbox become selects above the list, and an open
 * message takes the whole sheet with a back button (iPhone).
 */
export function MailView({ navigate }: { navigate(path: string): void }) {
  const { client } = useHost();
  const compact = useSyncExternalStore(subscribeMailWidth, () => matchMedia(compactQuery).matches, () => false);
  const now = useNow();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountsError, setAccountsError] = useState('');
  const [accountId, setAccountId] = useState('');
  const [mailboxes, setMailboxes] = useState<MailboxInfo[]>([]);
  const [mailboxPath, setMailboxPath] = useState('');
  const [list, setList] = useState<MailListState>(emptyMailList);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState('');
  /** Merged view only: accounts whose last fetch failed, by account id. */
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [moreError, setMoreError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [openTarget, setOpenTarget] = useState<Target | null>(null);
  const [openMessage, setOpenMessage] = useState<MailMessage | null>(null);
  const [messageError, setMessageError] = useState('');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [compose, setCompose] = useState<{ seed: ComposeSeed; accountId: string } | null>(null);
  const composeTrigger = useRef<HTMLButtonElement | null>(null);
  const writeButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (compose || !composeTrigger.current) return;
    const trigger = composeTrigger.current;
    composeTrigger.current = null;
    (trigger.isConnected ? trigger : writeButton.current)?.focus();
  }, [compose]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Mailboxes of each account the merged view has read, for its inbox path and the reader's 이동 list. */
  const accountMailboxes = useRef(new Map<string, MailboxInfo[]>());
  const unified = accountId === ALL_ACCOUNTS;
  const scope = useMemo(() => ({ accountId, mailboxPath, query }), [accountId, mailboxPath, query]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const listGeneration = useRef(0);
  const moreGeneration = useRef(0);
  const openGeneration = useRef(0);
  const refreshing = useRef(false);
  const activeOpen = useRef<{ scope: typeof scope; target: Target; uid: number; generation: number } | null>(null);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const reloadAccounts = useCallback(async (pickFirst = false) => {
    try {
      const result = await client.mailAccounts();
      setAccounts(result.accounts);
      setAccountsError('');
      if (pickFirst && result.accounts.length) {
        const saved = savedView();
        const known = saved === ALL_ACCOUNTS ? result.accounts.length > 1 : result.accounts.some(item => item.connectionId === saved);
        setAccountId(known ? saved! : result.accounts.length > 1 ? ALL_ACCOUNTS : result.accounts[0]!.connectionId);
      }
    } catch (reason) {
      setAccountsError(reason instanceof Error ? reason.message : '메일 계정을 읽지 못했습니다.');
    }
  }, [client]);
  useEffect(() => { void reloadAccounts(true); }, [reloadAccounts]);

  /** One account's inbox path for the merged view; reads its mailboxes once and keeps them. */
  const inboxPath = useCallback(async (id: string) => {
    let known = accountMailboxes.current.get(id);
    if (!known) {
      known = orderMailboxes((await client.mailMailboxes(id)).mailboxes);
      accountMailboxes.current.set(id, known);
    }
    const inbox = inboxMailbox(known);
    if (!inbox) throw new Error('받은편지함을 찾지 못했습니다.');
    return inbox.path;
  }, [client]);

  /** One page of every account's inbox; `before` limits it to accounts that still have older mail. A failing account never hides the rest. */
  const fetchUnified = useCallback(async (searchText: string, before: Record<string, number | null> | null) => {
    const wanted = (accounts ?? []).filter(item => before === null || (before[item.connectionId] ?? null) !== null);
    const settled = await Promise.allSettled(wanted.map(async (item): Promise<UnifiedPage> => {
      const path = await inboxPath(item.connectionId);
      const cursor = before?.[item.connectionId];
      const page = await client.mailMessages(item.connectionId, {
        mailbox: path, q: searchText || undefined, limit: PAGE_SIZE, ...(cursor ? { before: cursor } : {}),
      });
      return { accountId: item.connectionId, accountName: item.name || item.address, mailboxPath: path, messages: page.messages, nextBefore: page.nextBefore };
    }));
    const pages: UnifiedPage[] = [];
    const failed: Record<string, string> = {};
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') pages.push(result.value);
      else failed[wanted[index]!.connectionId] = result.reason instanceof Error ? result.reason.message : '메일을 읽지 못했습니다.';
    });
    return { pages, failed };
  }, [accounts, client, inboxPath]);

  const loadList = useCallback(async () => {
    const generation = ++listGeneration.current;
    ++moreGeneration.current;
    setLoadingMore(false);
    setList(emptyMailList);
    setPhase('loading'); setListError(''); setMoreError(''); setFailures({});
    try {
      if (scope.accountId === ALL_ACCOUNTS) {
        const { pages, failed } = await fetchUnified(scope.query, null);
        if (currentScope.current !== scope || listGeneration.current !== generation) return;
        setFailures(failed);
        if (!pages.length && Object.keys(failed).length) {
          setListError(Object.values(failed)[0]!);
          setPhase('error');
          return;
        }
        setList(mergeUnifiedPages({ ...emptyMailList, query: scope.query }, pages));
        setPhase('ready');
        return;
      }
      const page = await client.mailMessages(scope.accountId, { mailbox: scope.mailboxPath, q: scope.query || undefined, limit: PAGE_SIZE });
      if (currentScope.current !== scope || listGeneration.current !== generation) return;
      setList({ ...emptyMailList, messages: page.messages, nextBefore: page.nextBefore, query: scope.query });
      setPhase('ready');
    } catch (reason) {
      if (currentScope.current !== scope || listGeneration.current !== generation) return;
      setListError(reason instanceof Error ? reason.message : '메일을 읽지 못했습니다.');
      setPhase('error');
    }
  }, [client, scope, fetchUnified]);

  // A new account brings its mailboxes; the view opens on its first (받은편지함 when present).
  // The old account's mailbox drops at once so no load runs against the wrong account.
  // 전체 계정 has no mailbox list of its own: it reads every account's inbox.
  useEffect(() => {
    if (!accountId) return;
    setMailboxes([]);
    setList(emptyMailList);
    setPhase('loading');
    if (accountId === ALL_ACCOUNTS) { setMailboxPath(ALL_INBOX); return; }
    let alive = true;
    setMailboxPath('');
    (async () => {
      try {
        const result = await client.mailMailboxes(accountId);
        if (!alive) return;
        setMailboxes(orderMailboxes(result.mailboxes));
        setMailboxPath(defaultMailbox(result.mailboxes)?.path ?? '');
      } catch (reason) {
        if (!alive) return;
        setListError(reason instanceof Error ? reason.message : '메일함을 읽지 못했습니다.');
        setPhase('error');
      }
    })();
    return () => { alive = false; };
  }, [accountId, client]);

  useEffect(() => {
    if (accountId && mailboxPath) void loadList();
    return () => { ++listGeneration.current; ++moreGeneration.current; };
  }, [accountId, mailboxPath, loadList]);

  // Invalidate before paint, including A → B → A and closing a pending read.
  useLayoutEffect(() => {
    activeOpen.current = null;
    setOpenKey(null); setOpenTarget(null); setOpenMessage(null); setMessageError(''); setActionError(''); setBusy('');
  }, [scope]);
  useEffect(() => () => { activeOpen.current = null; ++listGeneration.current; ++moreGeneration.current; }, []);

  const commitSearch = (value: string) => {
    clearTimeout(searchTimer.current);
    setQuery(value);
  };
  const onSearchInput = (value: string) => {
    setSearch(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setQuery(value.trim()), SEARCH_DEBOUNCE);
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); commitSearch(search.trim()); }
    if (event.key === 'Escape') { event.preventDefault(); setSearch(''); commitSearch(''); }
  };

  const reloadMailboxes = async () => {
    if (!scope.accountId || scope.accountId === ALL_ACCOUNTS) return;
    try {
      const result = await client.mailMailboxes(scope.accountId);
      if (currentScope.current !== scope) return;
      setMailboxes(orderMailboxes(result.mailboxes));
    } catch { /* counts are cosmetic; the stored list stays. */ }
  };

  /**
   * New mail without a click: ask for the first page again and fold it in. Skipped while a search
   * is committed, a load or another refresh is running, or the tab is hidden; failures stay silent.
   */
  const refreshQuietly = async () => {
    if (!accountId || !mailboxPath || phase !== 'ready' || list.query || loadingMore || refreshing.current || document.visibilityState !== 'visible') return;
    const generation = listGeneration.current;
    refreshing.current = true;
    try {
      if (unified) {
        const { pages } = await fetchUnified('', null);
        if (currentScope.current !== scope || listGeneration.current !== generation) return;
        setList(current => pages.reduce((state, page) => refreshMailPage(state, page), current));
      } else {
        const page = await client.mailMessages(scope.accountId, { mailbox: scope.mailboxPath, limit: PAGE_SIZE });
        if (currentScope.current !== scope || listGeneration.current !== generation) return;
        setList(current => refreshMailPage(current, page));
        void reloadMailboxes();
      }
    } catch { /* the next tick tries again; the list on screen stays valid. */ } finally {
      refreshing.current = false;
    }
  };
  const refreshLatest = useRef(refreshQuietly);
  refreshLatest.current = refreshQuietly;
  useEffect(() => {
    const tick = () => void refreshLatest.current();
    const timer = setInterval(tick, QUIET_REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, []);

  /** Where a listed message lives: its own account in the merged view, the selected mailbox otherwise. */
  const targetOf = (message: ListedMail): Target => ({
    accountId: message.accountId ?? scope.accountId,
    mailboxPath: message.mailboxPath ?? scope.mailboxPath,
  });
  /** Mark one listed message in the list; the merged view keys by account because uids repeat. */
  const patchRow = (target: Target, uid: number, patch: { seen?: boolean; flagged?: boolean }) =>
    setList(current => patchMailMessage(current, uid, patch, unified ? target.accountId : undefined));
  const removeRow = (target: Target, uid: number) =>
    setList(current => removeMailMessage(current, uid, unified ? target.accountId : undefined));

  /** Opening a message reads it, then marks it seen and drops the mailbox's unseen count. */
  const open = async (summary: ListedMail) => {
    if (!accountId || !mailboxPath) return;
    const target = targetOf(summary);
    const key = rowKey(summary);
    if (activeOpen.current?.scope === scope && activeOpen.current.uid === summary.uid && activeOpen.current.target.accountId === target.accountId) return;
    const selection = { scope, target, uid: summary.uid, generation: ++openGeneration.current };
    activeOpen.current = selection;
    let loaded = false;
    setOpenKey(key); setOpenTarget(target); setOpenMessage(null); setMessageError(''); setActionError(''); setBusy('');
    try {
      const message = await client.mailMessage(target.accountId, target.mailboxPath, summary.uid);
      if (currentScope.current !== scope || activeOpen.current !== selection) return;
      setOpenMessage(message);
      loaded = true;
      if (!message.seen) {
        setBusy('seen');
        await client.mailUpdate({ type: 'mail.update', connectionId: target.accountId, mailbox: target.mailboxPath, uids: [summary.uid], action: 'seen' });
        if (currentScope.current !== scope || activeOpen.current !== selection) return;
        patchRow(target, summary.uid, { seen: true });
        setOpenMessage(current => current ? { ...current, seen: true } : current);
        if (!unified) setMailboxes(current => shiftMailboxUnseen(current, target.mailboxPath, -1));
      }
    } catch (reason) {
      if (currentScope.current !== scope || activeOpen.current !== selection) return;
      if (loaded) setActionError(reason instanceof Error ? reason.message : '읽음으로 표시하지 못했습니다.');
      else setMessageError(reason instanceof Error ? reason.message : '메일을 읽지 못했습니다.');
    } finally {
      if (currentScope.current === scope && activeOpen.current === selection) setBusy('');
    }
  };

  const closeOpen = () => {
    activeOpen.current = null;
    setOpenKey(null); setOpenTarget(null); setOpenMessage(null); setMessageError(''); setActionError(''); setBusy('');
  };

  const startCompose = (seed: ComposeSeed, accountId: string, trigger: HTMLButtonElement) => {
    // A pending search must not switch the reader out from under a reply.
    clearTimeout(searchTimer.current);
    setSearch(query);
    composeTrigger.current = trigger;
    setCompose({ seed, accountId });
  };

  const runAction = async (message: MailMessage, action: MailReaderAction) => {
    const selection = activeOpen.current;
    if (!accountId || !mailboxPath || busy || compose || selection?.scope !== scope || selection.uid !== message.uid) return;
    if (action.type === 'reply' || action.type === 'forward') {
      startCompose({ mode: action.type, mailbox: selection.target.mailboxPath, message }, selection.target.accountId, action.trigger);
      return;
    }
    const { target } = selection;
    setBusy(action.type); setActionError('');
    const update = (command: { action: 'seen' | 'unseen' | 'flag' | 'unflag' | 'archive' | 'trash' | 'move'; target?: string }) =>
      client.mailUpdate({ type: 'mail.update', connectionId: target.accountId, mailbox: target.mailboxPath, uids: [message.uid], ...command });
    try {
      if (action.type === 'toggleSeen') {
        const seen = !message.seen;
        await update({ action: seen ? 'seen' : 'unseen' });
        if (currentScope.current !== scope || activeOpen.current !== selection) return;
        patchRow(target, message.uid, { seen });
        setOpenMessage(current => current?.uid === message.uid ? { ...current, seen } : current);
        if (!unified) setMailboxes(current => shiftMailboxUnseen(current, target.mailboxPath, seen ? -1 : 1));
      } else if (action.type === 'toggleFlag') {
        const flagged = !message.flagged;
        await update({ action: flagged ? 'flag' : 'unflag' });
        if (currentScope.current !== scope || activeOpen.current !== selection) return;
        patchRow(target, message.uid, { flagged });
        setOpenMessage(current => current?.uid === message.uid ? { ...current, flagged } : current);
      } else if (action.type === 'move') {
        await update({ action: 'move', target: action.target });
        if (currentScope.current !== scope || activeOpen.current !== selection) return;
        removeRow(target, message.uid);
        closeOpen();
        void reloadMailboxes();
      } else {
        await update({ action: action.type });
        if (currentScope.current !== scope || activeOpen.current !== selection) return;
        removeRow(target, message.uid);
        closeOpen();
        void reloadMailboxes();
      }
    } catch (reason) {
      if (currentScope.current !== scope || activeOpen.current !== selection) return;
      setActionError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.');
    } finally {
      if (currentScope.current === scope && activeOpen.current === selection) setBusy('');
    }
  };

  const hasMore = unified ? unifiedHasMore(list) : list.nextBefore !== null;
  const loadMore = async () => {
    if (!accountId || !mailboxPath || phase !== 'ready' || !hasMore || loadingMore) return;
    const generation = ++moreGeneration.current;
    const initialGeneration = listGeneration.current;
    setLoadingMore(true); setMoreError('');
    try {
      if (unified) {
        const { pages, failed } = await fetchUnified(scope.query, list.cursors);
        if (currentScope.current !== scope || listGeneration.current !== initialGeneration || moreGeneration.current !== generation) return;
        setList(current => mergeUnifiedPages(current, pages));
        setFailures(current => ({ ...current, ...failed }));
        if (!pages.length && Object.keys(failed).length) setMoreError(Object.values(failed)[0]!);
      } else {
        const page = await client.mailMessages(scope.accountId, { mailbox: scope.mailboxPath, q: scope.query || undefined, before: list.nextBefore!, limit: PAGE_SIZE });
        if (currentScope.current !== scope || listGeneration.current !== initialGeneration || moreGeneration.current !== generation) return;
        setList(current => appendMailPage(current, page));
      }
    } catch (reason) {
      if (currentScope.current !== scope || listGeneration.current !== initialGeneration || moreGeneration.current !== generation) return;
      setMoreError(reason instanceof Error ? reason.message : '이전 메일을 읽지 못했습니다.');
    } finally {
      if (currentScope.current === scope && listGeneration.current === initialGeneration && moreGeneration.current === generation) setLoadingMore(false);
    }
  };

  const mailbox = mailboxes.find(item => item.path === mailboxPath) ?? null;
  const resetScope = () => { setSearch(''); commitSearch(''); };

  if (accountsError && !accounts) {
    return <div className="mail mail--single">
      <InlineError>{accountsError}</InlineError>
      <span><Button variant="outline" size="sm" onClick={() => { setAccountsError(''); setAccounts(null); void reloadAccounts(true); }}>다시 시도</Button></span>
    </div>;
  }
  if (!accounts) {
    return <div className="mail mail--single grid content-start gap-2 p-1" aria-busy="true">
      <Skeleton className="h-6 w-40"/><Skeleton className="h-16 w-full"/><Skeleton className="h-16 w-full"/><Skeleton className="h-16 w-full"/>
    </div>;
  }
  if (!accounts.length) {
    return <EmptyState className="mail mail--single" icon={<MailX aria-hidden="true"/>} title="메일 계정 없음"
      action={<Button type="button" onClick={() => navigate('/settings?tab=connections')}>메일 계정 연결</Button>}/>;
  }

  const switchAccount = (id: string) => { resetScope(); rememberView(id); setMailboxPath(''); setAccountId(id); };
  const switchMailbox = (path: string) => { resetScope(); setMailboxPath(path); };
  const compactBack = compact
    ? <Button variant="ghost" size="sm" onClick={closeOpen}>목록으로</Button>
    : null;
  const newMail = (event: MouseEvent<HTMLButtonElement>) =>
    startCompose({ mode: 'new' }, unified ? (accounts.find(item => item.canSend) ?? accounts[0]!).connectionId : accountId, event.currentTarget);
  const listLabel = unified ? '전체 받은편지함' : mailbox ? mailboxLabel(mailbox) : '메일';
  const accountNames = new Map(accounts.map(item => [item.connectionId, item.name || item.address] as const));
  const readerMailboxes = unified && openTarget ? accountMailboxes.current.get(openTarget.accountId) ?? [] : mailboxes;

  const letter = compose && <MailCompose connectionId={compose.accountId} accounts={accounts} seed={compose.seed}
    onSent={() => { void loadList(); void reloadMailboxes(); }} onClose={() => setCompose(null)}/>;
  const freshLetter = compose?.seed.mode === 'new';

  // A new letter takes the reader's place; a reply or forward continues the message in that pane.
  let reader: ReactNode;
  if (freshLetter) {
    reader = <div className="mail-reader mail-reader--writing"><div className="mail-reader__scroll">{letter}</div></div>;
  } else if (openMessage && openTarget) {
    reader = <MailReader key={`${accountId}:${mailboxPath}:${openKey}:${activeOpen.current?.generation}`} connectionId={openTarget.accountId} mailboxPath={openTarget.mailboxPath} mailboxes={readerMailboxes}
      message={openMessage} busy={busy} actionError={actionError} onAction={action => void runAction(openMessage, action)}
      draft={letter} onBack={compact ? closeOpen : undefined}/>;
  } else if (openKey !== null && messageError) {
    reader = <div className="mail-reader mail-reader--empty">{compactBack}<InlineError>{messageError}</InlineError></div>;
  } else if (openKey !== null) {
    reader = <div className="mail-reader mail-reader--empty">{compactBack}
      <div className="grid w-full max-w-md gap-2 px-6" aria-busy="true">
        <Skeleton className="h-6 w-2/3"/><Skeleton className="h-4 w-1/3"/><Skeleton className="h-48 w-full"/>
      </div>
    </div>;
  } else {
    reader = compact ? null
      : <div className="mail-reader mail-reader--empty"><p className="m-0 text-ui text-ink-3">메일을 선택해 주세요</p></div>;
  }

  const stacked = compact && (freshLetter || openKey !== null);
  return <div className="mail" data-writing={compose ? true : undefined}>
    <nav className="mail-nav" aria-label="메일함" hidden={stacked} inert={Boolean(compose)}>
      {accounts.length > 1 && <select className="mail-switch" value={accountId} aria-label="메일 계정"
        onChange={event => switchAccount(event.target.value)}>
        <option value={ALL_ACCOUNTS}>전체 계정</option>
        {accounts.map(item => <option key={item.connectionId} value={item.connectionId}>{item.name || item.address}</option>)}
      </select>}
      {unified
        ? compact ? null : <ul className="mail-folders"><li>
          <button type="button" className="mail-folder" aria-current="true"><span className="mail-folder__name">받은편지함</span></button>
        </li></ul>
        : compact
          ? <select className="mail-switch" value={mailboxPath} aria-label="메일함"
            onChange={event => switchMailbox(event.target.value)}>
            {mailboxes.map(item => <option key={item.path} value={item.path}>
              {mailboxLabel(item)}{(item.unseen ?? 0) > 0 ? ` (${item.unseen})` : ''}</option>)}
          </select>
          : <ul className="mail-folders">
            {mailboxes.map(item => <li key={item.path}>
              <button type="button" className="mail-folder" aria-current={item.path === mailboxPath || undefined}
                onClick={() => switchMailbox(item.path)}>
                <span className="mail-folder__name">{mailboxLabel(item)}</span>
                {(item.unseen ?? 0) > 0 && <span className="mail-folder__count tabular">{item.unseen}</span>}
              </button>
            </li>)}
          </ul>}
      {!compact && <Button ref={writeButton} variant="ghost" size="sm" className="mail-nav__write" disabled={!accountId} onClick={newMail}>
        <MailPlus size={15}/>메일 쓰기</Button>}
    </nav>
    <section className="mail-list" aria-label={`${listLabel} 목록`} hidden={stacked} inert={Boolean(compose)}>
      <div className="mail-list__bar">
        {compact && <Button ref={writeButton} variant="ghost" size="icon" aria-label="메일 쓰기" disabled={!accountId} onClick={newMail}>
          <MailPlus size={16}/></Button>}
        <label className="mail-search">
          <Search size={14} aria-hidden="true"/>
          <input type="search" placeholder="메일 검색" aria-label="메일 검색" value={search}
            onChange={event => onSearchInput(event.target.value)} onKeyDown={onSearchKey}/>
        </label>
        <Button variant="ghost" size="icon" aria-label="메일 새로고침" disabled={!accountId || !mailboxPath || phase === 'loading'}
          onClick={() => { void loadList(); void reloadMailboxes(); }}><RotateCw size={15}/></Button>
      </div>
      <div className="mail-list__scroll">
        {Object.entries(failures).map(([id, message]) => <div key={id} className="mail-list__error">
          <InlineError>{accountNames.get(id) ?? '계정'}: {message}</InlineError></div>)}
        {phase === 'loading' && <ul className="mail-rows" aria-busy="true">
          {[0, 1, 2, 3, 4].map(row => <li key={row} className="mail-row mail-row--loading">
            <Skeleton className="h-4 w-1/2"/><Skeleton className="h-3 w-3/4"/>
          </li>)}
        </ul>}
        {phase === 'error' && <div className="mail-list__error"><InlineError>{listError}</InlineError></div>}
        {phase === 'ready' && !list.messages.length
          && <div className="calm mail-list__empty"><MailX size={16} aria-hidden="true"/><p>{list.query ? '일치하는 메일 없음' : '메일 없음'}</p></div>}
        {phase === 'ready' && list.messages.length > 0 && <ul className="mail-rows">
          {list.messages.map(message => <li key={rowKey(message)}>
            <button type="button" className="mail-row" data-unread={!message.seen || undefined}
              aria-current={rowKey(message) === openKey || undefined} onClick={() => void open(message)}>
              <span className="mail-row__line">
                <span className="mail-row__from">{mailAddressName(message.from)}</span>
                {unified && message.accountName && <span className="mail-row__account">{message.accountName}</span>}
                <span className="mail-row__flags">
                  {message.flagged && <Star size={12} fill="currentColor" aria-label="별표 메일"/>}
                  {message.hasAttachments && <Paperclip size={12} aria-label="첨부 파일 있음"/>}
                </span>
                <time className="mail-row__date tabular">{relativeTime(message.date, now)}</time>
              </span>
              <span className="mail-row__subject">{message.subject || '(제목 없음)'}</span>
            </button>
          </li>)}
        </ul>}
        {moreError && <div className="mail-list__error"><InlineError>{moreError}</InlineError></div>}
        {phase === 'ready' && hasMore && <div className="mail-list__more">
          <Button variant="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? '불러오는 중…' : '이전 메일 더 보기'}</Button>
        </div>}
      </div>
    </section>
    {reader}
  </div>;
}
