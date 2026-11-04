export const protocol = 'ghost-ui-sdk/1';

export type GhostView = Readonly<{ id: string; label: string; route: string }>;
export type GhostUI = Readonly<{
  view: GhostView;
  navigate(viewId: string): void;
}>;

let connection: Promise<GhostUI> | undefined;

/** Connect once at workspace startup. Navigation is scoped to declared views. */
export function connectGhostUI(): Promise<GhostUI> {
  return connection ??= new Promise((resolve, reject) => {
    if (parent === window) { reject(new Error('Open this workspace inside Ghost.')); return; }
    const handle = (event: MessageEvent) => {
      if (event.source !== parent || event.data?.protocol !== protocol || event.data.type !== 'connect'
        || typeof event.data.view?.id !== 'string' || event.ports.length !== 1) return;
      cleanup();
      const port = event.ports[0];
      port.postMessage({ type: 'ready' });
      resolve(Object.freeze({
        view: Object.freeze({ ...event.data.view }),
        navigate(viewId: string) { port.postMessage({ type: 'navigate', viewId }); },
      }));
    };
    const cleanup = () => { window.removeEventListener('message', handle); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Ghost workspace connection timed out.')); }, 8000);
    window.addEventListener('message', handle);
    parent.postMessage({ protocol, type: 'hello' }, '*');
  });
}
