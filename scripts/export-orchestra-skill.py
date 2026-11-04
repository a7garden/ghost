#!/usr/bin/env python3
"""Render selected agent-orchestra guidance for Ghost's existing skill store."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

MAX_SKILL_BYTES = 32 * 1024
CORE = "references/shared-defaults.md"
WORKER = "references/worker-contract.md"

GHOST_ADAPTER = """# Agent Orchestra in Ghost

This skill applies to the exact Work in which the Host supplied it. The Owner's
request, project instructions and Ghost Host grants govern the Work. Apply the
source guidance below through these Ghost controls.

- Use the current Goal and Work as the work identity. Inspect the admitted scope
  and acceptance conditions before acting. Use Host-staged project instructions
  and input evidence where available. Ask the accountable Ghost when a required
  source, decision or capability is missing.
- For a root Work, keep responsibility for scope, progress, integration, checks
  and the final report. Prefer doing small contextual work directly. For a
  bounded delegation, use the registered Ghosts and Host-issued contracts.
  Give the assignee owned and protected scope, inputs, acceptance checks and a
  stopping condition. Keep one writer per scope. For a free-form leaf Work,
  set `acceptance_spec.delegation_allowed` to `false` when delegating it. For a
  sealed contract, use the exact approved reference. A worker carrying this
  brief does not delegate further. Wait only for actual dependencies and
  inspect the exact child evidence before using its output.
- Use the tools granted to this Work. Treat references to host CLIs, model
  dispatch, GUI tools, install commands or publication as capability
  requirements. A route preview does not authorize or run a provider. Use
  Ghost's scoped tools and preserve the original disclosure and approvals.
- Run real checks when granted. Report producer checks, Host verification and
  independent review separately. For a review requiring a different vendor,
  require evidence of the actual writer and reviewer; a distinct Ghost name
  alone does not establish independence. Report unavailable checks as open.
- Recover the original Work, attempt or receipt when the outcome is uncertain.
  Preserve the Host's cancellation and revision fences. Publish the authorized
  artifact through Ghost and give the accountable Ghost a short report with
  what changed, observed checks, evidence references and remaining work.

The following source excerpts supply behavior and acceptance guidance. Their
references to external skills or CLI actions are interpreted within the Ghost
adapter above. A selected flow does not grant access or deploy a tool.
"""


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_reference(skill_dir, path):
    path = Path(path).resolve(strict=True)
    relative = path.relative_to(skill_dir)
    if path.suffix != ".md" or not path.is_file():
        raise ValueError(f"expected a Markdown workflow reference: {relative}")
    with path.open("rb") as source:
        data = source.read(MAX_SKILL_BYTES + 1)
    if not data or len(data) > MAX_SKILL_BYTES:
        raise ValueError(f"invalid workflow reference size: {relative}")
    return relative.as_posix(), data


def context(command):
    output = subprocess.run(command, check=True, stdout=subprocess.PIPE, timeout=15).stdout
    data = json.loads(output)
    if data["schema_version"] != 1 or data["caller"] != "ghost":
        raise ValueError("unsupported Orchestra context response")
    workflow = data["workflow"]
    for name in ("fingerprint", "selection_fingerprint"):
        if not re.fullmatch("[a-f0-9]{64}", workflow[name]):
            raise ValueError(f"invalid Orchestra {name}")
    return workflow, data["flows"]


def export(orchestra_root, project, flows):
    skill_dir = (orchestra_root / "skill/agent-orchestra").resolve(strict=True)
    dispatcher = (skill_dir / "scripts/orch").resolve(strict=True)
    dispatcher.relative_to(skill_dir)
    command = [
        sys.executable, str(dispatcher), "--cwd", str(project),
        "context", "--caller", "ghost", "--json",
    ]
    for flow in flows:
        command.extend(("--flow", flow))
    workflow, selected = context(command)
    core_path, core_bytes = read_reference(skill_dir, workflow["contract"])
    if core_path != CORE:
        raise ValueError("unexpected Orchestra common contract path")
    worker_path, worker_bytes = read_reference(skill_dir, skill_dir / WORKER)
    if worker_path != WORKER:
        raise ValueError("unexpected Orchestra worker contract path")
    sections = [(core_path, core_bytes), (worker_path, worker_bytes)]
    for flow in selected:
        if flow["present"] is not True:
            raise ValueError(f"Orchestra flow is unavailable: {flow['id']}")
        name, data = read_reference(skill_dir, flow["reference"])
        if sha256(data) != flow["sha256"]:
            raise ValueError(f"Orchestra flow changed during export: {flow['id']}")
        if name != CORE:
            sections.append((name, data))
        elif data != core_bytes:
            raise ValueError("Orchestra common contract changed during export")
    if (workflow, selected) != context(command) or (
        (worker_path, worker_bytes) != read_reference(skill_dir, skill_dir / WORKER)
    ):
        raise ValueError("Orchestra workflow changed during export; rerun after it settles")

    lines = [
        "---", "name: agent-orchestra",
        "description: Apply the maintained Orchestra workflow within an authorized Ghost Work.",
        "privacy: local_only", "---", "",
        GHOST_ADAPTER.rstrip(), "", "## Source version", "",
        f"- Workflow fingerprint: `{workflow['fingerprint']}`",
        f"- Flow selection fingerprint: `{workflow['selection_fingerprint']}`",
        "- Selected flows: " + ", ".join(f"`{flow['id']}`" for flow in selected),
    ]
    for name, data in sections:
        lines.extend(("", f"## Source: `{name}`", "", f"SHA-256: `{sha256(data)}`", ""))
        if name == WORKER:
            lines.extend((
                "Apply this section only in an authenticated delegated child Work.",
                "The root and evaluation roles skip this section and use their Host scope.",
                "Within a child Work, the publication restriction concerns external publication.",
                "Deliver required output with the granted Ghost publish_artifact tool.",
                "",
            ))
        lines.append(data.decode("utf-8"))
    rendered = ("\n".join(lines) + "\n").encode("utf-8")
    if len(rendered) > MAX_SKILL_BYTES:
        raise ValueError("workflow skill exceeds 32 KiB; select fewer flows")
    return rendered


def main():
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--orchestra-root", type=Path, default=project.parent / "agent-orchestra",
                        help="trusted local agent-orchestra checkout")
    parser.add_argument("--flow", action="append", default=[], help="Orchestra flow ID; repeat to combine")
    args = parser.parse_args()
    try:
        skill = export(args.orchestra_root.expanduser(), project, args.flow)
    except (OSError, subprocess.SubprocessError, KeyError, TypeError, ValueError) as error:
        parser.exit(1, f"orchestra skill export: {error}\n")
    sys.stdout.buffer.write(skill)


if __name__ == "__main__":
    main()
