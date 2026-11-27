import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, MailPlus, MailX, Paperclip, Reply, RotateCw, Search, Star } from 'lucide-react';
import { Button, EmptyState, InlineError, Popover, PopoverContent, PopoverTrigger, Skeleton } from '../../ui';
import type { MailAccounts, MailboxInfo, MailMessage } from '../../host/client';
import { useHost } from '../../host/context';
import { relativeTime, useNow } from '../time';
import { blurTouchSearchOnEnter, useCompact } from '../../ui/adaptive';
import { isDesktopShell } from '../../host/desktop';
import { MailCompose, type ComposeSeed } from './MailCompose';
import { MailReader, type MailReaderAction } from './MailReader';
import {
  ALL_ACCOUNTS, ALL_INBOX, appendMailPage, emptyMailList, inboxMailbox, mailboxLabel, mailAddressName,
  mergeUnifiedPages, mergedInboxUnseen, orderMailboxes, patchMailMessage, refreshMailPage, removeMailMessage, shiftMailboxUnseen,
  unifiedHasMore, type ListedMail, type MailListState, type UnifiedPage,
} from './mail-data';
import './MailDesk.css';

type Account = MailAccounts['accounts'][number];
/** Where one message lives. Uids repeat across accounts, so every action names its own account. */
interface Target { accountId: string; mailboxPath: string }
interface Scope extends Target { query: string }
interface OpenSelection {
  scope: Scope;
  target: Target;
  uid: number;
  generation: number;
  markSeen: boolean;
  message: MailMessage | null;
}

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE = 400;
/** New mail shows up by itself; this is how often the visible list asks the server. */
const QUIET_REFRESH_MS = 90_000;
/** The account (or 전체 계정) the owner last chose; opens first next time while that account still exists. */
const VIEW_KEY = 'ghost-mail:view';
const savedView = () => { try { return localStorage.getItem(VIEW_KEY); } catch { return null; } };
const rememberView = (id: string) => { try { localStorage.setItem(VIEW_KEY, id); } catch { /* a private window cannot save; the choice holds for this screen only. */ } };
const rowKey = (message: ListedMail) => `${message.accountId ?? ''}:${message.uid}`;

// The web uses the shell's compact mode. A narrow native window needs the same mail layout.
const compactQuery = '(max-width: 55.999rem)';
function subscribeMailWidth(listener: () => void) {
  const media = matchMedia(compactQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

const accountLabel = (account: Account) => account.name || account.address;

/** Keep the current text tab in view without scrolling the list or the shell with it. */
function revealMailTab(tab: HTMLButtonElement | null) {
  const rail = tab?.parentElement;
  if (!rail || !tab) return;
  const inner = tab.getBoundingClientRect(), outer = rail.getBoundingClientRect();
  if (inner.left < outer.left) rail.scrollLeft += inner.left - outer.left;
  else if (inner.right > outer.right) rail.scrollLeft += inner.right - outer.right;
}

function UnseenCount({ count }: { count: number | null }) {
  return count !== null && count > 0 ? <span className="mail-tab__count">{count}</span> : null;
}

function AccountScope({ accounts, current, onSelect }: { accounts: Account[]; current: string; onSelect(id: string): void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const selected = accounts.find(account => account.connectionId === current);
  const currentName = current === ALL_ACCOUNTS ? '전체 계정' : selected ? accountLabel(selected) : '메일 계정';
  const tab = (id: string, label: string, inline = false) => <button key={id} type="button" className="mail-tab" title={label}
    aria-current={id === current || undefined} ref={inline && id === current ? revealMailTab : undefined}
    onClick={() => { onSelect(id); setOpen(false); setQuery(''); }}><span className="mail-tab__label">{label}</span></button>;
  const term = query.trim().toLowerCase();
  const matches = accounts.length > 4
    ? accounts.filter(account => `${account.name} ${account.address}`.toLowerCase().includes(term))
    : accounts;
  const showAll = !term || '전체 계정'.includes(term);
  return <nav className="mail-scope mail-scope--accounts" aria-label="메일 계정">
    {accounts.length === 1 ? <div className="mail-scope__tabs">
      <span className="mail-tab mail-tab__label mail-scope__name" title={accountLabel(accounts[0]!)}>{accountLabel(accounts[0]!)}</span>
    </div> : accounts.length <= 4 ? <div className="mail-scope__tabs">
      {tab(ALL_ACCOUNTS, '전체 계정', true)}
      {accounts.map(account => tab(account.connectionId, accountLabel(account), true))}
    </div> : <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) setQuery(''); }}>
      <PopoverTrigger className="mail-tab" title={currentName}>
        <span className="mail-tab__label">{currentName}</span><ChevronDown size={13} aria-hidden="true"/>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="메일 계정 선택" onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus(); }}>
        <div className="mail-picker">
          <label className="mail-search">
            <Search size={14} aria-hidden="true"/>
            <input ref={search} type="search" aria-label="계정 검색" placeholder="계정 검색" value={query} onChange={event => setQuery(event.target.value)}/>
          </label>
          {showAll && tab(ALL_ACCOUNTS, '전체 계정')}
          {matches.map(account => tab(account.connectionId, accountLabel(account)))}
          {!showAll && !matches.length && <p className="mail-picker__empty" role="status">일치하는 계정 없음</p>}
        </div>
      </PopoverContent>
    </Popover>}
  </nav>;
}

