/** What a slash command printed, read from the pane's plain screen text taken before and after it was sent. */
export type CommandResult = { text: string; interactive: boolean };

/** Hints a picker or dialog draws while it waits for a choice; its answer belongs in the terminal. */
const INTERACTIVE = /(?:enter|return)\s+to\s+(?:select|confirm|choose|set)|esc(?:ape)?\s+to\s+(?:cancel|close|go back)|⎋\s*close|[↑↓]\s*\/\s*[↑↓]|use arrow keys/i;

/** A turn or compaction is still running: its screen keeps changing and is not yet a result. */
export const BUSY = /working…|esc to interrupt/i;
const MAX_LINES = 60;
const MAX_CHARS = 6000;

/** Only the box-drawing frame of the terminal UI, or blank. */
const chrome = (line: string) => /^[\s\u2500-\u257f\u2580-\u259f│|+\-_=~]*$/.test(line) || BUSY.test(line);

/**
 * Lines on screen now that were not on screen before, in order, without frame lines and without the typed command itself.
 * A line that merely moved keeps its text and is not new, so scrolling output is not mistaken for a result.
 */
export function commandResult(before: string, after: string, command: string): CommandResult {
  const seen = new Map<string, number>();
  for (const raw of before.split('\n')) {
    const line = raw.trim();
    seen.set(line, (seen.get(line) ?? 0) + 1);
  }
  const typed = command.trim();
  const fresh: string[] = [];
  for (const raw of after.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const key = line.trim();
    const count = seen.get(key) ?? 0;
    if (count > 0) { seen.set(key, count - 1); continue; }
    if (!key || chrome(line) || key === typed || key === `> ${typed}` || key === `❯ ${typed}`) continue;
    fresh.push(line);
  }
  const text = fresh.slice(-MAX_LINES).join('\n').slice(-MAX_CHARS).trim();
  return { text, interactive: INTERACTIVE.test(after) && !INTERACTIVE.test(before) };
}
