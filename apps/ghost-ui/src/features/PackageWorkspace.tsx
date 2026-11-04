import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { protocol, type GhostView } from '../../sdk/src/index';

export const portraitColors = {
  sky: '#d7e9ff', mint: '#d5eee2', lilac: '#e8def9', peach: '#fae0d5', sand: '#f1e5cb', slate: '#e0e6eb',
};
export type PortraitColor = keyof typeof portraitColors;
export type PackageInfo = {
  id: string; version: string; name: string; digest: string;
  ui: { views: GhostView[]; defaultView?: string; portraitBackground?: PortraitColor } | null;
};
export type PackageMap = Record<string, PackageInfo>;
const clientHeader = { 'X-Ghost-Package-Client': '1' };

export function ghostPath(id: string) { return `/ghosts/${encodeURIComponent(id)}`; }
export function viewPath(id: string, view: string) { return `${ghostPath(id)}?view=${encodeURIComponent(view)}`; }

export function usePackages(workspace: string | undefined, profileIds: string[]) {
  const [current, setCurrent] = useState<{ key: string; packages: PackageMap }>();
  const [revision, setRevision] = useState(0);
  const key = new URLSearchParams([['workspace', workspace ?? ''], ...profileIds.map(id => ['profile', id])]).toString();
  useEffect(() => {
    if (!workspace) return;
    const controller = new AbortController();
    fetch(`/ghost-packages/list?${key}`, { headers: clientHeader, signal: controller.signal })
      .then(async res => setCurrent({ key, packages: res.ok ? await res.json() : {} }))
      .catch(() => {});
    return () => controller.abort();
  }, [workspace, key, revision]);
  return { packages: current?.key === key ? current.packages : {}, refresh: () => setRevision(value => value + 1) };
}

export async function uploadPackage(file: File, target?: { workspace: string; profile: string; digest: string }): Promise<PackageInfo> {
  const path = target ? `install?${new URLSearchParams(target)}` : 'inspect';
  const response = await fetch(`/ghost-packages/${path}`, {
    method: 'POST', headers: { ...clientHeader, 'Content-Type': 'application/octet-stream' }, body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '패키지를 읽을 수 없습니다.');
  return result;
}

export function PackageWorkspace({ info, view, onNavigate, onChat }: {
  info: PackageInfo; view: GhostView; onNavigate(viewId: string): void; onChat(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const navigation = useRef(onNavigate);
  navigation.current = onNavigate;
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  useLayoutEffect(() => {
    let port: MessagePort | undefined;
    let expired = false;
    const timer = setTimeout(() => { expired = true; port?.close(); setStatus('failed'); }, 8000);
    const receive = (event: MessageEvent) => {
      if (port || expired || event.origin !== 'null' || event.source !== frame.current?.contentWindow
        || event.data?.protocol !== protocol || event.data.type !== 'hello') return;
      const channel = new MessageChannel();
      port = channel.port1;
      let ready = false;
      port.onmessage = ({ data }: MessageEvent) => {
        if (data?.type === 'ready') { ready = true; clearTimeout(timer); setStatus('ready'); }
        if (ready && data?.type === 'navigate' && info.ui?.views.some(item => item.id === data.viewId)) {
          navigation.current(data.viewId);
        }
      };
      frame.current?.contentWindow?.postMessage({ protocol, type: 'connect', view }, '*', [channel.port2]);
    };
    window.addEventListener('message', receive);
    return () => { clearTimeout(timer); port?.close(); window.removeEventListener('message', receive); };
  }, [info, view]);
  return <section className="package-workspace" aria-label={view.label} aria-busy={status === 'loading'}>
    {status === 'failed' ? <div className="empty-state"><h1>전용 화면을 열 수 없습니다</h1>
      <button className="button secondary" onClick={onChat}>대화로 돌아가기</button></div>
      : <iframe ref={frame} title={view.label} sandbox="allow-scripts" referrerPolicy="no-referrer"
        src={`/ghost-package-assets/${info.digest}/index.html#${view.route}`}/>}
  </section>;
}
