import type { HerdrAsk, HerdrChoiceTone, HerdrOutput } from "@ghost/contract";

const CURSOR = /^[❯›❱▶>\uf054]\s*/u;
const NUMBERED = /^(\d{1,2})[.)]\s+(.+)$/;
const BULLET = /^[-*•◦○]\s+(.+)$/u;
const DECORATION = /^[\s─━═┄┈╌╴│┃║╭╮╰╯├┤┬┴┼┌┐└┘]+$/u;
const BOX_TITLE = /^[╭┌][─━═]+\s+(.+?)\s+[─━═]+[╮┐]$/u;
const CONTEXT = /^(?:\$\s+|(?:command|path|file|directory)\s*:\s*|(?:[~/]|\.\.?\/)[^\s])/i;
const TOOL_HEADING = /^(?:(?:bash|shell|terminal) command|(?:edit|write|create|delete|read) file)$/i;
const QUESTION = /\?$|^(?:do you |would you |may I |choose one\b|select one\b|pick one\b|(?:select|choose|pick) (?:an|a) (?:option|choice)\b|allow tool:|.+ needs your permission\b)/i;
const APPROVAL = /\b(?:allow|approve|approval|permission|proceed|confirm|grant|trust|run this|make this|execute|apply these|implement this plan)\b/i;
const FORM = /\b(?:select (?:all|multiple|up to|at least|one or more)|choose (?:all|multiple|up to|at least|one or more)|multi[ -]?select|multiple answers|space to (?:toggle|check|mark)|tab\/arrow keys|question\s+\d+\s*(?:of|\/)\s*\d+|\d+\s+of\s+\d+\s+questions|type (?:your|an|something)|enter (?:your|an) answer|free[- ]text)\b|[☑☐☒]/i;
const TEXT_CHOICE = /^(?:other\b|none of the above\b|chat about this\b|type\b|(?:provide|write|enter) (?:your|an)\b|submit\b|next\b)|^\[(?: |[xX✓])\]|[✓✔]$/iu;
const HINT = /^(?:(?:enter|return|esc(?:ape)?|tab|shift\+tab|ctrl\+[a-z]|↑\/↓|←\/→|arrow keys|[\p{Co}\s/QO]+)\s+(?:to\s+)?(?:select|confirm|choose|navigate|move|cancel|close|back|edit|amend|approve|deny|details)|press (?:enter|return) to (?:select|confirm)(?: or esc(?:ape)? to (?:cancel|go back))?|press esc(?:ape)? to cancel|type to deny and steer)$/iu;
const OMP_STATUS = /^[\u2800-\u28ff]\s+(?:\d+[hms]\s*)+·\s*\p{Co}.*\s·\s\p{Co}.*\s·\s\p{Co}/u;
const YES_NO = /^(.*?)(?:\[([yn])\s*\/\s*([yn])\]|\(([yn])\s*\/\s*([yn])\)|\b([yn])\s*\/\s*([yn]))\s*[:?]?$/i;

