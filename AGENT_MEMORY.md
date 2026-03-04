# NanoClaw -- Agent Memory

> This file is auto-generated from development session analysis. Last updated: 2026-03-03.
> Read this before working on any NanoClaw task.

## What is NanoClaw?

NanoClaw is a personal AI agent runner that bridges WhatsApp (and a web UI) to Claude Code agents running in isolated Docker containers. It is a Node.js/TypeScript system that runs as a single host process, spawning one Docker container per conversation group when a message arrives.

- **Owner**: Paul (neuroscientist, based in Europe, travels to Australia annually)
- **Server**: "Hypercube" at LAN IP `192.168.1.254`, remote access via Tailscale
- **Fork**: `github.com/PaulMAnderson/nanoclaw` (upstream: `github.com/qwibitai/nanoclaw`)
- **Assistant personality**: "Robot" (NOT "Andy" -- this was corrected during development)
- **Primary interaction**: WhatsApp messages using `@Robot` trigger in group chats
- **Secondary interaction**: Web UI at port 18790 (LAN-local)
- **User access pattern**: Paul accesses as `paul` user in `nanoclaw` group, remotely via Tailscale from Australia when travelling

The fork extends upstream NanoClaw with:
- Semantic long-term memory via memsearch (Python CLI) + Ollama embeddings
- A web UI (vanilla HTML/JS SPA) served from the same Node.js process
- Home Assistant smart home control via helper script
- Tado smart thermostat OAuth2 device-code flow integration
- GTD/Todoist task management integration
- Python/pip/jq in agent containers for scripting capabilities

## Architecture Overview

```
Host Process (node dist/index.js, systemd user service under nanoclaw user UID 1667)
  |
  +-- WhatsApp Channel (Baileys) -- receives messages from WhatsApp groups/DMs
  |     Trigger: @Robot in group messages
  |
  +-- Web Channel (express + ws) -- receives messages from browser UI
  |     Port: 18790, optional auth via NANOCLAW_WEB_TOKEN
  |
  +-- SQLite DB (store/messages.db) -- stores all messages, group registrations
  |
  +-- Polling Loop -- checks for new messages per registered group
  |
  +-- Memory Module (src/memory.ts) -- calls memsearch CLI on host before/after agent
  |     Writes .memory-context.md to group dir (host-side injection)
  |
  +-- Container Runner (src/container-runner.ts)
       |
       +-- Rootless Docker daemon (socket: /run/user/1667/docker.sock)
       +-- Spawns isolated Docker containers per group
       +-- Runs as --user 1667:1667 (nanoclaw UID:GID)
       +-- Mounts: group workspace as /workspace/group
       +-- Mounts: session .claude/ dir as /home/node/.claude
       +-- Injects secrets via stdin JSON (OAuth token, API keys)
       +-- Containers HAVE network access (LAN + internet)
       +-- Container image: nanoclaw-agent:latest (Ubuntu 24.04 + Node.js 20 + Python3 + pip + jq)
```

### Data Flow for a Message

1. Message arrives (WhatsApp or WebSocket)
2. Stored in SQLite under the chat JID (real WhatsApp JID or synthetic `web:{folder}` JID)
3. Polling loop detects new message for a registered group
4. `ensureMemoryDir(groupDir)` creates `memory/` if needed
5. `recallMemories(groupDir, query)` runs memsearch CLI on host, writes `.memory-context.md`
6. `sudo chmod -R 777` on group workspace and session dir (via sudoers)
7. `runContainerAgent()` spawns Docker container with Claude Code
8. Agent reads `CLAUDE.md` (working memory), `.memory-context.md` (recalled context), processes message
9. Agent writes response, potentially updates `memory/MEMORY.md` and `memory/YYYY-MM-DD.md`
10. `indexMemories(groupDir)` re-indexes memory/ dir after container exits
11. Response routed back via the originating channel (WhatsApp or WebSocket)

## Key Design Decisions

