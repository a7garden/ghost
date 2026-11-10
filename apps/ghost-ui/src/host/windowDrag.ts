/**
 * Title bar presses move the desktop window through the shell's `drag_window` command.
 *
 * The capture listener uses the shell's pointer tracking instead of Tauri's
 * event-based dragging, which macOS rejects after WebKit IPC. Non-interactive
 * descendants inherit their nearest drag region; controls and explicit opt-outs
 * keep their normal pointer handling. Double presses reach Tauri's zoom handling.
 */
export function installWindowDrag(invoke: (command: string) => Promise<unknown>) {
  document.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.detail !== 1) return;
    const target = event.composedPath()[0];
    if (!(target instanceof Element)) return;
    const region = target.closest('[data-tauri-drag-region]');
    if (!region || region.getAttribute('data-tauri-drag-region') === 'false') return;
    if (target.closest('button, a, input, select, textarea, summary, [role="button"], [role="switch"], [tabindex], [contenteditable]:not([contenteditable="false"])')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void invoke('drag_window').catch(() => undefined);
  }, true);
}
