#!/usr/bin/env python3
"""Add verified Linux/arm64 Node and CPython to a NEW read-only OMP runtime.

Run with Python >=3.12 for tarfile's safe extraction filter. Does not change
worker configuration, the base container image, credentials, or old runtimes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import urllib.request

ARTIFACTS = {
    "node": {
        "version": "24.20.0", "os": "linux", "cpu": "arm64", "libc": "glibc",
        "url": "https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-arm64.tar.xz",
        "sha256": "5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7",
        "prefix": "node-v24.20.0-linux-arm64",
    },
    "python": {
        "version": "3.13.16", "os": "linux", "cpu": "arm64", "libc": "glibc",
        "build": "20261013",
        "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.13.16%2B20261013-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
        "sha256": "69a30ed26198178732c37b8de0b6b5191479fbacfe526954da776befe38f18e7",
        "prefix": "python",
        "excluded_data_paths": ["python/share/terminfo"],
    },
}


def verified_download(metadata: dict, cache: Path) -> Path:
    destination = cache / metadata["sha256"]
    if not destination.exists():
        temporary = cache / (metadata["sha256"] + ".partial")
        try:
            with urllib.request.urlopen(metadata["url"], timeout=120) as response, temporary.open("xb") as output:
                shutil.copyfileobj(response, output)
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != metadata["sha256"]:
                raise ValueError("Archive digest mismatch")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    if not destination.is_file() or destination.is_symlink():
        raise ValueError("Cached archive must be a regular file")
    if hashlib.sha256(destination.read_bytes()).hexdigest() != metadata["sha256"]:
        raise ValueError("Cached archive digest mismatch")
    return destination


def prepare(source: Path, destination: Path, cache: Path) -> None:
    if destination.exists() or destination.is_symlink():
        raise ValueError("Destination must be new; an existing runtime is never overwritten.")
    source = source.resolve(strict=True)
    if source.stat().st_mode & 0o222 or not (source / "bun-bin/bun").is_file():
        raise ValueError("Source must be the existing frozen Linux OMP runtime.")
    cache.mkdir(parents=True, exist_ok=True)
    archives = {name: verified_download(value, cache) for name, value in ARTIFACTS.items()}
    with tempfile.TemporaryDirectory(prefix="ghost-languages-", dir=destination.parent) as scratch:
        scratch = Path(scratch)
        new = scratch / "runtime"
        shutil.copytree(source, new, symlinks=True)
        new.chmod(0o700)
        (new / "bun-bin").chmod(0o700)
        for name, archive in archives.items():
            extract = scratch / name
            extract.mkdir()
            with tarfile.open(archive) as tar:
                if any(not (member.name == ARTIFACTS[name]["prefix"] or member.name.startswith(ARTIFACTS[name]["prefix"] + "/")) for member in tar.getmembers()):
                    raise ValueError("Archive has an unexpected root.")
                # Linux terminfo has case-distinct aliases that form cycles
                # on a default macOS volume. Batch Python does not need this
                # optional terminal database; executable/stdlib data stays intact.
                excluded = ARTIFACTS[name].get("excluded_data_paths", [])
                members = [member for member in tar.getmembers() if not any(member.name == p or member.name.startswith(p + "/") for p in excluded)]
                tar.extractall(extract, members=members, filter="data")
            (extract / ARTIFACTS[name]["prefix"]).rename(new / name)
        for name, target in {"node": "../node/bin/node", "npm": "../node/bin/npm", "npx": "../node/bin/npx",
                             "python": "../python/bin/python3.13", "python3": "../python/bin/python3.13"}.items():
            (new / "bun-bin" / name).symlink_to(target)
        for name in ["pip", "pip3"]:
            path = new / "bun-bin" / name
            path.write_text('#!/bin/sh\nexec /runtime/python/bin/python3 -m pip "$@"\n')
            path.chmod(0o555)
        provenance = json.loads((source / "provenance.json").read_text())
        provenance["languages"] = ARTIFACTS
        provenance["scope"] = "Prepared frozen language runtime; actual guest execution requires separate acceptance."
        target = new / "provenance.json"
        target.chmod(0o600)
        target.write_text(json.dumps(provenance, indent=2) + "\n")
        for directory, dirs, files in os.walk(new):
            for name in files:
                path = Path(directory) / name
                if not path.is_symlink():
                    path.chmod(path.stat().st_mode & ~0o222)
            for name in dirs:
                path = Path(directory) / name
                if not path.is_symlink():
                    path.chmod(path.stat().st_mode & ~0o222)
        # macOS needs the directory writable while changing its parent.
        new.chmod(0o700)
        new.rename(destination)
        destination.chmod(0o555)
    print(json.dumps({"prepared": str(destination), "versions": {name: value["version"] for name, value in ARTIFACTS.items()}, "old_runtime_preserved": True}))


if __name__ == "__main__":
    if sys.version_info < (3, 12):
        raise SystemExit("Use Python 3.12+ for safe archive extraction.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.source, args.destination, args.cache)