function MailboxScope({ mailboxes, current, unified, unseen, onSelect }: {
  mailboxes: MailboxInfo[]; current: string; unified: boolean; unseen: number | null; onSelect(path: string): void;
}) {
  const [open, setOpen] = useState(false);
  // Inbox and Archive stay at hand. An open overflow mailbox stays visible beside them.
  const first = mailboxes[0];
  const second = mailboxes.find(mailbox => mailbox !== first && mailbox.specialUse === 'archive') ?? mailboxes[1];
  const selected = mailboxes.find(mailbox => mailbox.path === current);
  const extra = mailboxes.filter(mailbox => mailbox !== first && mailbox !== second);
  const tab = (mailbox: MailboxInfo, inline = false) => <button type="button" className="mail-tab" key={mailbox.path} title={mailboxLabel(mailbox)}
    aria-current={mailbox.path === current || undefined} ref={inline && mailbox.path === current ? revealMailTab : undefined}
    onClick={() => { onSelect(mailbox.path); setOpen(false); }}>
    <span className="mail-tab__label">{mailboxLabel(mailbox)}</span><UnseenCount count={mailbox.unseen}/>
  </button>;
  return <nav className="mail-scope mail-scope--mailboxes" aria-label="메일함">
    <div className="mail-scope__tabs">
      {unified ? <span className="mail-tab mail-scope__name"><span className="mail-tab__label">받은편지함</span><UnseenCount count={unseen}/></span> : <>
        {first && tab(first, true)}
        {second && tab(second, true)}
        {selected && extra.includes(selected) && tab(selected, true)}
      </>}
    </div>
    {extra.length > 0 && <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="mail-tab">더보기</PopoverTrigger>
      <PopoverContent align="end" aria-label="다른 메일함">
        <div className="mail-picker">{extra.map(mailbox => tab(mailbox))}</div>
      </PopoverContent>
    </Popover>}
  </nav>;
}

