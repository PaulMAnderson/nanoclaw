# NanoClaw + Memsearch + Custom Web UI — Architecture Plan

## Executive Summary

Build a personal AI assistant platform combining NanoClaw's lightweight agent runtime and container isolation with memsearch's semantic memory system, fronted by a custom web dashboard. The system supports project-scoped persistent memory (health tracking, work design reviews, hobby coding) with full semantic search across all memory, while keeping each project's context isolated at the agent level.

---

## System Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Custom Web UI                      │
│            (Next.js / React + Tailwind)              │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │   Chat    │  │  Memory  │  │  Project Switcher  │  │
│  │ Interface │  │  Browser │  │  & Dashboard       │  │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘  │
└───────┼──────────────┼─────────────────┼─────────────┘
        │              │                 │
        ▼              ▼                 ▼
┌───────────────────────────────────────────────────────┐
│               API Layer (FastAPI / Python)             │
│                                                        │
│  /chat       /memory/search    /projects    /tasks     │
│  /history    /memory/browse    /agents      /health    │
└───────┬──────────────┬─────────────────┬──────────────┘
        │              │                 │
        ▼              ▼                 ▼
┌──────────────┐ ┌───────────┐ ┌─────────────────────┐
│   NanoClaw   │ │ memsearch │ │   Ollama (local)    │
│              │ │           │ │                     │
│ Claude Agent │ │ Milvus    │ │ nomic-embed-text    │
│ SDK runtime  │ │ Lite DB   │ │ (embeddings)        │
│              │ │           │ │                     │
│ Per-project  │ │ Markdown  │ │ Optional: local LLM │
│ containers   │ │ → vectors │ │ for memory compact  │
└──────────────┘ └───────────┘ └─────────────────────┘
```

---

## Component Breakdown

### 1. NanoClaw (Agent Runtime)

**What it does:** Runs Claude agents in isolated containers with per-project filesystems, scheduled tasks (heartbeats/cron), and messaging I/O.

**What you modify:** Fork NanoClaw and add a web channel alongside (or replacing) WhatsApp. The codebase is ~500 lines of TypeScript — adding a WebSocket channel for browser-based chat is a tractable modification.

**Key changes to make:**
- Add a WebSocket server channel (skill: `/add-web-channel`) so the web UI can send/receive messages
- Each project gets its own NanoClaw group with isolated container + filesystem
- The agent's CLAUDE.md per group still works as "fast memory" — what the agent loads on every turn
- Scheduled tasks (heartbeats) continue to work as-is

**Per-project isolation looks like:**
```
~/nanoclaw/
├── projects/
│   ├── health-recovery/          # Project 1
│   │   ├── CLAUDE.md             # Agent fast-memory for this project
│   │   ├── memory/               # memsearch markdown files
│   │   │   ├── MEMORY.md         # Persistent facts & decisions
│   │   │   ├── 2026-02-15.md     # Daily logs
│   │   │   └── 2026-02-27.md
│   │   └── data/                 # Project-specific files
│   │       └── pain-log.csv
│   │
│   ├── work-design-feedback/     # Project 2
│   │   ├── CLAUDE.md
│   │   ├── memory/
│   │   └── data/
│   │
│   └── hobby-coding/             # Project 3
│       ├── CLAUDE.md
│       ├── memory/
│       └── data/
```

### 2. Memsearch (Semantic Memory Layer)

**What it does:** Indexes all those markdown files with vector embeddings, enabling semantic search like "what was my knee recovery progress in January?" across daily logs, even when the exact words don't match.

**Setup with your existing Ollama:**
```bash
pip install "memsearch[ollama]"
ollama pull nomic-embed-text
```

**Configuration** (`.memsearch.toml` per project, or global `~/.memsearch/config.toml`):
```toml
[embedding]
provider = "ollama"
model = "nomic-embed-text"

[milvus]
uri = "./memory.db"   # Milvus Lite — local file, zero config
# Or for shared access across projects:
# uri = "http://localhost:19530"  # Milvus Standalone (Docker)
```

**Integration with NanoClaw agent:**
The agent's workflow on each turn becomes:
1. **Recall** — `memsearch search` retrieves relevant memories for the current message
2. **Think** — Claude processes the message with injected memory context
3. **Remember** — agent appends observations to today's markdown log
4. **Index** — memsearch auto-indexes the new content (via file watcher)

**Python integration (in the API layer):**
```python
from memsearch import MemSearch

