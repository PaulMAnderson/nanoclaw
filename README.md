# NanoClaw Docker Setup

Runs nanoclaw inside a minimal Ubuntu 24.04 container, using the isolated
nanoclaw rootless Docker daemon (not your host daemon) for agent sandboxing.

## Architecture

```
Your host
  ├── Main Docker daemon        ← your other containers, untouched
  └── nanoclaw rootless daemon  ← nanoclaw's private sandbox
        └── nanoclaw container  ← the host process (Node.js + WhatsApp)
              └── agent containers spawned per conversation turn
```

The nanoclaw container only has access to `/run/user/1667/docker.sock` (the
isolated daemon). It cannot see your host daemon or any of your other
containers.

## Prerequisites

1. The nanoclaw rootless Docker daemon must be running (set up earlier):
   ```bash
   sudo su - nanoclaw
   export XDG_RUNTIME_DIR=/run/user/1667
   systemctl --user start docker
   systemctl --user enable docker
   ```

2. Clone the nanoclaw source into this directory:
   ```bash
   # Copy src/, package.json, package-lock.json, tsconfig.json into here
   # alongside this Dockerfile and docker-compose.yml
   ```

3. Create your `.env` file:
   ```bash
   cp .env.example .env
   # Edit .env and add your ANTHROPIC_API_KEY
   ```

4. Create the mount allowlist config directory:
   ```bash
   mkdir -p ~/.config/nanoclaw
   # Optionally copy config-examples/mount-allowlist.json there
   cp /path/to/nanoclaw/config-examples/mount-allowlist.json ~/.config/nanoclaw/
   ```

## First Run (WhatsApp QR scan)

The first time you run nanoclaw you need to scan a QR code to authenticate
WhatsApp. Run in the foreground so you can see the QR:

```bash
docker compose run --rm nanoclaw
```

Scan the QR with your phone. Auth is stored in the `nanoclaw-store` volume
and persists across restarts.

## Normal Operation

```bash
# Start in background
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down

# Rebuild after code changes
docker compose build
docker compose up -d
```

## Notes

- The `nanoclaw-store`, `nanoclaw-data`, and `nanoclaw-groups` Docker volumes
  are managed by the **host** Docker daemon (your main one), not the nanoclaw
  daemon. This is correct — they hold nanoclaw's persistent state.
- Agent containers that nanoclaw spawns per conversation turn run inside the
  **nanoclaw daemon** and are ephemeral.
- If you want to inspect what agent containers are running, use:
  ```bash
  DOCKER_HOST=unix:///run/user/1667/docker.sock docker ps
  ```

---

## Fork-Specific Changes (PaulMAnderson/nanoclaw)

This fork adds the following on top of upstream nanoclaw. See [CHANGELOG.md](CHANGELOG.md) for details.

### Semantic Memory (Phase A)
`src/memory.ts` — memsearch CLI integration for persistent vector memory across sessions. Groups write to per-group `memory/MEMORY.md` files which the agent loads on each turn.

### Web UI Channel (Phase B)
`src/channels/web.ts` — HTTP server + WebSocket + REST API for browser-based chat. Includes a logs viewer and active container status indicators. Access at `http://localhost:3000`.

### Rootless Docker Permission Fixes
Agent container UID remapping caused `chmod` failures on bind-mounted files. Fixed with `chmod -R 777` on session `.claude/` dirs and suppressed errors from container-owned files. See [docs/ROOTLESS_DOCKER_SETUP.md](docs/ROOTLESS_DOCKER_SETUP.md).

### Agent Container Enhancements
`container/Dockerfile` — Python 3, pip, and jq added to the agent container image. Required for Tado auth scripts and data-processing tasks.

### Home Automation Group
`groups/home/` — Home Assistant + Tado integration:
- `ha-helper.sh` — queries HA using `192.168.1.254` (hostname unreachable from rootless Docker)
- `tado-auth.py` + `tado-helper.sh` — updated for post-March 2025 Tado OAuth2 endpoints (two-phase auth flow)

### GTD Group (Todoist)
`groups/gtd/` — GTD task management via Todoist REST API v1. Requires `TODOIST_API_TOKEN` in `.env`.