| # | Decision | Rationale | Source |
|---|----------|-----------|--------|
| 1 | **Single Node.js process** (no separate services) | Old plan proposed FastAPI sidecar + Next.js frontend. Rejected: added complexity, had critical path mismatch bug (`/home/nanoclaw/app/` vs `/home/nanoclaw/nanoclaw/`). New plan runs memsearch CLI via execSync, serves web UI from express in same process. | S02 Mar01 |
| 2 | **Memory runs on host, not in containers** | memsearch CLI runs on host via execSync before container spawn, writes `.memory-context.md`. Containers read it. Preserves container isolation from embedding service complexity. | S02 Mar01 |
| 3 | **Host-side memory injection (non-standard)** | The host injects memory context before spawn -- agent does not know it is happening. Acknowledged as architecturally non-standard. The "NanoClaw way" would be an MCP tool the agent calls voluntarily. Discussed but not resolved; current implementation left in place. | S01 Feb28 |
| 4 | **Web messages use synthetic JIDs** | `web:{folder}` JIDs route through existing pipeline. `syncWebGroups()` adds in-memory mirrors with `requiresTrigger: false`. Existing `findChannel()` + `processGroupMessages()` pipeline works transparently. | S02 Mar01 |
| 5 | **qwen3-embedding over nomic-embed-text** | Already downloaded, superior quality (7.6B params, 32K context vs 137M/8K). Ollama runs in a system Docker container mapped to host port 10001. | S01 Feb28 |
| 6 | **Long-lived OAuth token via `claude setup-token`** | Old approach used `nanoclaw-sync-token` systemd timer to copy short-lived (~1h) tokens. Caused persistent 401s. `claude setup-token` generates a token designed for daemon/server use. The sync-token system-level service and timer were removed (`sudo systemctl disable --now`). | S01 Feb28 |
| 7 | **sudo chmod for rootless Docker permissions** | Rootless Docker remaps UIDs. Files created by containers (owned by host UID 232739) cannot be chmod'd by nanoclaw user (UID 1667) without sudo. Sudoers entry created at `/etc/sudoers.d/nanoclaw`. | S02 Mar01 |
| 8 | **Python + pip + jq in containers** | Agent tasks (Tado, web scraping, data processing) require Python. `ha-helper.sh` needs jq. Pre-installed: requests, beautifulsoup4, lxml, Pillow, python-dotenv, httpx. | S02 Mar01 |
| 9 | **LAN IP 192.168.1.254 for host services** | `host-gateway` resolves to 172.17.0.1 inside nanoclaw's rootless Docker daemon, but iptables blocks cross-daemon traffic. `localhost` is container's own loopback. LAN IP works reliably. Used for: Ollama (10001), Home Assistant (8123). | S01 Feb28 |
| 10 | **GTD labels over projects** | Paul has 40+ existing projects. Moving tasks to dedicated GTD projects disconnects them from project context. Labels (@next, @waitingon, @someday) let tasks stay in place while remaining filterable. Dedicated GTD child projects (Next Actions, Waiting For, Someday Maybe) were DELETED. Only Reference and Archive remain as projects under GTD. | S02 Mar03 |

## Development History

| Date | Session | Key Events |
|------|---------|------------|
| Feb 27 | 3098f5bf | Connected `/home/nanoclaw/nanoclaw/` to PaulMAnderson/nanoclaw fork. Preserved data/, store/, groups/, .env. Clarified that groups ARE NanoClaw groups (not extra layer). |
| Feb 28 | 4f366a43 | Implemented old plan Phase 1. Discovered Ollama on port 10001. Chose qwen3-embedding. Created memsearch FastAPI sidecar (later removed). Fixed host-gateway with LAN IP. Set up SSH deploy key. Registered health group. Hit EACCES on .claude/debug/. Discovered and disabled Paul's personal NanoClaw service at `/home/paul/NanoClaw/`. Fixed IPC permissions (tasks/ needed o+w). |
| Feb 28 | 7992d973 | User issued the authoritative new-plan specification prompt. Session interrupted almost immediately, but the task prompt defines the new plan's key constraints (no separate services, memsearch CLI on host, web UI in same process, synthetic web JIDs). |
| Mar 01 | a43f4f2a | **Major architectural pivot**. Removed memsearch sidecar. Created src/memory.ts, src/channels/web.ts, web/ frontend. Fixed OAuth token (claude setup-token). Added Home group with ha-helper.sh, tado-auth.py, tado-helper.sh. Added Python/pip/jq to container. Fixed Tado OAuth2 (new endpoints, bash subshell bug, JWT HOME_ID extraction). Hit Tado rate limit. Added sudoers for chmod. Created extract-claude-conversations.py. Added web UI logs viewer and container indicators. |
| Mar 02 | 2cda0b95 | Installed RPI plugin. Built GTD+Todoist plugin at ~/Documents/Development/Skills/gtd-todoist/. Configured Todoist MCP. Discovered API v2 deprecated (HTTP 410). Created GTD structure in Todoist. Built 5 skills, 5 commands, 1 agent. NanoClaw Phase 5 (TODOIST_API_TOKEN in secrets allowlist). Phase 6 (README, CHANGELOG, docs). Pushed to GitHub. |
| Mar 03 | ff1b0b3a | Redesigned GTD: labels over projects. Simplified contexts (removed @phone/@computer). Major Todoist project restructure. Recovered from cascade deletion of Hobbies. Colour-coded ~50 projects. Bulk labelled 145 tasks. Updated all 5 plugin skills. Added smart capture skip-logic. Initiated fan-out analysis for AGENT_MEMORY.md. |

## Technical Stack

| Component | Technology | Details |
|-----------|-----------|---------|
| Runtime | Node.js 20 | via .nvmrc |
| Language | TypeScript | compiled via `npm run build` to dist/ |
| Container OS | Ubuntu 24.04 | nanoclaw-agent:latest image |
| Docker | Rootless Docker | user namespace remapping, socket at /run/user/1667/docker.sock |
| WhatsApp | Baileys library | |
| Web Server | express + ws | embedded in main process, port 18790 |
| Database | SQLite | store/messages.db |
| AI | Claude Code / Claude Agent SDK | runs inside containers |
| Embeddings | Ollama | qwen3-embedding:latest (7.6B params, 32K context), system Docker port 10001 |
| Semantic Search | memsearch 0.1.13 | Python CLI at ~/.local/bin/memsearch, uses Milvus Lite (.memsearch.db per group) |
| Frontend | Vanilla HTML/CSS/JS | dark theme, no build step |
| Container extras | python3-pip, python3-venv, jq | Pre-installed: requests, beautifulsoup4, lxml, Pillow, python-dotenv, httpx |
| Logger | pino | |
| Service Manager | systemd user service | nanoclaw user |
| Python | 3.12 | in containers; system Python on host for memsearch |