export function choiceTone(label: string): HerdrChoiceTone {
  const value = label.trim().replaceAll("’", "'").toLowerCase();
  if (/^(?:no|deny|reject|cancel|exit|decline|never|stop|skip|back|abort|refuse|not now|do not (?:allow|approve|run|proceed)|don't (?:allow|approve|run|proceed))\b/.test(value)) return "deny";
  if (/\b(?:always|trust|don'?t ask(?: again)?|do not ask again|for (?:this|the) session|allow all|remember (?:this|my) choice|allow future|automatically allow)\b/.test(value)) return "trust";
  if (/^(?:yes|allow|proceed|run|approve|accept|continue|confirm)\b/.test(value)) return "approve";
  return "neutral";
}

type Row = { raw: string; text: string };
type Option = { label: string; selected: boolean; number: number | null; style: "number" | "bullet" | "omp" };

function footer(line: string, omp: boolean): boolean {
  return (omp && OMP_STATUS.test(line)) || line.split(/\s+[·•·]\s+/u).every((hint) => HINT.test(hint));
}

function option(row: Row, agent: string): Option | null {
  const cursor = row.text.match(CURSOR);
  const body = cursor ? row.text.slice(cursor[0].length) : row.text;
  const numbered = body.match(NUMBERED);
  if (numbered) return { label: (agent === "codex" ? numbered[2]!.split(/\s{2,}/, 1)[0]! : numbered[2]!), selected: cursor !== null, number: Number(numbered[1]), style: "number" };
  const bullet = body.match(BULLET);
  if (bullet) return { label: bullet[1]!, selected: cursor !== null, number: null, style: "bullet" };
  if (agent === "omp" && body && (/^[│┃║]\s{3}\S/u.test(row.raw) || (cursor !== null && row.raw.startsWith("│")))) {
    return { label: body, selected: cursor !== null, number: null, style: "omp" };
  }
  // Some bullet menus use the cursor in place of the selected row's bullet.
  return cursor && body ? { label: body, selected: true, number: null, style: "bullet" } : null;
}

type Ask = { view: HerdrAsk; keys(index: number): string[] };

/** Start at the final rendered row, never search past newer output for a menu in scrollback. */
export function detectHerdrAsk(output: HerdrOutput): Ask | null {
  const { pane, text } = output;
  if (pane.status !== "blocked" || pane.agent === null) return null;
  return detectTerminalAsk(text, { id: pane.id, agent: pane.agent });
}

/** Shared by herdr and Host PTYs after each has obtained the visible terminal screen. */
export function detectTerminalAsk(text: string, pane: { id: string; agent: string }): Ask | null {
  const omp = pane.agent === "omp";
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    const raw = line.trim();
    if (!raw || DECORATION.test(raw)) continue;
    rows.push({ raw, text: raw.replace(/^[│┃║]\s?/u, "").replace(/\s*[│┃║]$/u, "").trim() });
  }
  let end = rows.length - 1;
  while (end >= 0 && footer(rows[end]!.text, omp)) end--;
  const last = rows[end];
  if (!last) return null;

  const binary = last.text.match(YES_NO);
  if (binary && !FORM.test(last.text)) {
    const title = binary[1]!.trimEnd() || rows[end - 1]?.text;
    const first = binary[2] ?? binary[4] ?? binary[6]!;
    const second = binary[3] ?? binary[5] ?? binary[7]!;
    if (!title || (!QUESTION.test(title) && !/^(?:continue|proceed|confirm|approve|retry)[: ]*$/i.test(title)) ||
      FORM.test(title) || first.toLowerCase() === second.toLowerCase()) return null;
    const choices = [first, second].map((letter, index) => letter.toLowerCase() === "y"
      ? { index, label: "Yes", tone: "approve" as const }
      : { index, label: "No", tone: "deny" as const });
    const selected = second === second.toUpperCase() && first !== first.toUpperCase() ? 1 : 0;
    const above = rows[end - (binary[1]!.trim() ? 1 : 2)]?.text;
    return {
      view: { pane: pane.id, kind: "approval", title, detail: above && CONTEXT.test(above) ? above : null, choices, selected },
      keys: (index) => [[first, second][index]!.toLowerCase(), "enter"],
    };
  }

  const reversed: Option[] = [];
  let top = end;
  for (; top >= 0; top--) {
    const parsed = option(rows[top]!, pane.agent);
    if (!parsed) break;
    if (reversed.length === 21 || TEXT_CHOICE.test(parsed.label) || FORM.test(parsed.label)) return null;
    reversed.push(parsed);
  }
  if (reversed.length < 2) return null;
  const options = reversed.reverse();
  const selected = options.findIndex((item) => item.selected);
  if (selected < 0 || options.some((item, i) => (i !== selected && item.selected) || item.style !== options[0]!.style ||
    (item.number !== null && item.number !== i + 1))) return null;

  // The question and optional command/path are adjacent. Unknown rows are not inferred to be titles or continuations.
  let title: string | null = null;
  let detail: string | null = null;
  for (; top >= 0; top--) {
    const row = rows[top]!;
    const line = row.raw.match(BOX_TITLE)?.[1] ?? row.text;
    if (FORM.test(line)) return null;
    if (CONTEXT.test(line)) { detail ??= line; continue; }
    if (TOOL_HEADING.test(line)) continue;
    if (QUESTION.test(line)) title = line;
    break;
  }
  if (!title) return null;
  const before = rows[top - 1]?.text;
  if (before && FORM.test(before)) return null;
  if (before && detail === null && CONTEXT.test(before)) detail = before;
  if (detail === null && pane.agent === "claude") {
    detail = title.match(/\b(?:create|edit|write|read|delete)\s+((?:[~/.][^\s?]+|[^\s?]+\.[A-Za-z0-9]+))\?$/i)?.[1] ?? null;
  }
  const choices = options.map(({ label }, index) => ({ index, label, tone: choiceTone(label) }));
  const kind = APPROVAL.test(title) || (choices.some((choice) => choice.tone === "deny") &&
    choices.some((choice) => choice.tone === "approve" || choice.tone === "trust")) ? "approval" : "question";
  return {
    view: { pane: pane.id, kind, title, detail, choices, selected },
    keys: (index) => [...Array<string>(Math.abs(index - selected)).fill(index > selected ? "down" : "up"), "enter"],
  };
}
