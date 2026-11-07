/**
 * Title bar presses move the desktop window through the shell's `drag_window` command.
 *
 * Tauri's own drag-region script calls `start_dragging` asynchronously; on macOS the
 * window refuses to move once the pointer has left the press point. This listener
 * runs first (capture phase) and keeps the same region rule: the pressed element itself
 * carries `data-tauri-drag-region`. Double presses still reach Tauri's zoom handling.
 */
export function installWindowDrag(invoke: (command: string) => Promise<unknown>) {
  document.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.detail !== 1) return;
    const target = event.composedPath()[0];
    if (!(target instanceof HTMLElement)) return;
    const region = target.getAttribute('data-tauri-drag-region');
    if (region === null || region === 'false') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void invoke('drag_window').catch(() => undefined);
  }, true);
}
