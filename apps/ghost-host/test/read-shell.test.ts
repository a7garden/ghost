import { describe, expect, test } from "bun:test";
import { parseReadShell, runReadShell, type InspectOutput } from "../src/tools/read-shell.ts";

const argvOf = (command: string) => parseReadShell(command)?.steps.map((step) => step.argv);

describe("read-only shell lines", () => {
  test("turns ordinary inspection lines into argv", () => {
    expect(argvOf("ls -la /Users/garden/Workspace")).toEqual([["ls", "-la", "/Users/garden/Workspace"]]);
    expect(parseReadShell(`grep -n "prepare\\|RELEASE" 'a b.json'`)).toBeNull(); // backslash needs a shell
    expect(argvOf(`grep -n "prepare|RELEASE" 'a b.json'`)).toEqual([["grep", "-n", "prepare|RELEASE", "a b.json"]]);
    expect(argvOf("ls -la x/ && wc -l y.py")).toEqual([["ls", "-la", "x/"], ["wc", "-l", "y.py"]]);
    expect(argvOf("ls -ld a b 2>/dev/null")).toEqual([["ls", "-ld", "a", "b"]]);
    expect(argvOf("find . -name '*.ts' -type f")).toEqual([["find", ".", "-name", "*.ts", "-type", "f"]]);
    expect(parseReadShell("ls -la snapshots | head -50")?.filter).toEqual({ kind: "head", lines: 50 });
    expect(parseReadShell("git log --oneline | tail -n 5")?.filter).toEqual({ kind: "tail", lines: 5 });
    expect(parseReadShell("cd repo && git status --short | wc -l")?.filter).toEqual({ kind: "count" });
  });

  test("refuses anything a shell would expand, redirect, substitute or background", () => {
    for (const command of [
      "ls *.ts", "ls ~", "ls $HOME", "ls `pwd`", "ls $(pwd)", "ls > out", "cat a >> b", "cat < a", "ls &", "ls || true",
      "ls\nrm x", "echo \"$HOME\"", "ls 'unterminated", "ls -la 2>&1", "ls # comment", "ls {a,b}", "ls ?", "ls [a]", "; ls", "ls ;; ls",
      "cat a | sh", "ls | grep x", "ls | head | head", "ls | head -n x", "ls a; ls b | head -3", "ls | head -99999",
      "cd", "cd a b", "echo -e hi", "ls a | wc -c", "",
    ]) expect(parseReadShell(command)).toBeNull();
  });

  test("a line with too many commands needs approval", () => {
    expect(parseReadShell(Array.from({ length: 9 }, () => "ls").join(" ; "))).toBeNull();
    expect(parseReadShell(Array.from({ length: 8 }, () => "ls").join(" ; "))).not.toBeNull();
  });
});

describe("running a read plan", () => {
  const ok = (output: string, exitCode = 0): InspectOutput => ({ exitCode, output, timedOut: false, truncated: false });

  test("follows && and ; and tracks cd without a shell", async () => {
    const calls: string[] = [];
    const run = async (command: string, answer: (argv: string[]) => InspectOutput | null) =>
      runReadShell(parseReadShell(command)!, "/work", async (argv, cwd) => {
        calls.push(`${cwd}: ${argv.join(" ")}`);
        return answer(argv);
      });
    const result = await run("cd repo && ls a && echo done", () => ok("a-listing\n"));
    expect(result).toEqual({ exitCode: 0, output: "a-listing\ndone\n" });
    expect(calls).toEqual(["/work/repo: ls a"]);

    calls.length = 0;
    const failed = await run("ls x && ls y ; ls z", (argv) => (argv[1] === "x" ? ok("no such file\n", 1) : ok(`${argv[1]}\n`)));
    expect(failed).toEqual({ exitCode: 0, output: "no such file\nz\n" });
    expect(calls).toEqual(["/work: ls x", "/work: ls z"]);
  });

  test("filters apply to the one command's output, and a refusal sends the whole line to approval", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `row ${i}`).join("\n") + "\n";
    const head = await runReadShell(parseReadShell("ls -la big | head -3")!, "/work", async () => ok(lines));
    expect(head).toEqual({ exitCode: 0, output: "row 0\nrow 1\nrow 2\n" });
    const count = await runReadShell(parseReadShell("ls big | wc -l")!, "/work", async () => ok(lines));
    expect(count).toEqual({ exitCode: 0, output: "120\n" });
    expect(await runReadShell(parseReadShell("ls a && rm b")!, "/work", async ([program]) => (program === "ls" ? ok("a\n") : null))).toBeNull();
  });

  test("timeouts and truncation are reported, not hidden", async () => {
    const timedOut = await runReadShell(parseReadShell("find . -name x")!, "/work", async () => ({ exitCode: null, output: "partial\n", timedOut: true, truncated: true }));
    expect(timedOut).toEqual({ exitCode: 124, output: "partial\n\n[output truncated]" });
  });
});
