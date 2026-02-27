"""
memsearch_service.py — Minimal FastAPI semantic memory search endpoint.

Indexes markdown files under /groups/{project}/memory/ using Ollama embeddings
(qwen3-embedding via 192.168.1.254:10001) and Milvus Lite for vector storage.

Endpoints:
  GET  /search?query=<str>&project=<str>&limit=<int>  -- semantic search
  POST /index/{project}                               -- re-index a project's memory files
  GET  /health                                        -- liveness check
"""

from __future__ import annotations

import glob as glob_mod
import logging

from fastapi import FastAPI, HTTPException
import uvicorn

logger = logging.getLogger("memsearch")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="memsearch", version="0.1.0")

PROJECTS = {"health", "work", "hobbies", "home-automation"}
EMBEDDING_MODEL = "qwen3-embedding:latest"


def _memory_path(project: str) -> str:
    return f"/groups/{project}/memory"


def _db_path(project: str) -> str:
    return f"/store/{project}-memory.db"


def get_searcher(project: str):
    """Return a MemSearch instance for the given project."""
    from memsearch import MemSearch

    # OLLAMA_HOST env var is set in compose.yml and read by the ollama client
    return MemSearch(
        paths=[_memory_path(project)],
        embedding_provider="ollama",
        embedding_model=EMBEDDING_MODEL,
        milvus_uri=_db_path(project),
    )


@app.get("/health")
async def health():
    return {"status": "ok", "projects": sorted(PROJECTS)}


@app.get("/search")
async def search(query: str, project: str, limit: int = 5):
    if project not in PROJECTS:
        raise HTTPException(status_code=400, detail=f"Unknown project: {project}. Valid: {sorted(PROJECTS)}")
    if not query.strip():
        return {"results": []}
    try:
        searcher = get_searcher(project)
        results = await searcher.search(query, top_k=limit)
        return {
            "results": [
                {"content": r["content"], "score": float(r.get("score", 0)), "source": r.get("source")}
                for r in results
            ]
        }
    except Exception as exc:
        logger.error("Search error for project=%s query=%r: %s", project, query, exc)
        return {"results": [], "error": str(exc)}


@app.post("/index/{project}")
async def index(project: str):
    if project not in PROJECTS:
        raise HTTPException(status_code=400, detail=f"Unknown project: {project}. Valid: {sorted(PROJECTS)}")
    mem_path = _memory_path(project)
    files = glob_mod.glob(f"{mem_path}/**/*.md", recursive=True)
    logger.info("Indexing project=%s, found %d markdown files", project, len(files))
    try:
        searcher = get_searcher(project)
        await searcher.index()
        return {"ok": True, "project": project, "files_found": len(files)}
    except Exception as exc:
        logger.error("Index error for project=%s: %s", project, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/index")
async def index_all():
    """Re-index all projects."""
    results = {}
    for project in sorted(PROJECTS):
        try:
            searcher = get_searcher(project)
            await searcher.index()
            results[project] = "ok"
        except Exception as exc:
            logger.error("Index error for project=%s: %s", project, exc)
            results[project] = f"error: {exc}"
    return results


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="info")
