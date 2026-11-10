import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { MailPlus, MailX, Paperclip, RotateCw, Search, Star } from 'lucide-react';
import { Button, EmptyState, InlineError, Skeleton } from '../../ui';
import type { MailAccounts, MailboxInfo, MailMessage, MailSummary } from '../../host/client';
import { useHost } from '../../host/context';
import { relativeTime, useNow } from '../time';
import { ConnectionDialog } from '../Connections';
import { MailCompose, type ComposeSeed } from './MailCompose';
import { MailReader, type MailReaderAction } from './MailReader';
import {
  appendMailPage, defaultMailbox, emptyMailList, mailboxLabel, mailAddressName, orderMailboxes,
  patchMailMessage, removeMailMessage, shiftMailboxUnseen, type MailListState,
} from './mail-data';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE = 400;

// Match mail.css even in a narrow native Mac window; shell chrome is a separate concern.
const compactQuery = '(max-width: 55.999rem)';
function subscribeMailWidth(listener: () => void) {
  const media = matchMedia(compactQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

/**
 * 메일: the owner's mail accounts as a familiar three-pane client — mailboxes, list, reader.
 * Below 56rem the panes stack: account and mailbox become selects above the list, and an open
 * message takes the whole sheet with a back button (iPhone).
 */
export function MailView() {
  const { client } = useHost();
  const compact = useSyncExternalStore(subscribeMailWidth, () => matchMedia(compactQuery).matches, () => false);
  const now = useNow();
  const [accounts, setAccounts] = useState<MailAccounts['accounts'] | null>(null);
  const [accountsError, setAccountsError] = useState('');
  const [accountId, setAccountId] = useState('');
  const [mailboxes, setMailboxes] = useState<MailboxInfo[]>([]);
  const [mailboxPath, setMailboxPath] = useState('');
  const [list, setList] = useState<MailListState>(emptyMailList);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState('');
  const [moreError, setMoreError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [openUid, setOpenUid] = useState<number | null>(null);
  const [openMessage, setOpenMessage] = useState<MailMessage | null>(null);
  const [messageError, setMessageError] = useState('');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [compose, setCompose] = useState<ComposeSeed | null>(null);
  const [adding, setAdding] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scope = useMemo(() => ({ accountId, mailboxPath, query }), [accountId, mailboxPath, query]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const listGeneration = useRef(0);
  const moreGeneration = useRef(0);
  const openGeneration = useRef(0);
  const activeOpen = useRef<{ scope: typeof scope; uid: number; generation: number } | null>(null);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const reloadAccounts = useCallback(async (pickFirst = false) => {
    try {
      const result = await client.mailAccounts();
      setAccounts(result.accounts);
      setAccountsError('');
      if (pickFirst && result.accounts.length) setAccountId(result.accounts[0]!.connectionId);
    } catch (reason) {
      setAccountsError(reason instanceof Error ? reason.message : '메일 계정을 읽지 못했습니다.');
    }
  }, [client]);
  useEffect(() => { void reloadAccounts(true); }, [reloadAccounts]);

  const loadList = useCallback(async () => {
    const generation = ++listGeneration.current;
    ++moreGeneration.current;
    setLoadingMore(false);
    setList(emptyMailList);
    setPhase('loading'); setListError(''); setMoreError('');
    try {
      const page = await client.mailMessages(scope.accountId, { mailbox: scope.mailboxPath, q: scope.query || undefined, limit: PAGE_SIZE });
      if (currentScope.current !== scope || listGeneration.current !== generation) return;
      setList({ messages: page.messages, nextBefore: page.nextBefore, query: scope.query });
      setPhase('ready');
    } catch (reason) {
      if (currentScope.current !== scope || listGeneration.current !== generation) return;
      setListError(reason instanceof Error ? reason.message : '메일을 읽지 못했습니다.');
      setPhase('error');
    }
  }, [client, scope]);

  // A new account brings its mailboxes; the view opens on its first (받은편지함 when present).
  // The old account's mailbox drops at once so no load runs against the wrong account.
  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    setMailboxPath('');
    setMailboxes([]);
    setList(emptyMailList);
    setPhase('loading');
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
    setOpenUid(null); setOpenMessage(null); setMessageError(''); setActionError(''); setBusy('');
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
    if (!scope.accountId) return;
    try {
      const result = await client.mailMailboxes(scope.accountId);
      if (currentScope.current !== scope) return;
      setMailboxes(orderMailboxes(result.mailboxes));
    } catch { /* counts are cosmetic; the stored list stays. */ }
  };

  /** Opening a message reads it, then marks it seen and drops the mailbox's unseen count. */
  const open = async (summary: MailSummary) => {
    if (!accountId || !mailboxPath) return;
    if (activeOpen.current?.scope === scope && activeOpen.current.uid === summary.uid) return;
    const selection = { scope, uid: summary.uid, generation: ++openGeneration.current };
    activeOpen.current = selection;
    let loaded = false;
    setOpenUid(summary.uid); setOpenMessage(null); setMessageError(''); setActionError(''); setBusy('');
    try {
      const message = await client.mailMessage(scope.accountId, scope.mailboxPath, summary.uid);
      if (currentScope.current !== scope || activeOpen.current !== selection) return;
      setOpenMessage(message);
      loaded = true;
      if (!message.seen) {
        setBusy('seen');
        await client.mailUpdate({ type: 'mail.update', connectionId: scope.accountId, mailbox: scope.mailboxPath, uids: [summary.uid], action: 'seen' });
        if (currentScope.current !== scope || activeOpen.current !== selection) return;
        setList(current => patchMailMessage(current, summary.uid, { seen: true }));
        setOpenMessage(current => current ? { ...current, seen: true } : current);
        setMailboxes(current => shiftMailboxUnseen(current, scope.mailboxPath, -1));
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
    setOpenUid(null); setOpenMessage(null); setMessageError(''); setActionError(''); setBusy('');
  };

  const runAction = async (message: MailMessage, action: MailReaderAction) => {
    const selection = activeOpen.current;
    if (!accountId || !mailboxPath || busy || selection?.scope !== scope || selection.uid !== message.uid) return;
    setBusy(action.type); setActionError('');
    const update = (command: { action: 'seen' | 'unseen' | 'flag' | 'unflag' | 'archive' | 'trash' | 'move'; target?: string }) =>
      client.mailUpdate({ type: 'mail.update', connectionId: accountId, mailbox: mailboxPath, uids: [message.uid], ...command });
    try {
      if (action.type === 'reply' || action.type === 'forward') {
        setCompose({ mode: action.type, mailbox: mailboxPath, message });
      } else if (action.type === 'toggleSeen') {
        const seen = !message.seen;
        await update({ action: seen ? 'seen' : 'unseen' });
        if (currentScope.current !== scope || activeOpen.current !== selection) return;
        setList(current => patchMailMessage(current, message.uid, { seen }));
        setOpenMessage(current => current?.uid === message.uid ? { ...current, seen } : current);
        setMailboxes(current => shiftMailboxUnseen(current, mailboxPath, seen ? -1 : 1));
      } else if (action.type === 'toggleFlag') {
        const flagged = !message.flagged;
        await update({ action: flagged ? 'flag' : 'unflag' });
        if (currentScope.current !== scope || activeOpen.current !== selection) return;
        setList(current => patchMailMessage(current, message.uid, { flagged }));
        setOpenMessage(current => current?.uid === message.uid ? { ...current, flagged } : current);
      } else if (action.type === 'move') {
        await update({ action: 'move', target: action.target });
        if (currentScope.current !== scope || activeOpen.current !== selection) return;
        setList(current => removeMailMessage(current, message.uid));
        closeOpen();
        void reloadMailboxes();
      } else {
        await update({ action: action.type });
        if (currentScope.current !== scope || activeOpen.current !== selection) return;
        setList(current => removeMailMessage(current, message.uid));
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

  const loadMore = async () => {
    if (!accountId || !mailboxPath || phase !== 'ready' || list.nextBefore === null || loadingMore) return;
    const generation = ++moreGeneration.current;
    const initialGeneration = listGeneration.current;
    setLoadingMore(true); setMoreError('');
    try {
      const page = await client.mailMessages(scope.accountId, { mailbox: scope.mailboxPath, q: scope.query || undefined, before: list.nextBefore, limit: PAGE_SIZE });
      if (currentScope.current !== scope || listGeneration.current !== initialGeneration || moreGeneration.current !== generation) return;
      setList(current => appendMailPage(current, page));
    } catch (reason) {
      if (currentScope.current !== scope || listGeneration.current !== initialGeneration || moreGeneration.current !== generation) return;
      setMoreError(reason instanceof Error ? reason.message : '이전 메일을 읽지 못했습니다.');
    } finally {
      if (currentScope.current === scope && listGeneration.current === initialGeneration && moreGeneration.current === generation) setLoadingMore(false);
    }
  };

  const account = accounts?.find(item => item.connectionId === accountId) ?? null;
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
    return <>
      <EmptyState className="mail mail--single" icon={<MailX aria-hidden="true"/>} title="메일 계정 없음"
        action={<Button type="button" onClick={() => setAdding(true)}>메일 계정 연결</Button>}/>
      {adding && <ConnectionDialog existing={null} initialKind="mail" onClose={() => setAdding(false)}
        onSave={async command => { await client.send(command); setAdding(false); void reloadAccounts(true); }}/>}
    </>;
  }

  const switchAccount = (id: string) => { resetScope(); setMailboxPath(''); setAccountId(id); };
  const switchMailbox = (path: string) => { resetScope(); setMailboxPath(path); };
  const compactBack = compact
    ? <Button variant="ghost" size="sm" onClick={closeOpen}>목록으로</Button>
    : null;

  // The third pane: the open message, its failure, its loading state, or the quiet hint.
  let reader: ReactNode;
  if (openMessage) {
    reader = <MailReader key={`${accountId}:${mailboxPath}:${openUid}:${activeOpen.current?.generation}`} connectionId={accountId} mailboxPath={mailboxPath} mailboxes={mailboxes}
      message={openMessage} busy={busy} actionError={actionError} onAction={action => void runAction(openMessage, action)}
      onBack={compact ? closeOpen : undefined}/>;
  } else if (openUid !== null && messageError) {
    reader = <div className="mail-reader mail-reader--empty">{compactBack}<InlineError>{messageError}</InlineError></div>;
  } else if (openUid !== null) {
    reader = <div className="mail-reader mail-reader--empty">{compactBack}
      <div className="grid w-full max-w-md gap-2 px-6" aria-busy="true">
        <Skeleton className="h-6 w-2/3"/><Skeleton className="h-4 w-1/3"/><Skeleton className="h-48 w-full"/>
      </div>
    </div>;
  } else {
    reader = compact ? null
      : <div className="mail-reader mail-reader--empty"><p className="m-0 text-ui text-ink-3">메일을 선택해 주세요</p></div>;
  }

  // Stacked layout: an open message takes the whole sheet; the panes stay out of the tree.
  const stacked = compact && openUid !== null;
  return <div className="mail">
    {stacked ? reader : <>
      <nav className="mail-nav" aria-label="메일함">
      {accounts.length > 1 && <select className="mail-switch" value={accountId} aria-label="메일 계정"
        onChange={event => switchAccount(event.target.value)}>
        {accounts.map(item => <option key={item.connectionId} value={item.connectionId}>{item.name || item.address}</option>)}
      </select>}
      {compact
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
      {!compact && <Button variant="ghost" size="sm" className="mail-nav__write" onClick={() => setCompose({ mode: 'new' })}>
        <MailPlus size={15}/>메일 쓰기</Button>}
    </nav>
    <section className="mail-list" aria-label={`${mailbox ? mailboxLabel(mailbox) : '메일'} 목록`}>
      <div className="mail-list__bar">
        {compact && <Button variant="ghost" size="icon" aria-label="메일 쓰기" onClick={() => setCompose({ mode: 'new' })}>
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
        {phase === 'loading' && <ul className="mail-rows" aria-busy="true">
          {[0, 1, 2, 3, 4].map(row => <li key={row} className="mail-row mail-row--loading">
            <Skeleton className="h-4 w-1/2"/><Skeleton className="h-3 w-3/4"/>
          </li>)}
        </ul>}
        {phase === 'error' && <div className="mail-list__error"><InlineError>{listError}</InlineError></div>}
        {phase === 'ready' && !list.messages.length
          && <div className="calm mail-list__empty"><MailX size={16} aria-hidden="true"/><p>{list.query ? '일치하는 메일 없음' : '메일 없음'}</p></div>}
        {phase === 'ready' && list.messages.length > 0 && <ul className="mail-rows">
          {list.messages.map(message => <li key={message.uid}>
            <button type="button" className="mail-row" data-unread={!message.seen || undefined}
              aria-current={message.uid === openUid || undefined} onClick={() => void open(message)}>
              <span className="mail-row__line">
                <span className="mail-row__from">{mailAddressName(message.from)}</span>
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
        {phase === 'ready' && list.nextBefore !== null && <div className="mail-list__more">
          <Button variant="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? '불러오는 중…' : '이전 메일 더 보기'}</Button>
        </div>}
      </div>
    </section>
    {reader}
    </>}
    {compose && account && <MailCompose connectionId={accountId} canSend={account.canSend} seed={compose}
      onSent={() => { void loadList(); void reloadMailboxes(); }} onClose={() => setCompose(null)}/>}
  </div>;
}
