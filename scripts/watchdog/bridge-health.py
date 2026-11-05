#!/usr/bin/python3
"""Semantic bridge probe; never print credentials or terminal/workspace content.
Exit 0: usable tree; 1: bridge transport wedged/down; 2: upstream/auth/config failure.
The existing watchdog's eight-second HTTP timeout and two-failure policy are unchanged.

D84: a /cmux/tree that does not answer in 8 s is NOT proof the bridge is wedged. The tree route
fans out to the cmux CLI (tree, then list-status per workspace, then list-notifications), and
under an Xcode build cmux.app answers slowly enough to blow the 8 s budget while the bridge's
event loop is fine. Kickstarting the bridge then kills every open stream for nothing. So on a
tree timeout/refusal the probe asks the bridge's own /healthz (no cmux call): it answers 200 ->
exit 2 `cmux_upstream_slow` (logged, no restart); it does not -> exit 1, as before.
"""
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request


def load_env(path):
    values = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        match = re.match(r'^([\w.-]+)\s*=\s*(.*)$', line)
        if not match:
            continue
        value = match[2].strip()
        if len(value) >= 2 and value[0] in '\"\'' and value[-1] == value[0]:
            value = value[1:-1]
        values[match[1]] = value
    return values


TREE_TIMEOUT_S = 8      # the watchdog's existing per-probe budget (unchanged)
HEALTHZ_TIMEOUT_S = 3   # D84 liveness fallback: /healthz never touches cmux, 3 s is generous


def alive(base, opener=urllib.request.urlopen):
    try:
        with opener(urllib.request.Request(base + '/healthz'), timeout=HEALTHZ_TIMEOUT_S) as response:
            return response.status == 200
    except Exception:
        return False


def probe(url, secret, opener=urllib.request.urlopen, base=None):
    request = urllib.request.Request(url, headers={'x-bridge-secret': secret})
    try:
        with opener(request, timeout=TREE_TIMEOUT_S) as response:
            payload = json.load(response)
            if response.status != 200:
                return 1, 'bridge_http_failure'
    except urllib.error.HTTPError as error:
        return (2, 'bridge_auth_failure') if error.code in (401, 403) else (1, 'bridge_http_failure')
    except (urllib.error.URLError, TimeoutError, OSError):
        if base and alive(base, opener):
            return 2, 'cmux_upstream_slow'
        return 1, 'bridge_unreachable'
    except (ValueError, TypeError):
        return 2, 'bridge_invalid_payload'
    if not isinstance(payload, dict) or payload.get('error'):
        return 2, 'cmux_upstream_failure'
    if not isinstance(payload.get('workspaces'), list) or not payload['workspaces']:
        return 2, 'cmux_no_workspaces'
    return 0, 'bridge_functional_ok'


def main():
    try:
        support = Path(os.environ.get('CMUX_REMOTE_SUPPORT_DIR')
                       or Path.home() / 'Library/Application Support/cmux-remote')
        base = os.environ.get('CMUX_BRIDGE_PROBE_BASE') or 'http://127.0.0.1:8799'
        release = Path((support / 'CURRENT_RELEASE').read_text().strip())
        env = load_env(release / '.env')
        secret = env.get('BRIDGE_SECRET', '')
        if not secret:
            return 2, 'bridge_probe_missing_secret'
        return probe(base + '/cmux/tree', secret, base=base)
    except Exception:
        return 2, 'bridge_probe_config_failure'


if __name__ == '__main__':
    code, reason = main()
    print(reason)
    sys.exit(code)
