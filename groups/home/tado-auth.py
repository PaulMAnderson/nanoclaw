#!/usr/bin/env python3
"""
Tado OAuth2 Device Code Flow — two-phase auth for NanoClaw containers.

Phase 1 (start):  Request a device code, print the URL for the user, save
                  pending state to .tado-auth-pending.json and exit immediately.
                  The agent sends the URL to the user via WhatsApp.

Phase 2 (complete): Read the saved state, poll once for the token.
                    If the user has authenticated: save refresh token and exit 0.
                    If still pending: exit 2 (agent asks user to try again).
                    If expired: exit 1 (agent restarts from phase 1).

Token file: /workspace/group/.tado-token.json  (same format as libtado)
"""

import sys
import json
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

# New Tado OAuth2 endpoints (post-March 2025)
CLIENT_ID       = "1bb50063-6b0c-4d11-bd99-387f4a91cc46"
DEVICE_AUTH_URL = "https://login.tado.com/oauth2/device_authorize"
TOKEN_URL       = "https://login.tado.com/oauth2/token"

WORKSPACE       = os.environ.get("TADO_WORKSPACE", "/workspace/group")
PENDING_FILE    = os.path.join(WORKSPACE, ".tado-auth-pending.json")
TOKEN_FILE      = os.path.join(WORKSPACE, ".tado-token.json")


def cmd_start():
    """Phase 1: request device code and print the verification URL."""
    resp = requests.post(DEVICE_AUTH_URL, data={"client_id": CLIENT_ID}, timeout=10)
    if not resp.ok:
        print(f"ERROR: device_authorize failed: {resp.status_code} {resp.text}", file=sys.stderr)
        sys.exit(1)

    data = resp.json()
    device_code   = data["device_code"]
    user_code     = data.get("user_code", "")
    interval      = data.get("interval", 5)
    expires_in    = data.get("expires_in", 300)
    # Tado returns verification_uri_complete with user_code embedded
    verify_url    = data.get("verification_uri_complete") or data.get("verification_uri", "https://app.tado.com")
    expires_at    = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat()

    pending = {
        "device_code": device_code,
        "interval":    interval,
        "expires_at":  expires_at,
    }
    Path(PENDING_FILE).write_text(json.dumps(pending))
    os.chmod(PENDING_FILE, 0o600)

    print(f"TADO_AUTH_URL={verify_url}")
    if user_code:
        print(f"TADO_USER_CODE={user_code}")
    print(f"TADO_EXPIRES_IN={expires_in}")


def cmd_complete():
    """Phase 2: poll once (with the saved interval) for the token."""
    if not os.path.exists(PENDING_FILE):
        print("ERROR: no pending auth — run 'tado-auth.py start' first", file=sys.stderr)
        sys.exit(1)

    pending = json.loads(Path(PENDING_FILE).read_text())
    device_code = pending["device_code"]
    interval    = pending.get("interval", 5)
    expires_at  = datetime.fromisoformat(pending["expires_at"])

    if datetime.now(timezone.utc) > expires_at:
        os.remove(PENDING_FILE)
        print("ERROR: auth code expired — run 'tado-auth.py start' to get a new one", file=sys.stderr)
        sys.exit(1)

    # Wait the required interval before polling
    time.sleep(interval)

    resp = requests.post(TOKEN_URL, data={
        "client_id":   CLIENT_ID,
        "grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
        "device_code": device_code,
    }, timeout=10)

    body = resp.json()
    error = body.get("error", "")

    if error == "authorization_pending":
        # User hasn't approved yet
        sys.exit(2)

    if error == "slow_down":
        pending["interval"] = interval + 5
        Path(PENDING_FILE).write_text(json.dumps(pending))
        sys.exit(2)

    if error:
        print(f"ERROR: {error}: {body.get('error_description', '')}", file=sys.stderr)
        sys.exit(1)

    if "refresh_token" not in body:
        print(f"ERROR: unexpected response: {body}", file=sys.stderr)
        sys.exit(1)

    # Success — save token in libtado-compatible format
    token_data = {"refresh_token": body["refresh_token"]}
    Path(TOKEN_FILE).write_text(json.dumps(token_data))
    os.chmod(TOKEN_FILE, 0o600)

    # Clean up pending state
    os.remove(PENDING_FILE)

    print("AUTH_SUCCESS=1")
    print(f"TOKEN_FILE={TOKEN_FILE}")


def cmd_status():
    """Print current auth status."""
    if os.path.exists(TOKEN_FILE):
        print("STATUS=authenticated")
        return
    if os.path.exists(PENDING_FILE):
        pending = json.loads(Path(PENDING_FILE).read_text())
        expires_at = datetime.fromisoformat(pending["expires_at"])
        remaining = int((expires_at - datetime.now(timezone.utc)).total_seconds())
        if remaining > 0:
            print(f"STATUS=pending_user_action expires_in={remaining}s")
        else:
            print("STATUS=expired")
        return
    print("STATUS=not_authenticated")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "start":
        cmd_start()
    elif cmd == "complete":
        cmd_complete()
    elif cmd == "status":
        cmd_status()
    else:
        print(f"Usage: tado-auth.py {{start|complete|status}}", file=sys.stderr)
        sys.exit(1)
