/**
 * Shell lines a Host Work may run without asking: a few simple commands joined by `&&` or `;`, an optional
 * leading `cd DIR`, or one command ending in `| head|tail|wc -l`. This file only turns text into argv and
 * refuses anything a shell would expand, redirect, substitute or background. Whether each command is a
 * read is still decided by the Host inspector's argv grammar, which also keeps private paths out of reach.
 */

export interface ReadStep {
  /** How this step joins the one before it; null for the first. */
  joiner: "&&" | ";" | null;
  argv: string[];
}

export type ReadFilter = { kind: "head" | "tail"; lines: number } | { kind: "count" };

export interface ReadShellPlan {
  steps: ReadStep[];
  filter: ReadFilter | null;
}

/** The inspector's answer for one command; null means it refused and the line needs approval. */
export interface InspectOutput {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

const MAX_STEPS = 8;
const MAX_LINES = 9999;

type Token = { word: string } | { op: "&&" | ";" | "|" };

const isSpace = (char: string) => char === " " || char === "\t";

/** Splits one line into words and operators, or null when the line needs a real shell. */
function tokenize(line: string): Token[] | null {
  const tokens: Token[] = [];
  let word: string | null = null;
  const flush = () => {
    if (word !== null) tokens.push({ word });
    word = null;
  };
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (isSpace(char)) {
      flush();
    } else if (char === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      let end = i + 1;
      while (end < line.length && line[end] !== '"') {
        if (line[end] === "$" || line[end] === "`" || line[end] === "\\") return null;
        end++;
      }
      if (end >= line.length) return null;
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (word === null && line.startsWith("2>/dev/null", i) && (i + 11 === line.length || /[\s;&|]/.test(line[i + 11]!))) {
      // Dropping the discard only means errors stay visible in the output.
      i += 10;
    } else if (char === ";") {
      flush();
      tokens.push({ op: ";" });
    } else if (char === "&") {
      if (line[i + 1] !== "&") return null;
      flush();
      tokens.push({ op: "&&" });
      i++;
    } else if (char === "|") {
      if (line[i + 1] === "|") return null;
      flush();
      tokens.push({ op: "|" });
    } else if (/[\\$`(){}<>*?[\]~!#\r\n\0]/.test(char)) {
      return null;
    } else {
      word = (word ?? "") + char;
    }
  }
  flush();
  return tokens;
}

const lineCount = (arg: string | undefined) => (arg !== undefined && /^\d{1,4}$/.test(arg) && Number(arg) <= MAX_LINES ? Number(arg) : null);

function filterOf(argv: string[]): ReadFilter | null {
  const [program, ...args] = argv;
  if (program === "wc") return args.length === 1 && args[0] === "-l" ? { kind: "count" } : null;
  if (program !== "head" && program !== "tail") return null;
  const lines = args.length === 1 && /^-\d+$/.test(args[0]!) ? lineCount(args[0]!.slice(1)) : args.length === 2 && args[0] === "-n" ? lineCount(args[1]) : null;
  return lines === null ? null : { kind: program, lines };
}

export function parseReadShell(command: string): ReadShellPlan | null {
  const tokens = tokenize(command);
  if (!tokens?.length) return null;
  const groups: { joiner: ReadStep["joiner"]; argv: string[] }[] = [{ joiner: null, argv: [] }];
  let piped = false;
  for (const token of tokens) {
    if ("word" in token) {
      groups.at(-1)!.argv.push(token.word);
    } else {
      if (!groups.at(-1)!.argv.length) return null;
      if (token.op === "|") {
        if (piped) return null;
        piped = true;
        groups.push({ joiner: null, argv: [] });
      } else {
        if (piped) return null;
        groups.push({ joiner: token.op, argv: [] });
      }
    }
  }
  if (!groups.at(-1)!.argv.length) return null;
  let filter: ReadFilter | null = null;
  if (piped) {
    filter = filterOf(groups.pop()!.argv);
    if (!filter) return null;
    // A filter applies to one command; a leading cd is the only thing allowed before it.
    if (groups.filter((group) => group.argv[0] !== "cd").length !== 1) return null;
  }
  if (groups.length > MAX_STEPS) return null;
  const steps = groups.map(({ joiner, argv }): ReadStep => ({ joiner, argv }));
  for (const step of steps) {
    if (step.argv[0] === "cd" && step.argv.length !== 2) return null;
    if (step.argv[0] === "echo" && step.argv.slice(1).some((arg) => arg.startsWith("-"))) return null;
  }
  return { steps, filter };
}

/** Joins `dir` onto `cwd` the way `cd` would, without touching the filesystem. */
const cdTarget = (cwd: string, dir: string) => (dir.startsWith("/") ? dir : `${cwd.replace(/\/$/, "")}/${dir}`);

function filtered(output: string, filter: ReadFilter): string {
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (filter.kind === "count") return `${lines.length}\n`;
  const kept = filter.kind === "head" ? lines.slice(0, filter.lines) : lines.slice(-filter.lines);
  return kept.length ? `${kept.join("\n")}\n` : "";
}

/**
 * Runs the plan with shell semantics for `&&` and `;`. Null as soon as the inspector refuses any command:
 * everything run so far was a read, so the caller can fall back to the ordinary approval path.
 */
export async function runReadShell(
  plan: ReadShellPlan,
  cwd: string,
  inspect: (argv: string[], cwd: string) => Promise<InspectOutput | null>,
): Promise<{ exitCode: number; output: string } | null> {
  let dir = cwd;
  let output = "";
  let exitCode = 0;
  let truncated = false;
  for (const step of plan.steps) {
    if (step.joiner === "&&" && exitCode !== 0) continue;
    const [program, ...args] = step.argv;
    if (program === "cd") {
      dir = cdTarget(dir, args[0]!);
      exitCode = 0;
    } else if (program === "echo") {
      output += `${args.join(" ")}\n`;
      exitCode = 0;
    } else {
      const result = await inspect(step.argv, dir);
      if (!result) return null;
      output += result.output;
      truncated ||= result.truncated;
      exitCode = result.exitCode ?? 124;
    }
  }
  if (plan.filter) {
    output = filtered(output, plan.filter);
    exitCode = 0;
  }
  return { exitCode, output: truncated ? `${output}\n[output truncated]` : output };
}
