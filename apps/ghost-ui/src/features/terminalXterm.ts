import { Terminal, type ITheme, type ITerminalInitOnlyOptions, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

Terminal.strings.promptLabel = '터미널 입력';
Terminal.strings.tooMuchOutput = '터미널 출력이 너무 많습니다.';

function terminalTheme(node: HTMLElement): ITheme {
  const css = getComputedStyle(node);
  const color = (token: string) => css.getPropertyValue(`--ghost-${token}`).trim();
  const foreground = color('ink');
  return {
    background: color('canvas'), foreground, cursor: foreground, cursorAccent: color('canvas'),
    selectionBackground: `${color('signal')}55`,
    black: color('ansi-black'), brightBlack: color('ansi-gray'), white: color('ansi-white'), brightWhite: color('ansi-bright-white'),
    red: color('danger-ink'), brightRed: color('danger'), yellow: color('amber-ink'), brightYellow: color('amber'),
    green: color('success-ink'), brightGreen: color('success'), blue: color('signal-ink'), brightBlue: color('signal'),
    magenta: color('ansi-magenta'), brightMagenta: color('ansi-magenta'), cyan: color('ansi-cyan'), brightCyan: color('ansi-cyan'),
  };
}

export function openXterm(node: HTMLElement, options: ITerminalOptions & ITerminalInitOnlyOptions, activateLink: (event: MouseEvent, text: string) => void) {
  const terminal = new Terminal({
    fontFamily: getComputedStyle(node).fontFamily, fontSize: 13, lineHeight: 1.25,
    theme: terminalTheme(node), minimumContrastRatio: 4.5, screenReaderMode: true, cursorBlink: false,
    ...options,
    linkHandler: { activate: activateLink },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(node);
  const appearance = new MutationObserver(() => { terminal.options.theme = terminalTheme(node); });
  appearance.observe(document.documentElement, { attributeFilter: ['class'] });
  return { terminal, fit, dispose: () => { appearance.disconnect(); terminal.dispose(); } };
}
