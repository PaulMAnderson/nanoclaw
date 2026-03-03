# Changelog

All notable changes to this fork of NanoClaw are documented here.

## [Unreleased] — PaulMAnderson fork

### Added

#### Web UI — Logs Viewer + Active Container Indicators
- `src/channels/web.ts`: logs endpoint streams recent agent logs via WebSocket
- `web/app.js`, `web/index.html`, `web/style.css`: log panel UI, active container badges showing which groups are currently running an agent

#### Web UI Channel (Phase B) — HTTP + WebSocket + REST
- Full browser-based chat interface served from the nanoclaw container
- HTTP REST endpoint for sending messages programmatically
- WebSocket for real-time message streaming
- Static frontend: `web/app.js`, `web/index.html`, `web/style.css`

#### Semantic Memory (Phase A) — memsearch CLI
- `src/memory.ts`: loads `memory/MEMORY.md` from each group folder into agent context on each turn
- Per-group memory files persist across restarts as bind-mounted files
- Groups pre-populated with `MEMORY.md` templates: health, hobbies, home-automation, main, work

#### Python / pip / jq in Agent Container
- `container/Dockerfile`: installs Python 3, pip, and jq
- Enables shell scripts and Python tools (e.g. Tado auth) to run inside agent containers

#### Home Automation Group (`groups/home/`)
- `groups/home/CLAUDE.md`: Home Assistant + Tado context for the home automation agent
- `groups/home/ha-helper.sh`: Home Assistant API wrapper
- `groups/home/tado-auth.py`: Tado OAuth2 auth script (post-March 2025 endpoints)
- `groups/home/tado-helper.sh`: Tado comfort/HVAC query helpers

#### GTD Group (`groups/gtd/`)
- `groups/gtd/CLAUDE.md`: GTD task management agent using Todoist REST API v1
- Requires `TODOIST_API_TOKEN` in `.env`

### Fixed

#### Tado OAuth2 — Post-March 2025 API Endpoints
- Updated `tado-auth.py` and `tado-helper.sh` to use new Tado identity endpoints
- Two-phase auth flow: get auth code → exchange for token
- Old endpoints returned 404/401 after Tado's March 2025 API migration

#### Docker Hostname for Home Assistant
- Changed `HA_URL` from hostname to `192.168.1.254` (fixed IP)
- Hostname was unreachable from inside rootless Docker network namespace
- `groups/home/ha-helper.sh`

#### Rootless Container Permission Fixes
Two-stage fix for UID remapping issues with bind-mounted directories:

1. `chmod -R 777` on session `.claude/` and group workspace dirs before container start — prevents Claude Code from failing to write to remapped paths
2. Suppress `chmod` errors from files already owned by the container UID — avoids noisy error output when the container has written files that the host user can't chmod

See [docs/ROOTLESS_DOCKER_SETUP.md](docs/ROOTLESS_DOCKER_SETUP.md) for full explanation.
