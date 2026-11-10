import type { Check, Work } from "@ghost/contract";
import type { Core } from "./core.ts";
import { sha256 } from "./ids.ts";
import { citationFailures } from "../stores/sources.ts";

/** Recorded result of a `bash` effect. The bash tool must write exactly this JSON. */
export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function parseShellResult(result: string | null): ShellResult | null {
  if (!result) return null;
  try {
    const value = JSON.parse(result) as Partial<ShellResult>;
    if (typeof value.exitCode !== "number" || typeof value.stdout !== "string") return null;
    return { exitCode: value.exitCode, stdout: value.stdout, stderr: typeof value.stderr === "string" ? value.stderr : "" };
  } catch {
    return null;
  }
}

/**
 * Evaluate deterministic checks against independently reopened artifact bytes and
 * recorded shell effects. The model's claims are never consulted.
 */
export async function verifyChecks(core: Core, work: Work, checks: readonly Check[]): Promise<{ pass: boolean; reasons: string }> {
  const artifacts = work.result?.artifacts ?? [];
  const shells = core.ledger
    .effectsForWork(work.id)
    .filter((effect) => effect.tool === "bash" && effect.state === "done")
    .map((effect) => ({ command: effect.summary, result: parseShellResult(effect.result) }));
  const failures: string[] = [];

  for (const check of checks) {
    switch (check.kind) {
      case "artifact_sha256":
      case "artifact_contains": {
        const artifact = artifacts.find((item) => item.name === check.name);
        if (!artifact) {
          const published = core.ledger.artifactsForWork(work.id).some((item) => item.name === check.name);
          failures.push(published
            ? `artifact ${check.name} was published but is missing from the completed result; include its exact name in complete.artifacts`
            : `artifact ${check.name} was not published by this Work; call publish_artifact and include its exact name in complete.artifacts`);
          break;
        }
        const bytes = await core.artifacts.read(artifact.digest);
        if (sha256(bytes) !== artifact.digest) {
          failures.push(`artifact ${check.name} does not match its recorded digest`);
          break;
        }
        if (check.kind === "artifact_sha256" && artifact.digest !== check.sha256) failures.push(`artifact ${check.name} has sha256 ${artifact.digest}, expected ${check.sha256}`);
        if (check.kind === "artifact_contains" && !new TextDecoder().decode(bytes).includes(check.text)) failures.push(`artifact ${check.name} does not contain the expected text`);
        break;
      }
      case "artifact_citations": {
        const artifact = artifacts.find((item) => item.name === check.name);
        if (!artifact) {
          failures.push(`artifact ${check.name} is missing from the completed result; include its exact name in complete.artifacts`);
          break;
        }
        const bytes = await core.artifacts.read(artifact.digest);
        if (sha256(bytes) !== artifact.digest) {
          failures.push(`artifact ${check.name} does not match its recorded digest`);
          break;
        }
        if (!core.sources) {
          failures.push("citation checks need the Host source store, which is not available");
          break;
        }
        for (const problem of citationFailures(core.sources, new TextDecoder().decode(bytes))) failures.push(`artifact ${check.name} ${problem}`);
        break;
      }
      case "command_exit_zero":
      case "command_stdout": {
        const runs = shells.filter((shell) => shell.command === check.command && shell.result !== null);
        const last = runs.at(-1)?.result;
        if (!last) {
          failures.push(`command \`${check.command}\` was not run`);
          break;
        }
        if (last.exitCode !== 0) failures.push(`command \`${check.command}\` exited ${last.exitCode}`);
        else if (check.kind === "command_stdout" && last.stdout.trim() !== check.stdout.trim()) failures.push(`command \`${check.command}\` printed different output`);
        break;
      }
    }
  }
  return failures.length === 0 ? { pass: true, reasons: `${checks.length} check(s) passed.` } : { pass: false, reasons: failures.join("\n") };
}