# One MemSearch instance per project
projects = {
    "health-recovery": MemSearch(
        paths=["./projects/health-recovery/memory/"],
        embedding_provider="ollama"
    ),
    "work-design": MemSearch(
        paths=["./projects/work-design-feedback/memory/"],
        embedding_provider="ollama"
    ),
}

# Search within a project
results = await projects["health-recovery"].search(
    "knee pain progression", top_k=5
)

# Cross-project search (create a MemSearch over all paths)
global_mem = MemSearch(
    paths=["./projects/*/memory/"],
    embedding_provider="ollama"
)
```

**Key memsearch features you'll use:**
- `memsearch watch` — background file watcher auto-indexes on changes
- `memsearch compact` — LLM-powered summarization of old memories (can use Ollama locally)
- SHA-256 dedup — unchanged content is never re-embedded
- CLI for debugging: `memsearch search "knee pain" --paths ./projects/health/memory/`

### 3. API Layer (FastAPI)

A thin Python API that bridges the web UI to both NanoClaw and memsearch. This is the orchestration point.

**Core endpoints:**

| Endpoint | Purpose |
|----------|---------|
| `POST /chat` | Send message to NanoClaw agent via WebSocket, stream response back |
| `GET /chat/history/{project}` | Retrieve conversation history from NanoClaw's SQLite |
| `GET /memory/search` | Semantic search via memsearch (project-scoped or global) |
| `GET /memory/browse/{project}` | List/read markdown memory files directly |
| `PUT /memory/{project}/{file}` | Edit a memory file (human-editable markdown) |
| `GET /projects` | List all projects with stats (memory count, last active, etc.) |
| `POST /projects` | Create new project (creates directory structure + CLAUDE.md) |
| `GET /tasks` | List scheduled tasks / heartbeats across projects |
| `POST /tasks` | Create a new scheduled task for a project's agent |
| `GET /dashboard` | Aggregated stats — memory sizes, recent activity, costs |

**Why FastAPI:** It's async-native (important for streaming chat and memsearch queries), lightweight, and you already have Python in the stack for memsearch.

### 4. Web UI (Next.js)

**Pages/views:**

#### Dashboard (Home)
- Project cards showing: name, last activity, memory count, active tasks
- Quick-switch between projects
- Global search bar (semantic search across all projects)
- Cost tracking summary (Anthropic API spend)

#### Chat View
- Project selector in sidebar
- Streaming chat interface connected via WebSocket to NanoClaw
- Memory context indicator — shows which memories were recalled for the current response
- "Pin to memory" button to manually save important facts

#### Memory Browser
- Per-project view of all markdown memory files
- Timeline view (daily logs chronologically)
- Semantic search within project or globally
- Inline markdown editor — edit memories directly, memsearch re-indexes automatically
- Memory visualization (optional): timeline chart for structured data like pain levels

#### Tasks / Scheduler
- List of all heartbeat/cron tasks across projects
- Create/edit/delete scheduled tasks
- Task execution history and logs

#### Settings
- Project management (create, archive, configure)
- Ollama model selection for embeddings
- Claude API configuration (model, temperature)
- Memory compaction settings

---

## Implementation Phases

### Phase 1: Foundation (Weekend project, ~2 days)

**Goal:** NanoClaw running with memsearch, one project, CLI-only.

1. Fork NanoClaw, set up on your machine
2. Install memsearch with Ollama embeddings
3. Create the project directory structure for one project (e.g., health-recovery)
4. Wire memsearch into NanoClaw's agent loop:
   - Before each response: search memsearch for relevant context
   - After each response: append summary to daily markdown log
   - Run `memsearch watch` as a background process
5. Test via NanoClaw's existing channels (WhatsApp or headless mode)

**Deliverable:** Working agent with semantic memory, no web UI yet.

### Phase 2: API Layer (~1-2 days)

**Goal:** FastAPI server exposing chat and memory operations.

1. Set up FastAPI project
2. Implement WebSocket bridge to NanoClaw's agent
3. Implement memsearch search/browse endpoints
4. Implement project listing and creation
5. Add basic auth (token-based, local only)

**Deliverable:** All operations available via HTTP API, testable with curl/Postman.

### Phase 3: Web UI Core (~3-5 days)

**Goal:** Functional web dashboard with chat and memory browsing.

1. Next.js project with Tailwind CSS
2. Dashboard page with project cards
3. Chat interface with WebSocket streaming
4. Memory browser with search
5. Project switching

**Deliverable:** Usable web interface for daily interaction.

### Phase 4: Polish & Extensions (Ongoing)

- Memory visualization (charts for health data)
- Task/scheduler management UI
- Memory compaction controls
- Cross-project search
- Mobile-responsive design
- Optional: OpenRouter integration for model switching in the UI

---

## Tech Stack Summary

| Component | Technology | Reason |
|-----------|-----------|--------|
| Agent runtime | NanoClaw (TypeScript) | Lightweight, container isolation, Claude Agent SDK |
| Memory indexing | memsearch (Python) | Markdown-first, semantic search, Ollama support |
| Vector store | Milvus Lite | Zero-config local file DB, upgradable to standalone |
| Embeddings | Ollama + nomic-embed-text | Local, free, already in your stack |
| API server | FastAPI (Python) | Async, lightweight, same language as memsearch |
| Web UI | Next.js + React + Tailwind | Fast to build, good DX, SSR for dashboard |
| Chat model | Claude via Anthropic API | Via NanoClaw's Claude Agent SDK |
| Message store | SQLite | Already used by NanoClaw for message queuing |

---

## Key Design Decisions & Trade-offs

**Markdown as source of truth for memory** — This is memsearch's core philosophy and it's the right call for your use case. You can `git init` your projects directory and version-control your entire memory. If the vector index corrupts, rebuild it in minutes. You can edit memories with any text editor. The trade-off is that markdown files are less structured than a proper database for things like pain-level time series — for that, consider having the agent maintain structured data files (JSON/CSV) alongside the markdown logs.

**Milvus Lite vs. Standalone** — Start with Lite (local .db file). It's zero-config and sufficient for personal use. If you eventually want multiple agents or users hitting the same memory, upgrade to Milvus Standalone (Docker one-liner). The code change is literally one line in the config.

**FastAPI as the bridge** — NanoClaw is TypeScript, memsearch is Python. Rather than rewriting either, a thin Python API layer that talks to both is the pragmatic choice. The TypeScript↔Python boundary is the WebSocket connection to NanoClaw's agent, which is clean.

**Why not just use OpenWebUI?** — You could bolt memsearch onto OpenWebUI via a pipeline filter, but you'd lose NanoClaw's container isolation, scheduled tasks, and the agent autonomy features you said you wanted. The custom web UI is more work but gives you exactly the interface you need.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| NanoClaw's WebSocket channel doesn't exist yet | The codebase is 500 lines; adding a WS channel is documented as a skill-based modification. Claude Code can generate it. |
| memsearch + Ollama embeddings performance | nomic-embed-text is fast on modern hardware. Index once, search is milliseconds. Compaction can run on schedule. |
| Scope creep on the web UI | Phase 3 is deliberately minimal. Ship a chat box + memory browser first. Add charts and polish later. |
| NanoClaw upstream changes break your fork | Pin your fork to a specific commit. NanoClaw's philosophy encourages divergent forks. |
| Claude API costs for heartbeat/scheduled tasks | Configure task frequency conservatively. Use cheaper models (Haiku) for routine checks. Monitor via dashboard. |

---

## Getting Started (First Session)

```bash
# 1. Fork and clone NanoClaw
git clone https://github.com/YOUR_USERNAME/nanoclaw.git
cd nanoclaw
claude   # Claude Code guides setup

# 2. Install memsearch with Ollama
pip install "memsearch[ollama]"
ollama pull nomic-embed-text

# 3. Create first project structure
mkdir -p projects/health-recovery/{memory,data}
echo "# Health Recovery Project\n\nTracking knee injury recovery.\n" \
  > projects/health-recovery/CLAUDE.md
echo "# Persistent Memory\n\n## Key Facts\n- Started recovery: Feb 2026\n" \
  > projects/health-recovery/memory/MEMORY.md

# 4. Test memsearch indexing
memsearch index ./projects/health-recovery/memory/
memsearch search "recovery timeline" --paths ./projects/health-recovery/memory/

# 5. Start the file watcher
memsearch watch ./projects/health-recovery/memory/ &
```
