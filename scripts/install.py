#!/usr/bin/env python3
"""Build and atomically install a versioned local Ghost binary; never start it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true",
                        help="Install the existing target/release/ghost artifact")
    parser.add_argument("--offline", action="store_true", help="Build using cached dependencies")
    parser.add_argument("--features", default="",
                        help="Comma-separated Cargo features to include in the installed binary")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--target-dir", type=Path,
                        help="Cargo target directory (defaults to the repository target directory)")
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    target_dir = (args.target_dir or source / "target").expanduser().resolve()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    if not args.skip_build:
        command = ["cargo", "build", "--release", "--locked", "--jobs", str(args.jobs),
                   "--target-dir", str(target_dir)]
        if args.offline:
            command.append("--offline")
        if args.features:
            command.extend(["--features", args.features])
        subprocess.run(command, cwd=source, check=True)
    binary = target_dir / "release/ghost"
    if not binary.is_file():
        raise RuntimeError("release artifact missing; build it before --skip-build")
    home = Path.home()
    releases = home / ".local/share/ghost/releases"
    bin_dir = home / ".local/bin"
    releases.mkdir(parents=True, exist_ok=True)
    bin_dir.mkdir(parents=True, exist_ok=True)
    entry = bin_dir / "ghost"
    previous = os.readlink(entry) if entry.is_symlink() else None
    if entry.exists() and not entry.is_symlink():
        raise RuntimeError("refusing to replace an unmanaged ghost file; move it explicitly first")
    if previous is not None:
        old_target = Path(previous)
        if not old_target.is_absolute():
            old_target = entry.parent / old_target
        if not old_target.resolve().is_relative_to(releases.resolve()):
            raise RuntimeError("refusing to replace an unmanaged ghost symlink")
    digest = sha256(binary)
    release = releases / digest[:16]
    if not release.exists():
        staging = Path(tempfile.mkdtemp(prefix=".install-", dir=releases))
        try:
            shutil.copy2(binary, staging / "ghost")
            (staging / "ghost").chmod(0o755)
            if sha256(staging / "ghost") != digest:
                raise RuntimeError("artifact changed during installation; rebuild and retry")
            manifest = {
                "schema": "ghost-local-install/1",
                "installed_at": datetime.now(timezone.utc).isoformat(),
                "binary_sha256": digest,
                "source_directory": str(source),
                "cargo_lock_sha256": sha256(source / "Cargo.lock"),
                "features": args.features or "default host (headless)" if not args.skip_build else "existing artifact; features not attested",
                "previous_entry_target": previous,
                "started": False,
                "source_commit": None,
            }
            (staging / "install.json").write_text(json.dumps(manifest, indent=2) + "\n")
            for name in ("ghost", "install.json"):
                with (staging / name).open("rb") as stream:
                    os.fsync(stream.fileno())
            staging.rename(release)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    elif sha256(release / "ghost") != digest:
        raise RuntimeError("existing release digest mismatch; refusing to use it")
    temporary = bin_dir / (".ghost-install-" + os.urandom(8).hex())
    try:
        temporary.symlink_to(release / "ghost")
        os.replace(temporary, entry)
    finally:
        if temporary.is_symlink():
            temporary.unlink()
    print(json.dumps({"installed": str(entry), "release": str(release),
                      "binary_sha256": digest, "previous_target": previous,
                      "started": False}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
