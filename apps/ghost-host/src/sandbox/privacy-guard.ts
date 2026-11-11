import { basename, isAbsolute, join, normalize } from "node:path";

/**
 * Home folders macOS privacy (TCC) guards. Touching one from the Host or a command it starts asks the
 * owner at the Mac and waits, unattended, until someone answers.
 */
export const PRIVACY_GUARDED_HOME = ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music"];
/** Library stores macOS guards as protected data or another app's data. */
const PRIVACY_GUARDED_LIBRARY = [
  "Mail", "Messages", "Safari", "Mobile Documents", "CloudStorage", "Calendars", "Reminders", "HomeKit",
  "Containers", "Group Containers", "Suggestions", "IdentityServices", "Metadata/CoreSpotlight",
  "Application Support/AddressBook", "Application Support/CallHistoryDB", "Application Support/com.apple.TCC",
];
const table = (...names: string[]): Record<string, true> => Object.fromEntries(names.map((name) => [name, true]));
/** Programs that walk a directory tree. */
const SCANNERS = table("find", "gfind", "du", "tree", "fd", "fdfind", "rg", "ag", "ack", "ditto", "tar");
/** Programs that walk a tree only with a recursive flag, and that flag. */
const RECURSIVE_FLAG: Record<string, RegExp> = {
  grep: /^-[A-Za-z]*[rR]/, egrep: /^-[A-Za-z]*[rR]/, fgrep: /^-[A-Za-z]*[rR]/, ggrep: /^-[A-Za-z]*[rR]/,
  ls: /^-[A-Za-z]*R/, zip: /^-[A-Za-z]*r/, cp: /^-[A-Za-z]*[rRa]/, rsync: /^-[A-Za-z]*[rRa]/,
};
/** Scanners whose first operand is a pattern, not a path. */
const PATTERN_FIRST = table("rg", "ag", "ack", "grep", "egrep", "fgrep", "ggrep");
/** Words that run the following word as the command. */
const PREFIXES = table("sudo", "command", "builtin", "exec", "time", "nice", "nohup", "env", "xargs", "caffeinate");

/** Shell words of one command line, split into simple commands at control operators. Quotes are honored, expansions are not. */
function simpleCommands(script: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], word = "", quoted = false, quote: "'" | '"' | null = null;
  const endWord = () => { if (word || quoted) words.push(word); word = ""; quoted = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < script.length) word += script[++i];
      else word += c;
    } else if (c === "'" || c === '"') { quote = c; quoted = true; }
    else if (c === "\\" && i + 1 < script.length) word += script[++i] === "\n" ? "" : script[i];
    else if (c === " " || c === "\t") endWord();
    else if (c === "#" && !word && !quoted) { while (i + 1 < script.length && script[i + 1] !== "\n") i++; }
    else if (c === "$" && script[i + 1] === "{" && script.includes("}", i)) { const end = script.indexOf("}", i); word += script.slice(i, end + 1); i = end; }
    else if ("\n;&|(){}`".includes(c)) endCommand();
    else word += c;
  }
  endCommand();
  return commands;
}

/**
 * Why an unattended shell command must not run, or null. It refuses commands that name a privacy-guarded
 * location or walk a tree containing them (`/`, `/Users`, home, `~/Library`), so they fail at once instead
 * of hanging on a macOS consent prompt. Lexical by design: it reads the command, not the filesystem.
 */
export function privacyGuardedCommand(script: string, options: { home: string; cwd: string }): string | null {
  const home = normalize(options.home);
  const guarded = [
    ...PRIVACY_GUARDED_HOME.map((name) => join(home, name)),
    ...PRIVACY_GUARDED_LIBRARY.map((name) => join(home, "Library", name)),
  ];
  const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  const broad = new Set(["/", "/Users", "/System/Volumes/Data", "/System/Volumes/Data/Users", home, join(home, "Library")]);
  let cwd = normalize(options.cwd);
  // A working directory the owner chose inside a guarded folder is theirs to use; only paths beyond it are refused.
  const chosen = guarded.some((root) => inside(cwd, root)) ? cwd : null;
  const resolvePath = (word: string): string | null => {
    const expanded = word === "~" || word === "$HOME" || word === "${HOME}" ? home
      : /^(?:~|\$HOME|\$\{HOME\})\//.test(word) ? join(home, word.slice(word.indexOf("/") + 1))
        : word;
    if (/[$`*?[]/.test(expanded.replace(/\*+$/, ""))) return null;
    const path = normalize(isAbsolute(expanded) ? expanded : join(cwd, expanded)).replace(/\*+$/, "");
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
  };
  for (const command of simpleCommands(script)) {
    let index = 0, prefixed = false;
    while (index < command.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index]!) || Object.hasOwn(PREFIXES, basename(command[index]!)))) {
      prefixed ||= Object.hasOwn(PREFIXES, basename(command[index]!));
      index++;
    }
    // A prefix's own options (`env -i`, `nice -n 5`) come before the program it runs.
    if (prefixed) {
      const walker = command.findIndex((word, at) => at >= index && (Object.hasOwn(SCANNERS, basename(word)) || Object.hasOwn(RECURSIVE_FLAG, basename(word))));
      if (walker >= 0) index = walker;
    }
    const program = command[index] === undefined ? "" : basename(command[index]!);
    const words = command.slice(index + 1);
    let operands = words.filter((word) => !word.startsWith("-"));
    if (Object.hasOwn(PATTERN_FIRST, program) && !words.some((word) => /^-[ef]$|^--(?:regexp|file|files)(?:=|$)/.test(word))) operands = operands.slice(1);
    const paths = operands.map(resolvePath).filter((path): path is string => path !== null);
    // Every word is checked, so `cat ~/Documents/a` and `VAR=~/Downloads` are refused alike.
    for (const word of command) {
      const path = resolvePath(word.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "").replace(/^--?[A-Za-z][\w-]*=/, ""));
      const hit = path && !(chosen && inside(path, chosen)) && guarded.find((root) => inside(path, root));
      if (hit) return `${hit} is protected by macOS privacy, and an unattended command there waits on a consent prompt at the Mac. Work in project folders such as ~/Workspace/Projects, or ask the owner to move the files there.`;
    }
    const recursive = Object.hasOwn(SCANNERS, program)
      || (Object.hasOwn(RECURSIVE_FLAG, program) && words.some((word) => word === "--recursive" || word === "--archive" || RECURSIVE_FLAG[program]!.test(word)));
    if (recursive) {
      const roots = paths.length ? paths : [cwd];
      const root = roots.find((path) => broad.has(path));
      if (root) return `Scanning ${root} recursively reaches folders protected by macOS privacy, and the command would wait on a consent prompt at the Mac. Search a narrower directory such as ~/Workspace/Projects.`;
    }
    if (program === "cd") {
      const target = words.find((word) => !word.startsWith("-"));
      const next = target === undefined ? home : resolvePath(target);
      if (next) cwd = next;
    }
  }
  return null;
}
