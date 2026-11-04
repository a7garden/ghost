#!/usr/bin/env python3
"""Project the Orchestra registry onto Ghost's existing Pi producer transport."""

import json
import subprocess


def main():
    routes = json.loads(subprocess.check_output(
        ["orch", "route", "--json", "--caller", "ghost"], timeout=15
    ))
    if routes["schema_version"] != 1:
        raise ValueError("Unsupported Orchestra route schema")
    native = {}
    for row in routes["routes"]:
        if row["writes"] is not True or row["writer_required"]:
            continue
        if row["backend"] == "codex":
            native[row["task"]] = {"provider": "codex", "model": row["model"], "effort": row["effort"]}
        elif row["backend"] == "omp" and (row["model"] or "").startswith("zai/glm-5.3:"):
            # The registry's tier names the same GLM model supported by
            # Ghost's native Z.AI Responses transport.
            model, effort = row["model"].removeprefix("zai/").split(":", 1)
            native[row["task"]] = {"provider": "zai-coding", "model": model, "effort": effort}
    print(json.dumps(native, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
