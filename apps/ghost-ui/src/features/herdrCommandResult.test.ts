import { describe, expect, it } from 'vitest';
import { commandResult } from './herdrCommandResult';

const before = ['앞선 대화', '', '╭────────╮', '│ > │', '╰────────╯', ' claude-sonnet · 12%'].join('\n');

describe('slash command results', () => {
  it('keeps only lines that appeared, without the frame or the typed command', () => {
    const after = ['앞선 대화', '/session', 'Session: 01a2', 'Messages: 4', '', '╭────────╮', '│ > │', '╰────────╯', ' claude-sonnet · 12%'].join('\n');
    expect(commandResult(before, after, '/session')).toEqual({ text: 'Session: 01a2\nMessages: 4', interactive: false });
  });

  it('does not take scrolled or unchanged screens for a result', () => {
    expect(commandResult(before, before, '/x')).toEqual({ text: '', interactive: false });
  });

  it('recognises a picker that waits for a choice, so the owner answers in the terminal', () => {
    const after = `${before}\nSelect model\n  1. opus\n  2. sonnet\nEnter to select · Esc to cancel`;
    expect(commandResult(before, after, '/model').interactive).toBe(true);
    expect(commandResult(after, after, '/model').interactive).toBe(false);
  });

  it('bounds a long result to its end', () => {
    const after = `${before}\n${Array.from({ length: 200 }, (_, index) => `줄 ${index}`).join('\n')}`;
    const { text } = commandResult(before, after, '/x');
    expect(text.split('\n')).toHaveLength(60);
    expect(text.endsWith('줄 199')).toBe(true);
  });

  // Captured from omp 19.1.0 and Claude Code 2.1.319 in a scratch herdr session.
  it('reads the omp warning a command printed above an unchanged composer', () => {
    const composer = '\n π > ◒ Sonnet 4.6 > 🗑 work ▶─0.9%──────────┃──────────1M─\n╰─                         ⇧⇥ to change thinking effort';
    expect(commandResult(composer, ` Warning: Nothing to compact (no messages yet)\n${composer}`, '/compact'))
      .toEqual({ text: 'Warning: Nothing to compact (no messages yet)', interactive: false });
  });

  it('ignores a running spinner and treats overlays that wait for a key as the terminal\'s', () => {
    const before = 'prompt';
    expect(commandResult(before, `${before}\n⎋ Working… 3s`, '/x').text).toBe('');
    expect(commandResult(before, `${before}\n⏎/→ models · ↑/↓ providers · type to search · ⌥←/⌥→ kind · ⎋ close`, '/model').interactive).toBe(true);
    expect(commandResult(before, `${before}\nEnter to set as default · s to use this session only · Esc to cancel`, '/model').interactive).toBe(true);
  });
});
