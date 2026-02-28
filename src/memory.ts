import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

import {
  MEMSEARCH_BIN,
  MEMORY_COMPACTION_THRESHOLD_KB,
  MEMORY_EMBEDDING_MODEL,
  MEMORY_SEARCH_TOP_K,
  OLLAMA_HOST,
} from './config.js';
import { logger } from './logger.js';

const MEMORY_DIR = 'memory';
const CONTEXT_FILE = '.memory-context.md';
const MILVUS_DB = '.memsearch.db';

interface MemChunk {
  content: string;
  source: string;
  heading?: string;
  score?: number;
}

/**
 * Ensure memory directory exists for a group, seeding MEMORY.md if new.
 */
export function ensureMemoryDir(groupDir: string): void {
  const memoryPath = join(groupDir, MEMORY_DIR);
  if (!existsSync(memoryPath)) {
    mkdirSync(memoryPath, { recursive: true });
    writeFileSync(
      join(memoryPath, 'MEMORY.md'),
      '# Persistent Memory\n\nPersistent facts and key decisions for this project.\n',
    );
    logger.info({ groupDir }, 'Created memory directory');
  }
}

/**
 * Search group's long-term memory for relevant context.
 * Runs memsearch CLI on the HOST. Writes results to .memory-context.md.
 * Fails silently — agent works fine without recalled memories.
 */
export function recallMemories(
  groupDir: string,
  query: string,
  topK = MEMORY_SEARCH_TOP_K,
): void {
  const memoryPath = join(groupDir, MEMORY_DIR);
  const contextFile = join(groupDir, CONTEXT_FILE);
  const dbPath = resolve(join(memoryPath, MILVUS_DB));

  // No memory dir or no index yet — write empty context and return
  if (!existsSync(memoryPath) || !existsSync(dbPath)) {
    writeFileSync(contextFile, '');
    return;
  }

  try {
    const result = execSync(
      `${MEMSEARCH_BIN} search ${JSON.stringify(query)} ` +
        `--provider ollama --model ${JSON.stringify(MEMORY_EMBEDDING_MODEL)} ` +
        `--milvus-uri ${JSON.stringify(dbPath)} ` +
        `--top-k ${topK} --json-output`,
      {
        encoding: 'utf-8',
        timeout: 15000,
        env: { ...process.env, OLLAMA_HOST },
      },
    );

    const chunks: MemChunk[] = JSON.parse(result);
    if (!chunks.length) {
      writeFileSync(contextFile, '');
      return;
    }

    const contextMd =
      '## Relevant memories (auto-recalled)\n\n' +
      'These were retrieved from your long-term memory based on the current message.\n\n' +
      chunks
        .map((c) => {
          const rel =
            c.score !== undefined
              ? ` (relevance: ${(c.score * 100).toFixed(0)}%)`
              : '';
          const src = c.source.split('/').slice(-2).join('/');
          return `**${src}**${rel}\n${c.content}`;
        })
        .join('\n\n---\n\n');

    writeFileSync(contextFile, contextMd);
    logger.debug({ groupDir, chunks: chunks.length }, 'Memory context written');
  } catch (err) {
    // Non-fatal — agent proceeds normally without recalled context
    logger.debug(
      { groupDir, err },
      'Memory recall skipped (memsearch unavailable or no results)',
    );
    writeFileSync(contextFile, '');
  }
}

/**
 * Re-index a group's memory directory after container execution.
 * Fails silently — will be indexed next run.
 */
export function indexMemories(groupDir: string): void {
  const memoryPath = join(groupDir, MEMORY_DIR);
  if (!existsSync(memoryPath)) return;

  const dbPath = resolve(join(memoryPath, MILVUS_DB));

  try {
    execSync(
      `${MEMSEARCH_BIN} index ${JSON.stringify(resolve(memoryPath))} ` +
        `--provider ollama --model ${JSON.stringify(MEMORY_EMBEDDING_MODEL)} ` +
        `--milvus-uri ${JSON.stringify(dbPath)}`,
      {
        encoding: 'utf-8',
        timeout: 30000,
        env: { ...process.env, OLLAMA_HOST },
      },
    );
    logger.debug({ groupDir }, 'Memory indexed');
  } catch (err) {
    logger.debug({ groupDir, err }, 'Memory indexing skipped (memsearch error)');
  }
}

/**
 * Check for memory files exceeding the compaction threshold.
 * Returns list of file paths that warrant compaction review.
 */
export function checkCompactionNeeded(groupDir: string): string[] {
  const memoryPath = join(groupDir, MEMORY_DIR);
  if (!existsSync(memoryPath)) return [];

  const flagged: string[] = [];
  try {
    for (const file of readdirSync(memoryPath)) {
      if (!file.endsWith('.md')) continue;
      const fp = join(memoryPath, file);
      try {
        const { size } = statSync(fp);
        if (size > MEMORY_COMPACTION_THRESHOLD_KB * 1024) {
          flagged.push(fp);
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // skip if directory unreadable
  }
  return flagged;
}
