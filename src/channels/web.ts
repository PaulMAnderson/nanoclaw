/**
 * Web channel — HTTP + WebSocket server for browser-based chat and dashboard.
 *
 * Web messages use a synthetic JID prefix "web:{groupFolder}" so they enter
 * the same SQLite → polling → container pipeline as WhatsApp messages, with
 * responses routed back via WebSocket instead of baileys.
 *
 * REST API:
 *   GET  /api/groups
 *   GET  /api/groups/:folder/messages
 *   GET  /api/groups/:folder/memory
 *   GET  /api/groups/:folder/memory/search?q=...
 *   GET  /api/groups/:folder/memory/:file
 *   PUT  /api/groups/:folder/memory/:file
 *   GET  /api/groups/:folder/logs
 *   GET  /api/groups/:folder/logs/:filename
 *   GET  /api/containers
 *   GET  /api/tasks
 *   GET  /api/dashboard
 *
 * WebSocket /ws (token via ?token=):
 *   client→server: { type:"message", groupFolder, text }
 *                | { type:"switch_group", groupFolder }
 *   server→client: { type:"chunk", text }
 *                | { type:"group_switched", groupFolder }
 *                | { type:"error", message }
 */
import { execSync } from 'child_process';
import { createServer } from 'http';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';

import express, { NextFunction, Request, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';

import {
  GROUPS_DIR,
  MEMSEARCH_BIN,
  MEMORY_EMBEDDING_MODEL,
  OLLAMA_HOST,
  WEB_AUTH_TOKEN,
  WEB_PORT,
} from '../config.js';
import { getAllTasks, getMessagesSince } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/** Synthetic JID prefix for web-originated messages */
export const WEB_JID_PREFIX = 'web:';

/** Convert a group folder name to its web channel JID */
export function webJid(groupFolder: string): string {
  return `${WEB_JID_PREFIX}${groupFolder}`;
}

/** True if a JID belongs to the web channel */
export function isWebJid(jid: string): boolean {
  return jid.startsWith(WEB_JID_PREFIX);
}

export interface WebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WebChannel implements Channel {
  name = 'web';

  // Map: groupFolder → connected WebSocket clients
  private subscribers = new Map<string, Set<WebSocket>>();
  private connected = false;
  private opts: WebChannelOpts;

  constructor(opts: WebChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const app = express();
    app.use(express.json({ limit: '2mb' }));

    // Static frontend from web/
    const webDir = resolve(process.cwd(), 'web');
    if (existsSync(webDir)) app.use(express.static(webDir));

    // Auth middleware for API routes
    const auth = (_req: Request, res: Response, next: NextFunction): void => {
      if (!WEB_AUTH_TOKEN) { next(); return; }
      const token =
        (_req.headers['x-auth-token'] as string | undefined) ||
        (_req.query['token'] as string | undefined);
      if (token !== WEB_AUTH_TOKEN) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    };
    app.use('/api', auth);

    // ─── REST endpoints ──────────────────────────────────────────────────

    app.get('/api/groups', (_req, res) => {
      const groups = this.opts.registeredGroups();
      res.json(
        Object.entries(groups)
          .filter(([jid]) => !isWebJid(jid))
          .map(([jid, g]) => ({ jid, folder: g.folder, name: g.name })),
      );
    });

    app.get('/api/groups/:folder/messages', (req, res) => {
      // Find the real JID for this folder
      const groups = this.opts.registeredGroups();
      const entry = Object.entries(groups).find(
        ([jid, g]) => g.folder === req.params.folder && !isWebJid(jid),
      );
      if (!entry) { res.status(404).json({ error: 'Group not found' }); return; }
      const [realJid] = entry;
      const msgs = getMessagesSince(realJid, '', 'Robot').slice(-100);
      res.json(msgs);
    });

    app.get('/api/groups/:folder/memory', (req, res) => {
      const memPath = join(GROUPS_DIR, req.params.folder, 'memory');
      if (!existsSync(memPath)) { res.json([]); return; }
      res.json(
        readdirSync(memPath).filter((f) => f.endsWith('.md') && !f.startsWith('.')),
      );
    });

    app.get('/api/groups/:folder/memory/search', (req, res) => {
      const q = String(req.query.q ?? '').trim();
      if (!q) { res.json([]); return; }
      const memPath = join(GROUPS_DIR, req.params.folder, 'memory');
      const dbPath = resolve(join(memPath, '.memsearch.db'));
      if (!existsSync(dbPath)) { res.json([]); return; }
      try {
        const out = execSync(
          `${MEMSEARCH_BIN} search ${JSON.stringify(q)} ` +
            `--provider ollama --model ${JSON.stringify(MEMORY_EMBEDDING_MODEL)} ` +
            `--milvus-uri ${JSON.stringify(dbPath)} ` +
            `--top-k 10 --json-output`,
          { encoding: 'utf-8', timeout: 15000, env: { ...process.env, OLLAMA_HOST } },
        );
        res.json(JSON.parse(out));
      } catch {
        res.json([]);
      }
    });

    app.get('/api/groups/:folder/memory/:file', (req, res) => {
      const safe = basename(req.params.file);
      const fp = join(GROUPS_DIR, req.params.folder, 'memory', safe);
      if (!existsSync(fp)) { res.status(404).json({ error: 'Not found' }); return; }
      res.type('text/markdown').send(readFileSync(fp, 'utf-8'));
    });

    app.put('/api/groups/:folder/memory/:file', (req, res) => {
      const safe = basename(req.params.file);
      const fp = join(GROUPS_DIR, req.params.folder, 'memory', safe);
      if (!existsSync(fp)) { res.status(404).json({ error: 'Not found' }); return; }
      const body =
        typeof req.body === 'string' ? req.body : String(req.body?.content ?? '');
      writeFileSync(fp, body, 'utf-8');
      res.json({ ok: true });
    });

    app.get('/api/tasks', (_req, res) => {
      res.json(getAllTasks());
    });

    app.get('/api/groups/:folder/logs', (req, res) => {
      const logsPath = join(GROUPS_DIR, req.params.folder, 'logs');
      if (!existsSync(logsPath)) { res.json([]); return; }
      const files = readdirSync(logsPath)
        .filter((f) => f.startsWith('container-') && f.endsWith('.log'))
        .sort().reverse();
      const entries = files.slice(0, 100).map((filename) => {
        try {
          const head = readFileSync(join(logsPath, filename), 'utf-8').slice(0, 600);
          return {
            filename,
            timestamp: head.match(/Timestamp:\s*(.+)/)?.[1]?.trim() ?? '',
            duration:  head.match(/Duration:\s*(.+)/)?.[1]?.trim() ?? '',
            exitCode:  head.match(/Exit Code:\s*(.+)/)?.[1]?.trim() ?? '',
          };
        } catch {
          return { filename, timestamp: '', duration: '', exitCode: '' };
        }
      });
      res.json(entries);
    });

    app.get('/api/groups/:folder/logs/:filename', (req, res) => {
      const safe = basename(req.params.filename);
      if (!safe.startsWith('container-') || !safe.endsWith('.log')) {
        res.status(400).json({ error: 'Invalid filename' }); return;
      }
      const fp = join(GROUPS_DIR, req.params.folder, 'logs', safe);
      if (!existsSync(fp)) { res.status(404).json({ error: 'Not found' }); return; }
      res.type('text/plain').send(readFileSync(fp, 'utf-8'));
    });

    app.get('/api/containers', (_req, res) => {
      try {
        const out = execSync(
          `docker ps --filter name=nanoclaw- --format '{{.Names}}'`,
          { encoding: 'utf-8', timeout: 5000, env: process.env },
        );
        const containers = out.trim().split('\n').filter(Boolean).map((name) => {
          const m = name.match(/^nanoclaw-(.+?)-\d+$/);
          return { name, folder: m?.[1] ?? name };
        });
        res.json(containers);
      } catch {
        res.json([]);
      }
    });

    app.get('/api/dashboard', (_req, res) => {
      const groups = this.opts.registeredGroups();
      const stats = Object.entries(groups)
        .filter(([jid]) => !isWebJid(jid))
        .map(([, g]) => {
          const memPath = join(GROUPS_DIR, g.folder, 'memory');
          let fileCount = 0;
          let totalBytes = 0;
          if (existsSync(memPath)) {
            const files = readdirSync(memPath).filter((f) => f.endsWith('.md'));
            fileCount = files.length;
            for (const f of files) {
              try { totalBytes += readFileSync(join(memPath, f)).length; } catch { /**/ }
            }
          }
          return { name: g.name, folder: g.folder, memoryFiles: fileCount, memoryBytes: totalBytes };
        });
      res.json({ groups: stats, taskCount: getAllTasks().length });
    });

    // ─── WebSocket ───────────────────────────────────────────────────────

    const server = createServer(app);
    const wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (ws, req) => {
      if (WEB_AUTH_TOKEN) {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.searchParams.get('token') !== WEB_AUTH_TOKEN) {
          ws.close(1008, 'Unauthorized');
          return;
        }
      }

      let currentFolder: string | null = null;

      const subscribe = (folder: string) => {
        if (currentFolder && currentFolder !== folder) {
          this.subscribers.get(currentFolder)?.delete(ws);
        }
        currentFolder = folder;
        if (!this.subscribers.has(folder)) this.subscribers.set(folder, new Set());
        this.subscribers.get(folder)!.add(ws);
      };

      ws.on('message', (raw) => {
        let msg: { type: string; groupFolder?: string; text?: string };
        try { msg = JSON.parse(raw.toString()); }
        catch { ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' })); return; }

        if (msg.type === 'switch_group' && msg.groupFolder) {
          subscribe(msg.groupFolder);
          ws.send(JSON.stringify({ type: 'group_switched', groupFolder: msg.groupFolder }));
          return;
        }

        if (msg.type === 'message' && msg.groupFolder && msg.text) {
          const folder = msg.groupFolder;
          const groups = this.opts.registeredGroups();

          // Find the real group entry to validate the folder exists
          const realEntry = Object.entries(groups).find(
            ([jid, g]) => g.folder === folder && !isWebJid(jid),
          );
          if (!realEntry) {
            ws.send(JSON.stringify({ type: 'error', message: `Unknown group: ${folder}` }));
            return;
          }
          const [, group] = realEntry;
          const wj = webJid(folder);

          // Subscribe this client to the group's response stream
          subscribe(folder);

          // Ensure the web chat row exists in SQLite
          this.opts.onChatMetadata(
            wj,
            new Date().toISOString(),
            `Web: ${group.name}`,
            'web',
            false,
          );

          // Inject message into SQLite under the web JID — polling loop picks it up
          const syntheticMsg: NewMessage = {
            id: `web-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            chat_jid: wj,
            sender: 'web-user',
            sender_name: 'You',
            content: msg.text,
            timestamp: new Date().toISOString(),
            is_from_me: false,
            is_bot_message: false,
          };
          this.opts.onMessage(wj, syntheticMsg);
          logger.debug({ folder }, 'Web message injected into queue');
        }
      });

      ws.on('close', () => {
        if (currentFolder) this.subscribers.get(currentFolder)?.delete(ws);
      });
    });

    server.listen(WEB_PORT, () => {
      logger.info({ port: WEB_PORT }, 'Web UI listening');
    });

    this.connected = true;
  }

  /**
   * Send response to WebSocket clients subscribed to this group.
   * Called when chatJid starts with "web:".
   */
  async sendMessage(jid: string, text: string): Promise<void> {
    const folder = jid.slice(WEB_JID_PREFIX.length);
    const clients = this.subscribers.get(folder);
    if (!clients?.size) return;
    const payload = JSON.stringify({ type: 'chunk', text });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  isConnected(): boolean { return this.connected; }
  ownsJid(jid: string): boolean { return isWebJid(jid); }
  async disconnect(): Promise<void> { this.connected = false; }
}