## File Map

### Source Files (src/)

| File | Purpose |
|------|---------|
| `src/index.ts` | Main entry point: polling loop, message routing, memory integration (calls recallMemories/indexMemories), web channel init, syncWebGroups() |
| `src/config.ts` | Configuration constants: WEB_PORT (18790), WEB_AUTH_TOKEN, MEMSEARCH_BIN, OLLAMA_HOST, MEMORY_EMBEDDING_MODEL, MEMORY_SEARCH_TOP_K (5), MEMORY_COMPACTION_THRESHOLD_KB (50) |
| `src/memory.ts` | Semantic memory: recallMemories(), indexMemories(), ensureMemoryDir(), checkCompactionNeeded() (DEAD CODE -- never called from index.ts). All via execSync calling memsearch CLI. |
| `src/container-runner.ts` | Container spawning: Docker run with --user 1667:1667, mounts, secrets injection via stdin, sudo chmod -R 777, cleanupOrphans() |
| `src/channels/web.ts` | WebChannel: express HTTP server, WebSocket on /ws, REST API at /api/*, static file serving from web/ |

### Web UI (web/)

| File | Purpose |
|------|---------|
| `web/index.html` | SPA shell: sidebar nav (Dashboard, Chat, Memory, Tasks, Logs), group list, container status |
| `web/style.css` | Dark theme CSS (~150 lines), CSS custom properties, flex layout |
| `web/app.js` | Vanilla JS (~220+ lines): WebSocket with reconnect, group management, dashboard, chat, memory browser + semantic search, tasks, logs, container status polling (every 5s) |

### Group Workspaces (groups/)

| Directory | Status | Purpose |
|-----------|--------|---------|
| `groups/main/` | **REGISTERED** | Primary WhatsApp self-chat |
| `groups/health/` | **REGISTERED** | Health domain (knee injury, medical). Contains: CLAUDE.md, extract-claude-conversations.py |
| `groups/home/` | **REGISTERED** | Home automation (HA + Tado). Contains: CLAUDE.md, ha-helper.sh, tado-auth.py, tado-helper.sh |
| `groups/gtd/` | **REGISTERED** | GTD/Todoist agent. CLAUDE.md has full API v1 reference, all project IDs, GTD decision tree, curl examples |
| `groups/global/` | UNREGISTERED LEGACY | Just a CLAUDE.md, no activity. Artifact from old plan. |
| `groups/work/` | UNREGISTERED LEGACY | Not the active work group. Artifact. |
| `groups/hobbies/` | UNREGISTERED LEGACY | Not active. Artifact. |
| `groups/home-automation/` | UNREGISTERED LEGACY | **NOT the active home automation group.** `groups/home/` is the active one. Legacy artifact. |
| `groups/groups/` | UNREGISTERED LEGACY | Accidental nested directory from old plan path confusion. |

### Infrastructure

| File | Purpose |
|------|---------|
| `container/Dockerfile` | Agent container image: Ubuntu 24.04 + Node.js 20 + Python3 + pip + jq + common packages |
| `compose.yml` | Docker Compose config. Contains active env vars (TODOIST_API_TOKEN). **Must be updated when adding new secrets** (not reference-only). |
| `.env` | Secrets (gitignored): CLAUDE_CODE_OAUTH_TOKEN, TODOIST_API_TOKEN, ASSISTANT_NAME=Robot |
| `/home/nanoclaw/nanoclaw/.mcp.json` | MCP server configuration for agent containers. Separate from desktop MCP config. |
| `~/.claude/mcp.json` | Desktop Claude Code MCP config (Doist OAuth HTTP MCP). Different scope from repo .mcp.json. |
| `docs/ROOTLESS_DOCKER_SETUP.md` | Rootless Docker setup guide and UID remapping explanation |
| `/etc/sudoers.d/nanoclaw` | Allows nanoclaw user: `NOPASSWD: /bin/chmod -R 777 /home/nanoclaw/nanoclaw/groups/` and equivalent for `data/sessions/` |
| `planning/new-plan.md` | Authoritative implementation spec (replaces old-plan.md) |

### REST API Endpoints (WebChannel)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/groups` | List all registered groups |
| `GET /api/groups/:folder/messages` | Chat history for a group |
| `GET /api/groups/:folder/memory` | List memory files |
| `GET /api/groups/:folder/memory/search?q=` | Semantic search via memsearch |
| `GET/PUT /api/groups/:folder/memory/:file` | Read/write memory files |
| `GET /api/tasks` | List tasks across groups |
| `GET /api/dashboard` | Aggregated stats |
| `GET /api/logs` | List container log files (newest first) |
| `GET /api/logs/:file` | Read a specific log file |
| `GET /api/containers` | Currently running containers |

Auth: optional token via `NANOCLAW_WEB_TOKEN` env var, passed as `?token=` query parameter.

## Subsystem Details

### Agent Runner (src/container-runner.ts)

**Container Spawning**:
- Uses rootless Docker daemon at `/run/user/1667/docker.sock`
- Image: `nanoclaw-agent:latest`
- **Runs as `--user 1667:1667`** (nanoclaw UID:GID)
- Mounts: group workspace at `/workspace/group`, session .claude/ at `/home/node/.claude`
- Secrets injected via stdin JSON (`ContainerInput.secrets`): CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, TODOIST_API_TOKEN
- Containers have network access (can reach LAN services and internet APIs)

**Permission Fixes**:
- `sudo chmod -R 777` on session .claude/ dir and group workspace dir before each spawn
- Wrapped in try/catch (non-fatal if files owned by previous container's remapped UID)
- Sudoers entry: `/etc/sudoers.d/nanoclaw`

**cleanupOrphans()**: On startup, kills containers matching `--filter name=nanoclaw-`. Use explicit `container_name:` in compose.yml to avoid the nanoclaw- prefix matching.

**Secret injection**: `readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'TODOIST_API_TOKEN'])` reads from `.env` on every container spawn. Injected via stdin JSON as `ContainerInput.secrets`. The agent-runner merges them into `sdkEnv`. `.credentials.json` is NOT used by NanoClaw -- do not copy it into session dirs.

### Web UI & Channel (Phase B)

The web UI is embedded in the main Node.js process via express + ws on port 18790.

**WebSocket Protocol**:
- Client sends: `{type:"message", groupFolder:"health", text:"Hello"}`
- Server creates a synthetic message with `chat_jid = web:{folder}`
- Calls `onChatMetadata()` then `onMessage()` with the synthetic JID
- Server sends responses back to ALL WebSocket clients subscribed to that group folder

**JID Routing**: `syncWebGroups()` adds in-memory mirrors of all registered groups with `web:{folder}` JIDs and `requiresTrigger: false`. Web groups are in-memory only (not in SQLite).

**Logs Viewer**: Lists log files newest-first with relative time, exit code badges, and duration. Click to view full log content.

**Active Container Indicators**: Polls `/api/containers` every 5 seconds. Sidebar group dots pulse green when a container is running.

### Semantic Memory / memsearch (Phase A)

**Host-Side Architecture**: The memsearch Python CLI runs on the host (not in containers) via `execSync`. This is architecturally non-standard -- the agent does not know memory injection is happening. The discussed alternative (MCP tool the agent calls voluntarily) was not implemented.

**Key Functions** (src/memory.ts):
| Function | Description |
|----------|-------------|
| `ensureMemoryDir(groupDir)` | Creates `memory/` subdir and seeds `MEMORY.md` if missing |
| `recallMemories(groupDir, query, topK)` | Runs `memsearch search` CLI, writes `.memory-context.md` to group dir (not memory/). 15s timeout. Fails silently. topK defaults to MEMORY_SEARCH_TOP_K (5), overridable. |
| `indexMemories(groupDir)` | Runs `memsearch index` after container exits. Fails silently. |
| `checkCompactionNeeded(groupDir)` | **DEAD CODE** -- defined but never called from index.ts. Returns list of .md files exceeding threshold KB. Must be wired up in index.ts polling loop to activate compaction. |

**Actual memsearch CLI flags** (discovered by testing, docs were wrong):
- `--milvus-uri <path>` (NOT `--paths`)
- `--json-output` (NOT `--format json`)
- `--provider ollama`
- `--model qwen3-embedding:latest`
- `--top-k N`
- Env: `OLLAMA_HOST=http://192.168.1.254:10001`

**Memory File Structure per Group**:
```
groups/{folder}/
  CLAUDE.md                    -- per-group agent instructions (read by agent, never by host)
  .memory-context.md           -- recalled context (written by host, read by agent at /workspace/group/)
  memory/
    MEMORY.md                  -- structured persistent facts
    YYYY-MM-DD.md              -- daily logs (free-form, timestamped)
    .memsearch.db              -- Milvus Lite vector index per group
```

**Configuration** (src/config.ts):
```
MEMSEARCH_BIN = ~/.local/bin/memsearch
OLLAMA_HOST = http://192.168.1.254:10001
MEMORY_EMBEDDING_MODEL = qwen3-embedding:latest
MEMORY_SEARCH_TOP_K = 5
MEMORY_COMPACTION_THRESHOLD_KB = 50
```

### Skills Engine

NanoClaw has a two-tier extension model:
1. **Skills** (`.claude/skills/`) -- instruction/prompt files that teach agents behavior. No code changes required.
2. **Code modifications** -- infrastructure-level changes to container-runner.ts, index.ts, etc.

`CLAUDE.md` files in group directories serve as per-group fast memory / instruction sets. The host process never reads CLAUDE.md -- it is only read by the agent inside the container at `/workspace/group/CLAUDE.md`.

### Groups System

Each registered group has:
- A folder in `groups/` (e.g., `groups/health/`)
- A `CLAUDE.md` file (agent instructions + working memory)
- A `memory/` subdirectory (long-term observations)
- A session directory at `data/sessions/{folder}/.claude/`
- An IPC directory at `data/ipc/{folder}/` with `tasks/`, `input/`, `messages/` subdirs
- A registration entry in SQLite with: JID, name, folder, trigger pattern, active flag

**IMPORTANT**: Groups ARE NanoClaw groups. Projects are not something extra on top -- they are the same concept. Each domain (health, home, gtd) is simply a NanoClaw group with its own container context.

**IPC Permissions**: The `tasks/`, `input/`, `messages/` subdirectories under `data/ipc/{group}/` MUST be world-writable (`o+w`) for agent containers to submit IPC task files. The sudoers chmod entry covers `groups/` and `sessions/` but NOT IPC dirs -- these need separate attention when creating new groups.

**Web groups**: `syncWebGroups()` creates in-memory mirrors with `web:{folder}` JIDs and `requiresTrigger: false`. These are NOT stored in SQLite.

**Group registration**: See Operational Guide below for the procedure.

### Container & Docker Setup

**Rootless Docker**:
- Daemon runs as nanoclaw user (UID 1667)
- Socket: `/run/user/1667/docker.sock`
- User namespace remapping via subuid: base 231072, range 65536

**UID Remapping Table**:

| Container UID | Host UID | Notes |
|---------------|----------|-------|
| 0 (root) | 231072 | Base of remapping range |
| 999 (node) | 232071 | Node.js user in image; NOT used at runtime |
| 1667 (nanoclaw) | 232739 | **Actual runtime user** (--user 1667:1667). Files created by agents are owned by this UID on host. |

**The UID Remapping Problem**: Files created by containers are owned by host UID 232739. The nanoclaw host user (UID 1667) cannot read/write/chmod them without sudo.

**Solutions implemented**:
1. `sudo chmod -R 777` via sudoers before each container spawn (in try/catch)
2. `UMask=0002` in systemd service for group-writable Node-created files
3. setgid bit on groups/, data/, store/ directories

**Container Image** (container/Dockerfile):
- Base: Ubuntu 24.04 + Node.js 20
- Added: python3-pip, python3-venv, jq
- Pre-installed Python: requests, beautifulsoup4, lxml, Pillow, python-dotenv, httpx

**Container Mounts**:
- Group workspace: `/workspace/group` (NOT /workspace/project)
- Session dir: `/home/node/.claude`

### Tado OAuth2 Integration

**Endpoints** (migrated March 2025; old `auth.tado.com` returns 404):
- Device authorization: `https://login.tado.com/oauth2/device_authorize`
- Token exchange: `https://login.tado.com/oauth2/token`
- Client ID: `1bb50063-6b0c-4d11-bd99-387f4a91cc46`
- Required: `scope=offline_access` (without it, no refresh_token)
- Required: `User-Agent: python/libtado` on ALL API calls (or Tado returns empty/429)

**Two-Phase Auth Flow** (tado-auth.py):
1. `start`: POSTs to device_authorize, saves pending state to `.tado-auth-pending.json`, prints URL + user code, exits immediately (so agent can relay URL via WhatsApp)
2. `complete`: Reads pending state, polls for token, saves `{"refresh_token": "..."}` to `.tado-token.json`
3. `status`: Shows current auth state

**tado-helper.sh**:
- Initializes token ONCE at global scope (fixes bash subshell scope bug -- variables set in `$(...)` do not propagate)
- **MANDATORY**: Extracts HOME_ID from JWT payload (conserves 1000 req/day rate limit). Do NOT add an API call to `/me` for home ID.
- HOME_ID for Paul's account: 549394 (embedded in JWT)
- Commands: zones, zone, schedule, temp, auth
- Token rotation: each refresh_token use immediately invalidates old token. Must save new token before any additional API calls.

**Rate Limit**: 1000 requests/day. Easily exhausted during debugging. Every saved API call matters.

### Home Assistant Integration

- `groups/home/ha-helper.sh` calls Home Assistant REST API at `http://192.168.1.254:8123`
- Requires `jq` for JSON parsing (installed in container image)
- Uses HA long-lived access token (injected via container secrets or CLAUDE.md)

### Environment & Secrets

**`.env` file** (at `/home/nanoclaw/nanoclaw/.env`, gitignored):
```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (long-lived, from claude setup-token)
TODOIST_API_TOKEN=<token>
ASSISTANT_NAME=Robot
```

**Two MCP config files** (different scopes):
| File | Scope | Purpose |
|------|-------|---------|
| `~/.claude/mcp.json` | Desktop Claude Code (paul user) | Doist OAuth HTTP MCP for GTD skills |
| `/home/nanoclaw/nanoclaw/.mcp.json` | Agent containers | MCP server config for containerized agents |

**When adding new secrets**: Update BOTH `.env` AND `compose.yml`. Also add to the `readEnvFile()` allowlist in `src/container-runner.ts`.

**Systemd service**: `/home/nanoclaw/.config/systemd/user/nanoclaw.service`
- `WorkingDirectory=/home/nanoclaw/nanoclaw`
- `UMask=0002`
- Uses `.env` via `readEnvFile()` (not systemd EnvironmentFile)

**Auth history**: The old `nanoclaw-sync-token.service` and `nanoclaw-sync-token.timer` (system-level, in `/etc/systemd/system/`) were removed with `sudo systemctl disable --now`. Auth is now solely via `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

### Todoist Integration

**NanoClaw Side**:
- `TODOIST_API_TOKEN` in `.env`, `compose.yml` environment, AND `readEnvFile()` allowlist in container-runner.ts
- `groups/gtd/CLAUDE.md` is the comprehensive reference: all project IDs, all label names, full API v1 curl examples with auth headers, GTD decision tree

**GTD Plugin** (separate repo: `~/Documents/Development/Skills/gtd-todoist/`):
- GitHub: `PaulMAnderson/claude-gtd-todoist`
- Installed to `~/.claude/` (skills, commands, agents)
- MCP configured in `~/.claude/mcp.json` (Doist OAuth HTTP MCP at `https://ai.todoist.net/mcp`)
- Skills: gtd-capture (with smart skip-logic), gtd-process-inbox, gtd-weekly-review, gtd-daily-plan, gtd-context-review
- Commands: /gtd-todoist:{capture,process-inbox,weekly-review,daily-plan,waiting-for}
- Agent: todoist-gtd-assistant
- Continuation state: `~/Documents/Development/Skills/gtd-todoist/.rpi/CONTEXT.md` (compressed context from last session)

**GTD Structure in Todoist (Final Design)**:
- Tasks stay in their native projects (Work/, Life/, etc.)
- Status labels: `@next`, `@waitingon`, `@someday` (NOT dedicated projects -- those were deleted)
- Context labels: `@work`, `@home`, `@errands` ONLY (`@phone` and `@computer` deliberately removed -- Paul does not think in device terms)
- Energy labels: `#energy-low`, `#energy-high`, `#2min`
- GTD project contains only meta-tasks (Weekly Review, Process Inbox, Daily Planning)
- Reference and Archive remain as projects under GTD
- Paul thinks in terms of PROJECTS, not contexts. When reviewing tasks, start from project perspective.
- Paul is a GTD newcomer -- keep skills simple, avoid compound contexts.

**Todoist Project Hierarchy (Final)**:
```
Inbox (grey)
Getting Things Done (charcoal)
  Reference
  Archive
Work (blue)
BB (gold)                        -- Paul's son
Administration (teal)
  Appointments, Jobs, Finances, Legal
Home (orange)                    -- renamed from Apartment
Body (coral)
Mind (grape)
  Mathematics, Philosophy, Meditation, Piano, German
Hobbies (lime_green)
  Coding, Tech Projects, Gen Art, Baking, Things
Social (rose_pink)
  Birthdays
Events & Travel (sky_blue)       -- renamed from Travel
```

**Key Project IDs**:
| Project | ID |
|---------|----|
| Inbox | `6CrcvJ4gf682FP8H` |
| Getting Things Done | `6CrcvJ4hPxC5Mc2w` |
| Work | `6CrcvJ4h5frXcjvM` |
| Life | `6CrcvJ4gffrcpV73` |

(See `groups/gtd/CLAUDE.md` for all project IDs including children.)

**Critical Todoist API Facts**:

| Fact | Detail |
|------|--------|
| API version | v1 ONLY (`/api/v1/`). REST v2 returns HTTP 410. Sync API v9 also deprecated. |
| Pagination | Cursor-based via `next_cursor` field. MUST loop until cursor is null. First page returns ~28 items; total may be 44+. |
| Priority | REVERSED scale: P1 (urgent) = API value 4; P4 (none) = API value 1 |
| Cascade deletion | Deleting parent project PERMANENTLY deletes ALL children and their tasks. No API recovery. Always snapshot before deleting parents. |
| Filters | CANNOT be created via any API (REST or Sync). Must be created manually in Todoist UI. |
| Reparenting root projects | `parent_id` alone is rejected. Root projects cannot be moved under a parent via update -- must delete and recreate. |

**Recommended Todoist Filters** (created manually in UI):
- `@next`, `@waitingon`, `@someday`
- `@next & @work`, `@next & @home`, `@next & @errands`

## Operational Guide

### Starting/Stopping NanoClaw

```bash
# As nanoclaw user:
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
systemctl --user status nanoclaw

# As paul user (cross-user):
systemctl --user -M nanoclaw@ restart nanoclaw

# Linger (keep user services running after logout):
sudo loginctl enable-linger nanoclaw
```

### Registering a New Group

1. Get the WhatsApp JID from nanoclaw logs when a message is received from the target group (format: `120363424512277766@g.us` for groups)
2. Create the group directory and CLAUDE.md:
   ```bash
   sudo -u nanoclaw mkdir -p /home/nanoclaw/nanoclaw/groups/{folder}/memory
   sudo -u nanoclaw touch /home/nanoclaw/nanoclaw/groups/{folder}/CLAUDE.md
   ```
3. Create IPC directories with correct permissions:
   ```bash
   sudo -u nanoclaw mkdir -p /home/nanoclaw/nanoclaw/data/ipc/{folder}/{tasks,input,messages}
   sudo chmod o+w /home/nanoclaw/nanoclaw/data/ipc/{folder}/tasks
   sudo chmod o+w /home/nanoclaw/nanoclaw/data/ipc/{folder}/input
   sudo chmod o+w /home/nanoclaw/nanoclaw/data/ipc/{folder}/messages
   ```
4. Create session directory:
   ```bash
   sudo -u nanoclaw mkdir -p /home/nanoclaw/nanoclaw/data/sessions/{folder}/.claude
   ```
5. Insert into SQLite:
   ```bash
   sqlite3 /home/nanoclaw/nanoclaw/store/messages.db \
     "INSERT INTO registered_groups (jid, name, folder, trigger, active) VALUES ('THE_JID', 'Group Name', 'folder', '@Robot', 1);"
   ```
6. **RESTART the nanoclaw service** -- in-memory state is NOT refreshed from DB at runtime:
   ```bash
   systemctl --user restart nanoclaw    # as nanoclaw user
   ```

### File Ownership

- All files in `/home/nanoclaw/nanoclaw/` are owned by `nanoclaw:nanoclaw`
- Paul runs as `paul` but is in the `nanoclaw` group
- Edit files via `sudo -u nanoclaw tee` or as paul in group-writable dirs
- Git operations: `sudo -u nanoclaw git` (git identity: user.name=Paul, user.email=Paul@NeuralOscillations.com)
- `git config --global --add safe.directory /home/nanoclaw/nanoclaw` needed for paul user

### Building and Deploying

```bash
# Build TypeScript:
cd /home/nanoclaw/nanoclaw && npm run build

# Rebuild container image:
cd /home/nanoclaw/nanoclaw && docker build -t nanoclaw-agent:latest container/

# Restart after changes:
systemctl --user restart nanoclaw
```

### Running memsearch Manually

```bash
# Index a group's memory:
~/.local/bin/memsearch index \
  --milvus-uri /home/nanoclaw/nanoclaw/groups/health/memory/.memsearch.db \
  --provider ollama --model qwen3-embedding:latest \
  /home/nanoclaw/nanoclaw/groups/health/memory/

# Search:
OLLAMA_HOST=http://192.168.1.254:10001 \
~/.local/bin/memsearch search \
  --milvus-uri /home/nanoclaw/nanoclaw/groups/health/memory/.memsearch.db \
  --provider ollama --model qwen3-embedding:latest \
  --json-output --top-k 5 \
  "knee injury progress"
```

### Health Data Import Pattern

1. Export from Claude.ai: Settings -> Privacy -> Export Data -> ZIP with conversations.json
2. Filter with `groups/health/extract-claude-conversations.py`: `--project "ProjectName"` or keyword filter
3. Place output file in `groups/health/` workspace
4. Send @Robot message asking it to read and extract to MEMORY.md
5. Note: files >25,000 tokens require chunked reading (agent handles automatically)

## Known Issues & Gotchas

### Critical

| # | Issue | Details | Workaround |
|---|-------|---------|------------|
| 1 | **Rootless Docker UID remapping** | Container-created files owned by host UID 232739. nanoclaw user (1667) cannot chmod them. | `sudo chmod -R 777` via sudoers. All chmod calls in try/catch. |
| 2 | **host-gateway unreachable** | Resolves to 172.17.0.1 in rootless daemon; iptables blocks cross-daemon traffic. | Use LAN IP `192.168.1.254` for Ollama (10001), HA (8123). |
| 3 | **cleanupOrphans() kills matching containers** | Any container with name starting `nanoclaw-` killed on startup. | Use explicit `container_name:` in compose.yml. |
| 4 | **Two path trees** | `/home/nanoclaw/app/` (dead, old Docker mount) vs `/home/nanoclaw/nanoclaw/` (actual PROJECT_ROOT). This caused wrong DB, wrong IPC dir, wrong groups paths repeatedly. | Always use `process.cwd()` = `/home/nanoclaw/nanoclaw/`. Never reference `/home/nanoclaw/app/`. |
| 5 | **.credentials.json NOT used** | NanoClaw injects auth via stdin secrets, NOT .credentials.json. Any .credentials.json in session dirs was placed there by mistake and should be removed. | Use `CLAUDE_CODE_OAUTH_TOKEN` in `.env` from `claude setup-token`. |
| 6 | **DB changes need service restart** | In-memory state (group registrations, session IDs) is NOT refreshed from SQLite at runtime. | Always restart nanoclaw after DB modifications. |
| 7 | **IPC dirs must be world-writable** | `data/ipc/{group}/tasks/`, `input/`, `messages/` need `o+w` or agent containers silently fail to submit IPC tasks. | `chmod o+w` on all three subdirs. Sudoers entry does NOT cover IPC dirs. |

### Moderate

| # | Issue | Details | Workaround |
|---|-------|---------|------------|
| 8 | **Tado token rotation** | Each refresh_token use immediately invalidates it. Multiple sequential API calls can lose tokens. | Initialize token ONCE at script startup. Save new token after each use. |
| 9 | **Bash subshell variable scope** | Variables set inside `$(...)` don't propagate to parent. Affects tado-helper.sh token rotation. | Set variables at global scope, not inside subshells. |
| 10 | **Tado rate limit** | 1000 req/day. Easy to burn during debugging. | Extract HOME_ID from JWT (MANDATORY). Minimize API calls. |
| 11 | **memsearch CLI flags differ from docs** | Uses `--milvus-uri` (not `--paths`), `--json-output` (not `--format json`). | Always verify CLI flags empirically. |
| 12 | **Todoist API v2 deprecated** | Returns HTTP 410. Sync API v9 also deprecated. | Use `/api/v1/` only. |
| 13 | **Todoist cascade deletion** | Deleting parent deletes ALL children and tasks. Lost Hobbies hierarchy during restructuring; recovered by manual recreation from memory. | Always snapshot/verify children before deleting parent projects. |
| 14 | **Todoist pagination** | First page returns ~28 items. Must follow `next_cursor` to get all. Caused 16/44 projects missed in colour sweep. | Always loop until `next_cursor` is null. |
| 15 | **compose.yml YAML sensitivity** | Append-based edits can land in wrong section. | Safer to rewrite entire file. |
| 16 | **checkCompactionNeeded() is dead code** | Defined in memory.ts but never called from index.ts. Compaction is not active. | Must add call site in index.ts to enable. |

### Minor

| # | Issue | Details |
|---|-------|---------|
| 17 | **pip bootstrapping** | Required `curl get-pip.py \| python3 - --user --break-system-packages` for nanoclaw user. |
| 18 | **git safe.directory** | Initial git fails due to dubious ownership. Fix: `git config --global --add safe.directory /home/nanoclaw/nanoclaw`. |
| 19 | **WhatsApp sync timeout** | `AwaitingInitialSync` warning in logs is normal -- WhatsApp sync times out and continues. |
| 20 | **Agent name** | The assistant is "Robot", not "Andy". Corrected multiple times. |
| 21 | **Container workspace path** | `/workspace/group` (NOT /workspace/project). Early CLAUDE.md files had wrong path. |

### External Service API Pattern

Every external service integration in NanoClaw (memsearch CLI, Todoist, Tado, Ollama) required empirical testing to discover the real API surface. Documentation was wrong or outdated in every case. **Future agents should always verify with a test call before writing code against any external service.**

## Future Plans & TODOs

| Item | Status | Notes |
|------|--------|-------|
| Memory compaction | Not wired up | `checkCompactionNeeded()` exists but must be called from index.ts |
| MCP tool for memory search | Discussed, not implemented | Would replace host-side injection with agent-controlled search (more "NanoClaw native") |
| Unregistered legacy group cleanup | Pending | global/, groups/groups/, hobbies/, home-automation/, work/ should be reviewed for deletion |
| Todoist filters | Must create manually | 6 filters need manual creation in Todoist UI |
| GTD plugin continuation | See `.rpi/CONTEXT.md` | `~/Documents/Development/Skills/gtd-todoist/.rpi/CONTEXT.md` has current state and next steps |

## Important Warnings

1. **Paul's personal NanoClaw service** at `/home/paul/NanoClaw/` was DISABLED. Do NOT re-enable it. The active service is the nanoclaw-user systemd service.

2. **GitHub PAT was exposed** in conversation and should have been rotated. Do not use any PAT found in session logs.

3. **Todoist cascade deletion** destroyed the Hobbies project and all children during development. Always verify children before deleting parent projects. Recovery required manual recreation.

## RPI Plugin

Installed at `~/.claude/plugins/rpi-plugins/` from `PaulMAnderson/claude-plugins` (context-engineering branch).

**Available commands**:
- `/rpi-plan-and-execute:start-design-plan`
- `/rpi-plan-and-execute:start-implementation-plan`
- `/rpi-plan-and-execute:execute-implementation-plan`
- `/compress-context`

Hooks installed in `settings.json` for session-start and context-monitoring.

## Appendix: Analysis Metadata

- **Corpus**: 6 JSONL session files (Feb 27 -- Mar 3, 2026), ~4847 lines total
- **Worker**: W01 (comprehensive architecture extraction)
- **Critics**: C01 (detailed accuracy review), C02 (gap analysis + API details), C03 (operational procedures + contradictions)
- **Source files**:
  - `/tmp/fanout-nanoclaw-JxmkgF/workers/W01.md`
  - `/tmp/fanout-nanoclaw-JxmkgF/critics/C01.md`
  - `/tmp/fanout-nanoclaw-JxmkgF/critics/C02.md`
  - `/tmp/fanout-nanoclaw-JxmkgF/critics/C03.md`
- **Key corrections from critics**: Container networking (enabled, not disabled), --user 1667:1667 flag, home-automation/ legacy status, compose.yml is active, IPC permissions, group registration procedure, dead code identification, two .mcp.json files