/** One list and its reading pane, with a read-only first preview on wide screens. */
export function MailView({ navigate }: { navigate(path: string): void }) {
  const { client } = useHost();
  const phone = useCompact();
  const narrow = useSyncExternalStore(subscribeMailWidth, () => matchMedia(compactQuery).matches, () => false);
  const compact = phone || (isDesktopShell() && narrow);
  const now = useNow();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountsError, setAccountsError] = useState('');
  const [accountId, setAccountId] = useState('');
  const [mailboxes, setMailboxes] = useState<MailboxInfo[]>([]);
  const [mailboxReload, setMailboxReload] = useState(0);
  const [unifiedUnseen, setUnifiedUnseen] = useState<number | null>(null);
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
  const backButton = useRef<HTMLButtonElement>(null);
  const lastRow = useRef<HTMLButtonElement | null>(null);
  const freshLetter = compose?.seed.mode === 'new';
  const stacked = compact && (freshLetter || openKey !== null);
  useLayoutEffect(() => {
    if (stacked && !freshLetter) backButton.current?.focus({ preventScroll: true });
    if (!stacked && lastRow.current) {
      (lastRow.current.isConnected ? lastRow.current : writeButton.current)?.focus({ preventScroll: true });
      lastRow.current = null;
    }
  }, [stacked, freshLetter]);
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
  const scope = useMemo<Scope>(() => ({ accountId, mailboxPath, query }), [accountId, mailboxPath, query]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const listGeneration = useRef(0);
  const loadedScope = useRef<Scope | null>(null);
  const previewedScope = useRef<Scope | null>(null);
  const moreGeneration = useRef(0);
  const openGeneration = useRef(0);
  const refreshing = useRef(false);
  const activeOpen = useRef<OpenSelection | null>(null);
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
    loadedScope.current = null;
    ++moreGeneration.current;
    setLoadingMore(false);
    setList(emptyMailList);
    setPhase('loading'); setListError(''); setMoreError(''); setFailures({});
    try {
      if (scope.accountId === ALL_ACCOUNTS) {
        const { pages, failed } = await fetchUnified(scope.query, null);
        if (currentScope.current !== scope || listGeneration.current !== generation) return;
        setUnifiedUnseen(mergedInboxUnseen(accounts ?? [], accountMailboxes.current));
        setFailures(failed);
        if (!pages.length && Object.keys(failed).length) {
          setPhase('error');
          return;
        }
        loadedScope.current = scope;
        setList(mergeUnifiedPages({ ...emptyMailList, query: scope.query }, pages));
        setPhase('ready');
        return;
      }
      const page = await client.mailMessages(scope.accountId, { mailbox: scope.mailboxPath, q: scope.query || undefined, limit: PAGE_SIZE });
      if (currentScope.current !== scope || listGeneration.current !== generation) return;
      loadedScope.current = scope;
      setList({ ...emptyMailList, messages: page.messages, nextBefore: page.nextBefore, query: scope.query });
      setPhase('ready');
    } catch (reason) {
      if (currentScope.current !== scope || listGeneration.current !== generation) return;
      setListError(reason instanceof Error ? reason.message : '메일을 읽지 못했습니다.');
      setPhase('error');
    }
  }, [accounts, client, scope, fetchUnified]);

  // A new account brings its mailboxes; the view opens on its first (받은편지함 when present).
  // The old account's mailbox drops at once so no load runs against the wrong account.
  // 전체 계정 has no mailbox list of its own: it reads every account's inbox.
  useEffect(() => {
    if (!accountId) return;
    setMailboxes([]);
    setList(emptyMailList);
    setPhase('loading');
    setListError(''); setMoreError(''); setFailures({});
    if (accountId === ALL_ACCOUNTS) { setMailboxPath(ALL_INBOX); return; }
    let alive = true;
    setMailboxPath('');
    (async () => {
      try {
        const result = await client.mailMailboxes(accountId);
        if (!alive) return;
        const ordered = orderMailboxes(result.mailboxes);
        setMailboxes(ordered);
        setMailboxPath(ordered[0]?.path ?? '');
        if (!ordered.length) setPhase('ready');
      } catch (reason) {
        if (!alive) return;
        setListError(reason instanceof Error ? reason.message : '메일함을 읽지 못했습니다.');
        setPhase('error');
      }
    })();
    return () => { alive = false; };
  }, [accountId, client, mailboxReload]);

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
    if (event.key === 'Enter') { event.preventDefault(); commitSearch(search.trim()); blurTouchSearchOnEnter(event); }
    if (event.key === 'Escape') { event.preventDefault(); setSearch(''); commitSearch(''); }
  };

  const reloadMailboxes = async () => {
    if (scope.accountId === ALL_ACCOUNTS && accounts) {
      const results = await Promise.allSettled(accounts.map(async account =>
        [account.connectionId, orderMailboxes((await client.mailMailboxes(account.connectionId)).mailboxes)] as const));
      if (currentScope.current !== scope) return;
      for (const result of results) {
        if (result.status === 'fulfilled') accountMailboxes.current.set(...result.value);
      }
      setUnifiedUnseen(results.every(result => result.status === 'fulfilled') ? mergedInboxUnseen(accounts, accountMailboxes.current) : null);
    } else if (scope.accountId) {
      try {
        const result = await client.mailMailboxes(scope.accountId);
        if (currentScope.current !== scope) return;
        setMailboxes(orderMailboxes(result.mailboxes));
      } catch { /* counts are cosmetic; the stored list stays. */ }
    }
  };

  /**
   * New mail without a click: fold in the first page. Skipped while a search
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
      }
      void reloadMailboxes();
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

  const shiftUnseen = (target: Target, delta: number) => {
    if (!unified) {
      setMailboxes(current => shiftMailboxUnseen(current, target.mailboxPath, delta));
      return;
    }
    const boxes = accountMailboxes.current.get(target.accountId);
    if (!boxes) return;
    accountMailboxes.current.set(target.accountId, shiftMailboxUnseen(boxes, target.mailboxPath, delta));
    const total = mergedInboxUnseen(accounts ?? [], accountMailboxes.current);
    setUnifiedUnseen(current => current === null ? null : total);
  };

  const markOpenSeen = async (selection: OpenSelection, message: MailMessage) => {
    if (message.seen) return;
    const { target, uid } = selection;
    setBusy('seen'); setActionError('');
    try {
      await client.mailUpdate({ type: 'mail.update', connectionId: target.accountId, mailbox: target.mailboxPath, uids: [uid], action: 'seen' });
      if (currentScope.current !== scope || activeOpen.current !== selection) return;
      patchRow(target, uid, { seen: true });
      setOpenMessage(current => current ? { ...current, seen: true } : current);
      shiftUnseen(target, -1);
    } catch (reason) {
      if (currentScope.current === scope && activeOpen.current === selection) {
        setActionError(reason instanceof Error ? reason.message : '읽음으로 표시하지 못했습니다.');
      }
    } finally {
      if (currentScope.current === scope && activeOpen.current === selection) setBusy('');
    }
  };

  /** Only an explicit open marks seen. A preview uses the same BODY.PEEK request without the update. */
  const open = async (summary: ListedMail, markSeen = true) => {
    if (!accountId || !mailboxPath) return;
    const target = targetOf(summary);
    const active = activeOpen.current;
    if (!messageError && active?.scope === scope && active.uid === summary.uid && active.target.accountId === target.accountId) {
      if (markSeen && !active.markSeen && !busy) {
        active.markSeen = true;
        const message = openMessage ?? active.message;
        if (message) await markOpenSeen(active, message);
      }
      return;
    }
    const selection: OpenSelection = { scope, target, uid: summary.uid, generation: ++openGeneration.current, markSeen, message: null };
    activeOpen.current = selection;
    previewedScope.current = scope;
    setOpenKey(rowKey(summary)); setOpenTarget(target); setOpenMessage(null); setMessageError(''); setActionError(''); setBusy('');
    try {
      const message = await client.mailMessage(target.accountId, target.mailboxPath, summary.uid);
      if (currentScope.current !== scope || activeOpen.current !== selection) return;
      selection.message = message;
      setOpenMessage(message);
      if (selection.markSeen) await markOpenSeen(selection, message);
    } catch (reason) {
      if (currentScope.current !== scope || activeOpen.current !== selection) return;
      setMessageError(reason instanceof Error ? reason.message : '메일을 읽지 못했습니다.');
    }
  };

  const previewUnread = useEffectEvent(() => {
    if (loadedScope.current !== scope || previewedScope.current === scope || activeOpen.current) return;
    const unread = list.messages.find(message => !message.seen);
    if (unread) void open(unread, false);
  });
  useEffect(() => {
    if (!compact && !compose && phase === 'ready') previewUnread();
  }, [compact, compose, phase, scope, list.messages]);

  // On a phone the title bar's 「<」 is the one way back: it closes the open message before it leaves the page.
  useEffect(() => {
    if (!phone) return;
    const back = (event: Event) => {
      const button = backButton.current;
      if (!button || button.disabled) return;
      event.preventDefault();
      button.click();
    };
    window.addEventListener('ghost:back', back);
    return () => window.removeEventListener('ghost:back', back);
  }, [phone]);

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
        shiftUnseen(target, seen ? -1 : 1);
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
  const refresh = () => {
    if (!mailboxPath) { setMailboxReload(value => value + 1); return; }
    void loadList(); void reloadMailboxes();
  };

  const onRowKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (compact || event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.nativeEvent.isComposing
      || !(event.target instanceof HTMLButtonElement)) return;
    const row = event.target.parentElement;
    const sibling = event.key === 'j' || event.key === 'ArrowDown' ? row?.nextElementSibling
      : event.key === 'k' || event.key === 'ArrowUp' ? row?.previousElementSibling : null;
    const next = sibling?.querySelector('button');
    if (next) { event.preventDefault(); next.focus(); next.click(); }
  };

  if (accountsError && !accounts) {
    return <div className="mail mail--single">
      <InlineError>{accountsError}</InlineError>
      <span><Button variant="outline" size="sm" onClick={() => { setAccountsError(''); setAccounts(null); void reloadAccounts(true); }}>다시 시도</Button></span>
    </div>;
  }
  if (!accounts) {
    return <div className="mail mail--single" role="status" aria-busy="true">
      <span className="sr-only">메일 계정 불러오는 중</span>
      <div className="mail-skeleton" aria-hidden="true"><Skeleton className="h-6 w-40"/><Skeleton className="h-14 w-full"/><Skeleton className="h-14 w-full"/></div>
    </div>;
  }
  if (!accounts.length) {
    return <EmptyState className="mail mail--single" icon={<MailX aria-hidden="true"/>} title="메일 계정 없음"
      action={<Button type="button" onClick={() => navigate('/settings?tab=connections')}>메일 계정 연결</Button>}/>;
  }

  const switchAccount = (id: string) => {
    if (id === accountId) return;
    resetScope(); rememberView(id);
    setMailboxes([]); setUnifiedUnseen(null); setMailboxPath(''); setAccountId(id);
  };
  const switchMailbox = (path: string) => { if (path !== mailboxPath) { resetScope(); setMailboxPath(path); } };
  const newMail = (event: MouseEvent<HTMLButtonElement>) =>
    startCompose({ mode: 'new' }, unified ? (accounts.find(item => item.canSend) ?? accounts[0]!).connectionId : accountId, event.currentTarget);
  const listLabel = unified ? '전체 받은편지함' : mailbox ? mailboxLabel(mailbox) : '메일';
  const accountNames = new Map(accounts.map(item => [item.connectionId, accountLabel(item)] as const));
  const readerMailboxes = unified && openTarget ? accountMailboxes.current.get(openTarget.accountId) ?? [] : mailboxes;
  const ownerAddress = openTarget && accounts.find(account => account.connectionId === openTarget.accountId)?.address;
  const letter = compose && <MailCompose connectionId={compose.accountId} accounts={accounts} seed={compose.seed}
    onSent={() => { if (mailboxPath) void loadList(); void reloadMailboxes(); }} onClose={() => setCompose(null)}/>;

  // A new letter takes the reader's place; a reply or forward continues under the original.
  let reader: ReactNode;
  if (freshLetter) {
    reader = <div className="mail-reader"><div className="mail-reader__scroll"><div className="mail-reader__measure">{letter}</div></div></div>;
  } else if (openMessage && openTarget) {
    reader = <MailReader key={activeOpen.current?.generation} connectionId={openTarget.accountId} mailboxPath={openTarget.mailboxPath}
      ownerAddress={ownerAddress || undefined} mailboxes={readerMailboxes} message={openMessage} busy={busy} actionError={actionError}
      onAction={action => void runAction(openMessage, action)} draft={letter}/>;
  } else if (openKey !== null && messageError) {
    const summary = list.messages.find(message => rowKey(message) === openKey);
    reader = <div className="mail-reader mail-reader--empty">
      <InlineError>{messageError}</InlineError>
      {summary && <Button type="button" variant="outline" size="sm" onClick={() => void open(summary, activeOpen.current?.markSeen)}>다시 시도</Button>}
    </div>;
  } else if (openKey !== null) {
    reader = <div className="mail-reader mail-reader--empty">
      <div className="mail-skeleton" role="status" aria-busy="true">
        <span className="sr-only">메일 불러오는 중</span>
        <Skeleton className="h-7 w-2/3"/><Skeleton className="h-4 w-1/2"/><Skeleton className="h-32 w-full"/>
      </div>
    </div>;
  } else {
    reader = compact ? null : <div className="mail-reader mail-reader--empty">
      {phase === 'ready' && list.messages.length > 0 && <p>읽을 메일을 선택하세요.</p>}
    </div>;
  }

  const failedAccounts = Object.entries(failures);
  return <div className="mail">
    <section className="mail-list" aria-label={`${listLabel} 목록`} aria-hidden={stacked || undefined} inert={stacked || Boolean(compose)}>
      <header className="mail-list__head">
        <div className="mail-list__navigation">
          <AccountScope accounts={accounts} current={accountId} onSelect={switchAccount}/>
          <MailboxScope key={accountId} mailboxes={mailboxes} current={mailboxPath} unified={unified} unseen={unifiedUnseen} onSelect={switchMailbox}/>
        </div>
        <div className="mail-list__bar">
          <label className="mail-search">
            <Search size={14} aria-hidden="true"/>
            <input type="search" placeholder="메일 검색" aria-label="메일 검색" value={search} disabled={!mailboxPath}
              onChange={event => onSearchInput(event.target.value)} onKeyDown={onSearchKey}/>
          </label>
          <Button type="button" variant="ghost" size="icon" aria-label="메일 새로고침" title="메일 새로고침" disabled={!accountId || phase === 'loading'}
            onClick={refresh}><RotateCw size={15} aria-hidden="true"/></Button>
          <Button type="button" ref={writeButton} disabled={!accountId} onClick={newMail}><MailPlus size={15} aria-hidden="true"/>메일 쓰기</Button>
        </div>
      </header>
      <div className="mail-list__scroll">
        {failedAccounts.map(([id, message]) => <div key={id} className="mail-list__error">
          <InlineError>{accountNames.get(id) ?? '계정'}: {message}</InlineError></div>)}
        {phase === 'loading' && <ul className="mail-rows" aria-busy="true" aria-label={mailboxPath ? '메일 불러오는 중' : '메일함 불러오는 중'}>
          {[0, 1, 2, 3, 4].map(row => <li key={row} className="mail-row mail-row--loading" aria-hidden="true">
            <div className="mail-row__copy"><Skeleton className="h-4 w-1/2"/><Skeleton className="h-3 w-3/4"/></div>
          </li>)}
        </ul>}
        {phase === 'error' && <div className="mail-list__status">
          {!failedAccounts.length && <InlineError>{listError}</InlineError>}
          <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={refresh}>다시 시도</Button>
        </div>}
        {phase === 'ready' && !list.messages.length && <div className="mail-list__empty">
          <MailX size={16} aria-hidden="true"/>
          <p>{!mailboxPath ? '메일함 없음'
            : failedAccounts.length ? (list.query ? '불러온 계정에 일치하는 메일 없음' : '불러온 계정에 메일 없음')
            : list.query ? '일치하는 메일 없음' : '메일 없음'}</p>
        </div>}
        {phase === 'ready' && list.messages.length > 0 && <ul className="mail-rows" onKeyDown={onRowKey}>
          {list.messages.map(message => <li key={rowKey(message)}>
            <button type="button" className="mail-row" data-unread={!message.seen || undefined} data-flagged={message.flagged || undefined}
              aria-current={rowKey(message) === openKey || undefined} onClick={event => {
                if (compact) lastRow.current = event.currentTarget;
                void open(message);
              }}>
              <span className="mail-row__mark">{!message.seen && <span className="mail-row__dot" role="img" aria-label="읽지 않음" title="읽지 않음"/>}</span>
              <span className="mail-row__copy">
                <span className="mail-row__line">
                  <span className="mail-row__from">{mailAddressName(message.from)}</span>
                  {unified && message.accountName && <span className="mail-row__account" title={message.accountName}>{message.accountName}</span>}
                </span>
                <span className="mail-row__subject">{message.subject || '(제목 없음)'}</span>
              </span>
              <span className="mail-row__value">
                <time className="mail-row__date" dateTime={new Date(message.date).toISOString()}>{relativeTime(message.date, now)}</time>
                {(message.flagged || message.hasAttachments || message.answered) && <span className="mail-row__flags">
                  {message.flagged && <Star className="mail-row__flag" size={12} fill="currentColor" role="img" aria-label="별표 메일"><title>별표 메일</title></Star>}
                  {message.hasAttachments && <Paperclip size={12} role="img" aria-label="첨부 파일 있음"><title>첨부 파일 있음</title></Paperclip>}
                  {message.answered && <Reply size={12} role="img" aria-label="답장함"><title>답장함</title></Reply>}
                </span>}
              </span>
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
    {reader && <div className="mail-pane">
      {stacked && !freshLetter && <Button ref={backButton} type="button" className={phone ? 'mail-pane__back mail-pane__back--bar' : 'mail-pane__back'} variant="ghost" size="sm"
        aria-label={openMessage ? undefined : '목록으로'} disabled={Boolean(compose)} onClick={closeOpen}>
        <ChevronLeft size={15} aria-hidden="true"/>목록
      </Button>}
      {reader}
    </div>}
  </div>;
}
