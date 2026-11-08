import { createContext, useContext, useSyncExternalStore } from 'react';
import { FileText, Hash, MessageCircle } from 'lucide-react';
import type { State } from '@ghost/contract';
import { useOptionalHost } from '../../host/context';
import { DotAvatar } from '../DotAvatar';
import { toneFor } from '../../features/ghostState';
import { sizeLabel } from '../ArtifactPreview';
import { splitRefs, type Ref } from '../refs';
import { Peek, type PeekFact } from './Peek';
import { StateGlyph, glyphLabel, workGlyph } from './StateGlyph';

/** Opens a Work from inside a transcript: the conversation opens its thread panel, elsewhere its page. */
const OpenWork = createContext<(workId: string) => void>(workId => { location.hash = `/work/${encodeURIComponent(workId)}`; });
export const OpenWorkProvider = OpenWork.Provider;
export const useOpenWork = () => useContext(OpenWork);

const noSubscription = () => () => {};

/** The host snapshot when a host is present; static renders resolve nothing and show plain marks. */
export function useHostSnapshot(): State | null {
  const host = useOptionalHost();
  return useSyncExternalStore(host?.store.subscribe ?? noSubscription, () => host?.store.get().state ?? null, () => null);
}

/**
 * An id or digest a Ghost wrote into prose. The person reading needs what it points at, not
 * its characters: a known Work shows its state glyph and opens it, a Ghost its face, a file
 * its icon. The exact value waits behind the mark for whoever needs to copy it.
 */
export function RefMark({ kind, value }: Ref) {
  const state = useHostSnapshot();
  const openWork = useOpenWork();
  // A shortened id resolves only when exactly one entity of any kind starts with it.
  const matching = <T extends { id: string }>(items: T[] | undefined) => kind !== 'id' ? []
    : (items ?? []).filter(item => value.length === 36 ? item.id === value : item.id.startsWith(value));
  const works = matching(state?.works);
  const ghosts = matching(state?.ghosts);
  const conversations = matching(state?.conversations);
  const unique = works.length + ghosts.length + conversations.length === 1;
  const raw: PeekFact = { label: kind === 'id' ? '식별자' : '해시', value: kind === 'id' && value.length < 36 ? `${value}…` : value, copy: true };

  const work = unique ? works[0] : undefined;
  if (work) {
    raw.value = work.id;
    const waiting = state!.decisions.some(decision => decision.state === 'pending' && decision.workId === work.id);
    const glyph = workGlyph(work.state, waiting);
    const assignee = state!.ghosts.find(ghost => ghost.id === work.ghostId)?.name;
    return <Peek title={work.title} facts={[{ label: '상태', value: glyphLabel[glyph] }, ...(assignee ? [{ label: '담당', value: assignee }] : []), raw]}>
      <button type="button" className="ref-mark" data-kind="work" aria-label={`${work.title}, ${glyphLabel[glyph]}`} onClick={() => openWork(work.id)}>
        <StateGlyph state={glyph} size={13}/>
      </button>
    </Peek>;
  }
  const ghost = unique ? ghosts[0] : undefined;
  if (ghost) {
    raw.value = ghost.id;
    return <Peek title={ghost.name} facts={[raw]}>
      <span className="ref-mark" data-kind="ghost" role="img" tabIndex={0} aria-label={ghost.name}>
        <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={15}/>
      </span>
    </Peek>;
  }
  const conversation = unique ? conversations[0] : undefined;
  if (conversation) {
    raw.value = conversation.id;
    const owner = state!.ghosts.find(item => item.id === conversation.ghostId)?.name;
    return <Peek title={conversation.title || (owner ? `${owner}와 대화` : '대화')} facts={[raw]}>
      <span className="ref-mark" data-kind="raw" role="img" tabIndex={0} aria-label="대화"><MessageCircle aria-hidden="true"/></span>
    </Peek>;
  }
  // Ghosts often quote a file by a digest prefix; the file it names is what matters.
  const file = kind === 'digest' ? state?.works.flatMap(item => item.result?.artifacts ?? []).find(artifact => artifact.digest.startsWith(value)) : undefined;
  if (file) {
    return <Peek title={file.name} facts={[{ label: '크기', value: sizeLabel(file.size) }, { ...raw, value: file.digest }]}>
      <span className="ref-mark" data-kind="file" role="img" tabIndex={0} aria-label={file.name}><FileText aria-hidden="true"/></span>
    </Peek>;
  }
  return <Peek facts={[raw]}>
    <span className="ref-mark" data-kind="raw" role="img" tabIndex={0} aria-label={`${raw.label} ${value}`}><Hash aria-hidden="true"/></span>
  </Peek>;
}

/** Plain text with its ids and digests turned into marks. */
export function RefText({ text }: { text: string }) {
  return <>{splitRefs(text).map((piece, index) => typeof piece === 'string' ? piece : <RefMark key={index} {...piece}/>)}</>;
}
