#!/usr/bin/env python3
"""Render owner-only launchd plists for review. Does not install or load them."""
import argparse
import os
from pathlib import Path
import plistlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True, type=Path)
parser.add_argument('--binary', required=True, type=Path)
parser.add_argument('--node', required=True, type=Path)
parser.add_argument('--state', required=True, type=Path)
parser.add_argument('--devices', required=True, type=Path)
parser.add_argument('--origin', required=True)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
from urllib.parse import urlsplit
origin = urlsplit(args.origin)
if origin.scheme != 'https' or not origin.netloc or origin.username or origin.password or origin.path not in ('', '/') or origin.query or origin.fragment:
    parser.error('--origin must be an HTTPS origin')
for name in ('source', 'binary', 'node', 'state', 'devices', 'output'):
    if not getattr(args, name).is_absolute():
        parser.error(f'--{name} must be absolute')
args.output.mkdir(parents=True, exist_ok=True)
definitions = {
    'io.a7garden.ghost.host': {
        'ProgramArguments': [str(args.binary), '--root', str(args.state), 'serve', '--headless'],
    },
    'io.a7garden.ghost.gateway': {
        'ProgramArguments': [str(args.node), str(args.source / 'apps/ghost-gateway/server.mjs')],
        'EnvironmentVariables': {
            'GHOST_ROOT': str(args.state), 'GHOST_GATEWAY_DEVICES': str(args.devices),
            'GHOST_GATEWAY_ORIGIN': args.origin.rstrip('/'), 'GHOST_GATEWAY_PORT': '8788',
        },
    },
}
for label, definition in definitions.items():
    path = args.output / f'{label}.plist'
    # Exclusive creation avoids overwriting an operator's reviewed configuration.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        plistlib.dump({
            'Label': label, 'WorkingDirectory': str(args.source),
            'RunAtLoad': True, 'KeepAlive': {'SuccessfulExit': False},
            'ThrottleInterval': 5, 'ExitTimeOut': 90, 'Umask': 0o077,
            **definition,
        }, stream)
    print(path)
