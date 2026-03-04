# NanoClaw Enhancement: Semantic Memory + Web UI

## Implementation Plan for Agent Context

You are modifying a fork of [NanoClaw](https://github.com/qwibitai/nanoclaw), a personal Claude assistant (~700 lines core TypeScript) that runs Claude Agent SDK inside isolated Linux containers. This plan adds two capabilities: semantic long-term memory and a web-based chat/dashboard interface.

Read the NanoClaw README and CLAUDE.md first. Understand the codebase before changing it. The philosophy is: small, understandable, skills over features, customization = code changes.

---

## Background: How NanoClaw Works Today

### Architecture
```
WhatsApp (baileys) → SQLite → Polling loop → Container (Claude Agent SDK) → Response
```

Single Node.js process. Key files:
- `src/index.ts` — Main orchestrator (~700 lines): state, message loop, agent invocation
- `src/container-runner.ts` — Spawns containers with isolated mounts, streams output
- `src/group-queue.ts` — Per-group FIFO queue with concurrency limits
- `src/channels/whatsapp.ts` — WhatsApp connection, auth, send/receive
- `src/ipc.ts` — IPC watcher and task processing (filesystem-based)
- `src/router.ts` — Message formatting and outbound routing
- `src/task-scheduler.ts` — Runs scheduled tasks (cron/interval/once)
- `src/db.ts` — SQLite operations (messages, groups, sessions, state)
- `src/config.ts` — Trigger pattern, paths, intervals
- `container/agent-runner/src/index.ts` — Claude SDK executor (runs inside container)
- `container/agent-runner/ipc-mcp.ts` — MCP tool interface inside container
- `groups/*/CLAUDE.md` — Per-group memory (mounted into containers)

### Current Memory Model

Memory is a single file per group: `groups/{folder}/CLAUDE.md`

The host process (`src/index.ts`) **never reads CLAUDE.md**. It just mounts the group directory into the container as `/workspace`. The Claude Agent SDK inside the container discovers and loads CLAUDE.md automatically (standard Claude Code behavior — it looks for CLAUDE.md in the working directory and treats it as persistent context/instructions).

The agent can edit CLAUDE.md to remember things. The file persists on the host via volume mount. Next time the container spawns, the updated CLAUDE.md is loaded again.

**Limitations:**
- No semantic search — entire CLAUDE.md loaded every time, all or nothing
- Context window ceiling — CLAUDE.md competes with conversation for context space (~20-30KB practical limit)
- No recall by relevance — agent can't search "what did we discuss about X?" across past conversations

### Current Message Flow
```
1. WhatsApp message → baileys → stored in SQLite (src/db.ts)
2. Polling loop (2000ms) → getNewMessages() → check TRIGGER_PATTERN
3. GroupQueue queues work → processGroupMessages callback
4. runAgent(groupFolder, prompt, chatJid, sessionId) in src/container-runner.ts
5. Container spawns with mounts:
   - groups/{folder}/        → /workspace (read-write)
   - data/sessions/{folder}/ → /home/node/.claude/ (session state)
   - data/ipc/{folder}/      → /ipc (IPC channel)
   - (any additionalMounts from registered_groups.json)
6. Claude Agent SDK runs inside container, finds /workspace/CLAUDE.md
7. Agent processes message, may edit CLAUDE.md, writes response
8. Response streamed back via stdout OUTPUT_START_MARKER...OUTPUT_END_MARKER
9. Host routes response to WhatsApp via src/router.ts
```

### Container Security Model
- Containers run with `NetworkMode: 'none'` — no network access
- Only explicitly mounted directories are visible
- Mount paths validated against `~/.config/nanoclaw/mount-allowlist.json`
- Each group gets isolated filesystem, IPC namespace, and Claude session
- **Do not break this model.** All new features must respect container isolation.

### Groups
Each WhatsApp group (or the main self-chat) maps to a directory in `groups/`. The main channel has admin privileges. Non-main groups are fully isolated from each other. Groups are registered in `data/registered_groups.json`.

---

## Enhancement 1: Semantic Long-Term Memory

### Overview

Add a second memory layer alongside CLAUDE.md. CLAUDE.md remains "working memory" (always loaded, manually curated). A new `memory/` directory per group holds dated markdown logs that are semantically indexed by [memsearch](https://github.com/zilliztech/memsearch) and recalled on demand.

memsearch is a standalone Python library (MIT, by Zilliz) that indexes markdown files into a vector database (Milvus Lite — a local .db file) and provides semantic search. It uses Ollama for local embeddings. No services to run, no infrastructure.

### How It Works

**Pre-container recall (HOST side):**
Before spawning a container for a message, the host process searches the group's memory for relevant context and writes the results to a file the agent can read.

**Post-container indexing (HOST side):**
After the container exits, if the agent wrote new observations to `memory/`, the host re-indexes them.

**Inside the container:**
Nothing changes architecturally. The agent just sees additional files in its mounted workspace. No new tools, no new dependencies, no network access.

### Detailed Flow

```
CURRENT:
  Message → mount group dir → spawn container → agent reads CLAUDE.md → response

ENHANCED:
  Message 
    → HOST: memsearch search against memory/*.md (calls Ollama for embeddings)
    → HOST: write results to groups/{folder}/.memory-context.md
    → mount group dir (now includes .memory-context.md + memory/)
    → spawn container
    → agent reads CLAUDE.md + .memory-context.md
    → agent writes observations to memory/YYYY-MM-DD.md
    → response
    → HOST: memsearch detects file changes, re-indexes
```

### Directory Structure (per group)

```
groups/{folder}/
├── CLAUDE.md                  # Working memory (always loaded by SDK, curated)
├── .memory-context.md         # Auto-generated before each container spawn
├── memory/                    # Long-term memory (NEW)
│   ├── MEMORY.md              # Persistent facts & key decisions
│   ├── 2026-02-15.md          # Daily observation log
│   ├── 2026-02-28.md          # Daily observation log
│   └── .memsearch.db          # Milvus Lite vector index (derived, rebuildable)
└── logs/                      # Execution logs (existing)
```

### New File: `src/memory.ts` (~100 lines)

```typescript
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { existsSync, writeFileSync, mkdirSync, statSync } from 'fs';

const MEMORY_DIR = 'memory';
const CONTEXT_FILE = '.memory-context.md';
const COMPACTION_THRESHOLD_KB = 50;

/**
 * Search group's long-term memory for relevant context.
 * Runs memsearch CLI on the HOST (not inside container).
 * memsearch calls Ollama (localhost:11434) for embeddings.
 * Writes results to .memory-context.md in the group directory.
 */
export function recallMemories(groupDir: string, query: string, topK = 5): void {
  const memoryPath = join(groupDir, MEMORY_DIR);
  const contextFile = join(groupDir, CONTEXT_FILE);

  // No memory directory yet — skip
  if (!existsSync(memoryPath)) {
    writeFileSync(contextFile, ''); 
    return;
  }

  try {
    const result = execSync(
      `memsearch search ${JSON.stringify(query)} ` +
      `--paths ${resolve(memoryPath)} --provider ollama --top-k ${topK} --format json`,
      { encoding: 'utf-8', timeout: 15000 }
    );
    const chunks = JSON.parse(result);
    if (!chunks.length) {
      writeFileSync(contextFile, '');
      return;
    }

    const contextMd = '## Relevant memories (auto-recalled)\n\n' +
      'These were retrieved from your long-term memory based on the current message.\n\n' +
      chunks.map((c: any) =>
        `**${c.source}** — ${c.heading || 'untitled'} (relevance: ${(c.score * 100).toFixed(0)}%)\n` +
        `${c.content}\n`
      ).join('\n---\n\n');

    writeFileSync(contextFile, contextMd);
  } catch (err) {
    // Fail silently — agent works fine without recalled memories
    writeFileSync(contextFile, '');
  }
}

/**
 * Re-index a group's memory directory after container execution.
 */
export function indexMemories(groupDir: string): void {
  const memoryPath = join(groupDir, MEMORY_DIR);
  if (!existsSync(memoryPath)) return;

  try {
    execSync(
      `memsearch index ${resolve(memoryPath)} --provider ollama`,
      { encoding: 'utf-8', timeout: 30000 }
    );
  } catch {
    // Non-fatal — will be indexed next time
  }
}

/**
 * Ensure memory directory exists for a group.
 */
export function ensureMemoryDir(groupDir: string): void {
  const memoryPath = join(groupDir, MEMORY_DIR);
  if (!existsSync(memoryPath)) {
    mkdirSync(memoryPath, { recursive: true });
    writeFileSync(join(memoryPath, 'MEMORY.md'),
      '# Long-Term Memory\n\nPersistent facts and key decisions for this project.\n');
  }
}

/**
 * Check for memory files exceeding size threshold.
 * Returns list of files that need compaction review.
 */
export function checkCompactionNeeded(groupDir: string): string[] {
  const memoryPath = join(groupDir, MEMORY_DIR);
  if (!existsSync(memoryPath)) return [];
  
  const flagged: string[] = [];
  // Check each .md file in memory/
  // If size > COMPACTION_THRESHOLD_KB, add to flagged list
  // (Implementation: readdir, stat each .md, compare size)
  return flagged;
}
```

### Modifications to `src/index.ts`

**In the message processing function** (around the `runAgent()` call, approximately line 121-213):

```typescript
// BEFORE (existing):
const result = await runAgent(groupFolder, prompt, chatJid, sessionId);

// AFTER (modified):
import { recallMemories, indexMemories, ensureMemoryDir } from './memory';

ensureMemoryDir(groupDir);
recallMemories(groupDir, prompt);  // Search memory, write .memory-context.md
const result = await runAgent(groupFolder, prompt, chatJid, sessionId);
indexMemories(groupDir);            // Re-index if agent wrote new memories
```

That's approximately 3-5 lines of modification in index.ts, plus the import.

### Modifications to `groups/*/CLAUDE.md`

Add these instructions to each group's CLAUDE.md (the agent reads this every session):

```markdown
## Memory System

You have two types of memory:

### Working Memory (this file — CLAUDE.md)
Keep this file concise with curated key facts, preferences, and active context.
Edit this file to update your core knowledge about this project/person.

### Long-Term Memory (memory/ directory)
After each conversation, append a dated entry to `memory/YYYY-MM-DD.md` with:
- Key facts discussed
- Decisions made  
- Data points (measurements, scores, status updates)
- Action items and follow-ups

Format:
```
## HH:MM Session
- [observation]
- [observation]
```

Before responding, check `.memory-context.md` — it contains automatically
recalled memories relevant to the current message. Reference these naturally
in your responses when relevant. If .memory-context.md is empty, proceed normally.

### Memory Hygiene
- CLAUDE.md: curated summary (~2-5KB). Remove outdated info, keep current.
- memory/MEMORY.md: permanent facts and key decisions that should always be findable.
- memory/YYYY-MM-DD.md: daily logs. These accumulate and are searchable.
```

### No Container Changes

The container image is **not modified**. No new Python packages inside it, no network access changes. The agent interacts with memory purely via filesystem reads and writes to its mounted `/workspace` directory.

### Host Prerequisites

```bash
pip install "memsearch[ollama]"
ollama pull nomic-embed-text    # embedding model for memsearch
```

### Memory Compaction

Size-based trigger with manual approval:

1. A scheduled task (or check after each agent run) calls `checkCompactionNeeded()` for each group
2. If any `memory/YYYY-MM-DD.md` file exceeds 50KB, flag it
3. Notify user via WhatsApp and/or web UI: "Memory file memory/2026-02-15.md is 67KB. Compact?"
4. On approval, run `memsearch compact` which uses an LLM (via Ollama) to summarize the file into a shorter version
5. Original file can be archived to `memory/archive/` before replacement

---

## Enhancement 2: Web UI Channel + Dashboard

### Overview

Add a web-based interface that runs alongside WhatsApp in the same Node.js process. Provides: chat with any group, memory browser with search, task viewer, and project switching.

### Architecture

```
                 ┌─ WhatsApp (baileys) ──── existing
                 │
src/index.ts ────┤
                 │
                 └─ Web UI (new) ────────── src/channels/web.ts
                    ├─ WebSocket server (chat streaming)
                    ├─ REST API endpoints (memory, groups, tasks)
                    └─ Static file server (web/ directory)
```

Everything runs in the single Node.js process. No separate server.

### New File: `src/channels/web.ts`

Responsibilities:
- **HTTP server** on configurable port (default: 18790)
- **WebSocket endpoint** (`/ws`) for streaming chat
- **Static file serving** for the frontend (`web/` directory)
- **REST API** for memory browsing, search, group listing, task viewing

```typescript
// Outline — implement with express + ws (or fastify, matching NanoClaw's style)

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

export function startWebChannel(config: {
  port: number;
  authToken: string;
  onMessage: (groupId: string, text: string) => Promise<void>;
  getGroups: () => GroupInfo[];
  // ... other callbacks
}) {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Authentication middleware
  // Static files from web/
  // REST API endpoints (see below)
  // WebSocket handler for chat streaming

  server.listen(config.port);
}
```

### REST API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/groups` | List registered groups with metadata |
| `GET` | `/api/groups/:id/messages` | Recent message history from SQLite |
| `GET` | `/api/groups/:id/memory` | List files in group's memory/ directory |
| `GET` | `/api/groups/:id/memory/search?q=...` | Semantic search via memsearch |
| `GET` | `/api/groups/:id/memory/:file` | Read a specific memory file |
| `PUT` | `/api/groups/:id/memory/:file` | Edit a memory file (triggers re-index) |
| `GET` | `/api/tasks` | List all scheduled tasks |
| `GET` | `/api/dashboard` | Aggregate stats (memory sizes, activity, costs) |

### WebSocket Protocol

```
Client → Server:
  { type: "message", groupId: "health-recovery", text: "How's my knee doing?" }
  { type: "switch_group", groupId: "work-design" }

Server → Client:
  { type: "chunk", text: "Based on your recent..." }     // Streaming response
  { type: "done", messageId: "..." }                      // Response complete
  { type: "memory_context", memories: [...] }              // What was recalled
  { type: "notification", text: "Memory file flagged..." } // Compaction alerts
```

### Web Message Integration with Existing Pipeline

Web messages must enter the **same pipeline** as WhatsApp messages. This is critical — don't create a parallel path.

**Option A (recommended): Write to SQLite, let polling loop pick up**
- `src/channels/web.ts` writes incoming messages to the same `messages` table in SQLite
- Use a synthetic JID format for web groups (e.g., `web:{groupFolder}`)
- The existing polling loop in `src/index.ts` picks them up identically to WhatsApp messages
- Responses are routed back via WebSocket instead of WhatsApp

**Modification to `src/router.ts`:**
Add a web routing case alongside WhatsApp. When `chatJid` starts with `web:`, route via WebSocket instead of baileys.

### Frontend: `web/` directory

Minimal HTML/JS/CSS. No React, no build step. Served statically.

```
web/
├── index.html          # Single page app shell
├── style.css           # Minimal styling
└── app.js              # Client-side logic
```

**Views:**
1. **Dashboard** — Group cards (name, last active, memory file count), global search bar
2. **Chat** — Group selector sidebar, streaming chat interface, memory context indicator
3. **Memory Browser** — Per-group file list, inline markdown viewer, semantic search
4. **Tasks** — List of scheduled tasks across groups, status and schedule info

**Authentication:** Token-based. Generated during setup, stored in config. Passed as query param on first load, stored in a cookie. Same pattern NanoClaw's Control UI uses.

Keep the frontend simple. It can always be upgraded later. Functional over beautiful.

### New Dependencies

Add to `package.json`:
```json
"express": "^4.x",
"ws": "^8.x"
```

These are lightweight and well-understood. No framework bloat.

---

## Modifications to `src/config.ts`

Add:
```typescript
export const WEB_PORT = parseInt(process.env.NANOCLAW_WEB_PORT || '18790');
export const WEB_AUTH_TOKEN = process.env.NANOCLAW_WEB_TOKEN || '';
export const MEMORY_SEARCH_TOP_K = 5;
export const MEMORY_COMPACTION_THRESHOLD_KB = 50;
```

---

## Complete File Change Summary

```
Modified:
  src/index.ts              +10 lines  — import memory.ts, call recall/index 
                                          around runAgent(), init web channel,
                                          start memory watchers on startup
  src/config.ts             +5 lines   — web port, auth token, memory settings
  src/router.ts             +15 lines  — route web: JIDs to WebSocket
  groups/*/CLAUDE.md        content    — add memory system instructions

Added:
  src/memory.ts             ~100 lines — recallMemories(), indexMemories(), 
                                          ensureMemoryDir(), checkCompactionNeeded()
  src/channels/web.ts       ~250 lines — HTTP server, WebSocket, REST API, 
                                          static file serving
  web/index.html            ~200 lines — SPA shell with views
  web/style.css             ~150 lines — minimal dark-theme styling  
  web/app.js                ~400 lines — client logic: chat, memory browser,
                                          group switching, search
  .claude/skills/add-semantic-memory/SKILL.md  — skill documentation
  .claude/skills/add-web-ui/SKILL.md           — skill documentation

Unchanged:
  src/channels/whatsapp.ts  — WhatsApp continues working alongside web
  src/container-runner.ts   — containers work identically
  src/task-scheduler.ts     — tasks work identically  
  src/group-queue.ts        — queue works identically
  src/ipc.ts                — IPC works identically
  src/db.ts                 — same schema (web messages use same table)
  container/*               — NO changes to container image or agent runner
```

---

## Implementation Order

### Phase 1: Get NanoClaw Running
1. Fork and clone NanoClaw
2. Run `claude` then `/setup`
3. Get basic functionality working with WhatsApp (or headless for testing)
4. Create project groups: `health-recovery`, `work-design`, `hobby-code`
5. Verify you understand the message flow end-to-end

### Phase 2: Add Semantic Memory (`/add-semantic-memory`)
1. Install memsearch and Ollama embedding model on host:
   ```bash
   pip install "memsearch[ollama]"
   ollama pull nomic-embed-text
   ```
2. Create `src/memory.ts` with `recallMemories()`, `indexMemories()`, `ensureMemoryDir()`
3. Modify `src/index.ts`:
   - Import memory.ts
   - Call `ensureMemoryDir()` for each group on startup
   - Call `recallMemories()` before `runAgent()`
   - Call `indexMemories()` after `runAgent()`
4. Update `groups/*/CLAUDE.md` with memory system instructions
5. Create initial `memory/MEMORY.md` in each group
6. Test:
   - Send messages, verify agent writes to `memory/YYYY-MM-DD.md`
   - Verify `memsearch search` returns relevant results from CLI
   - Verify `.memory-context.md` is generated before container spawn
   - Verify recalled memories appear in agent responses
7. Add compaction checking (scheduled task or post-run check)

### Phase 3: Add Web UI (`/add-web-ui`)
1. `npm install express ws`
2. Create `src/channels/web.ts` — HTTP + WebSocket server
3. Modify `src/index.ts` — initialize web channel on startup
4. Modify `src/router.ts` — route `web:` JIDs to WebSocket
5. Create `web/` directory with minimal frontend:
   - index.html (SPA shell)
   - style.css (dark theme, minimal)
   - app.js (chat, memory browser, group switching)
6. Wire REST API endpoints to existing data:
   - Groups list from `data/registered_groups.json` and `src/db.ts`
   - Messages from SQLite
   - Memory files from filesystem
   - Memory search from memsearch CLI
   - Tasks from SQLite
7. Test:
   - Chat via browser, verify messages go through same pipeline as WhatsApp
   - Switch between groups
   - Browse and search memory
   - Verify WhatsApp still works simultaneously

### Phase 4: Polish (ongoing)
- Memory compaction approval UI (web notification + confirm button)
- WhatsApp notifications for compaction flags
- Memory visualization for structured data (pain levels over time, etc.)
- Cross-project search (memsearch across all groups' memory/ dirs)
- Mobile-responsive CSS
- Cost tracking in dashboard

---

## Key Constraints

1. **Do not break container isolation.** Containers have no network. Memory search runs on the host only. The container sees results as files in its mounted workspace.

2. **Do not add services.** No separate API servers, no Docker containers for infrastructure, no databases beyond SQLite and Milvus Lite (.db file). Everything runs in the single Node.js process.

3. **Web messages use the existing pipeline.** Write to SQLite, let the polling loop pick them up. Don't create a parallel message processing path.

4. **CLAUDE.md stays as working memory.** Don't try to stuff everything into it. Keep it curated and small. Long-term observations go to `memory/`.

5. **Fail gracefully.** If memsearch is not installed, Ollama is down, or search times out — skip memory recall and proceed normally. The agent works fine without it.

6. **Keep the frontend minimal.** Vanilla HTML/JS. No build step, no bundler, no React (for now). The NanoClaw philosophy is simplicity. Upgrade later if needed.

7. **Skills pattern.** Document both enhancements as SKILL.md files in `.claude/skills/` so other NanoClaw users can apply them to their forks.

---

## Technology Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Agent runtime | NanoClaw (TypeScript/Node.js) | Fork of upstream, ~700 lines core |
| Chat model | Claude via Anthropic Agent SDK | Runs inside containers |
| Memory indexing | memsearch (Python CLI) | Runs on host only |
| Vector store | Milvus Lite | Local .db file per group, zero config |
| Embeddings | Ollama + nomic-embed-text | Runs on host, localhost:11434 |
| Message store | SQLite | Existing NanoClaw database |
| Web server | Express + ws | Added to same Node.js process |
| Frontend | Vanilla HTML/JS/CSS | No build step |
| WhatsApp | baileys | Existing, unchanged |
| Container runtime | Apple Container or Docker | Existing, unchanged |
