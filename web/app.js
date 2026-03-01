/* NanoClaw Web UI — vanilla JS, no build step */
'use strict';

// ── Config ───────────────────────────────────────────────────────────────────
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const WS_URL = `ws://${location.host}/ws${TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''}`;

function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { 'x-auth-token': TOKEN } : {}), ...(opts.headers || {}) };
  return fetch(path, { ...opts, headers });
}

// ── State ─────────────────────────────────────────────────────────────────────
let groups = [];             // [{ jid, folder, name }]
let activeGroup = null;      // folder string
let activeView = 'dashboard';
let ws = null;
let botMsgEl = null;         // current streaming bot message element
let runningFolders = new Set(); // folders with active containers

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => console.log('[ws] connected');
  ws.onclose = () => { console.log('[ws] closed, reconnecting...'); setTimeout(connectWS, 3000); };
  ws.onerror = (e) => console.error('[ws] error', e);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'chunk') onBotChunk(msg.text);
    else if (msg.type === 'group_switched') console.log('[ws] switched to', msg.groupFolder);
    else if (msg.type === 'error') showChatError(msg.message);
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Navigation ────────────────────────────────────────────────────────────────
function showView(name) {
  activeView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  if (name === 'dashboard') loadDashboard();
  else if (name === 'tasks') loadTasks();
  else if (name === 'memory' && activeGroup) loadMemoryFiles(activeGroup);
  else if (name === 'logs' && activeGroup) loadLogs(activeGroup);
}

document.querySelectorAll('.nav-btn').forEach(b => {
  b.addEventListener('click', () => showView(b.dataset.view));
});

// ── Groups sidebar ────────────────────────────────────────────────────────────
async function loadGroups() {
  const res = await apiFetch('/api/groups');
  if (!res.ok) return;
  groups = await res.json();
  renderGroupList();
}

function renderGroupList() {
  const list = document.getElementById('group-list');
  list.innerHTML = '';
  for (const g of groups) {
    const isRunning = runningFolders.has(g.folder);
    const btn = document.createElement('button');
    btn.className = 'group-btn' + (activeGroup === g.folder ? ' active' : '');
    btn.dataset.folder = g.folder;
    btn.innerHTML = `<span class="group-dot${isRunning ? ' running' : ''}"></span>${g.name}`;
    btn.addEventListener('click', () => selectGroup(g.folder));
    list.appendChild(btn);
  }
}

function selectGroup(folder) {
  activeGroup = folder;
  renderGroupList();
  const g = groups.find(x => x.folder === folder);

  // Update badges
  document.getElementById('chat-group-badge').textContent = g?.name ?? folder;
  document.getElementById('memory-group-badge').textContent = g?.name ?? folder;

  // Enable chat
  document.getElementById('chat-input').disabled = false;
  document.getElementById('chat-send').disabled = false;

  // Switch WS group
  wsSend({ type: 'switch_group', groupFolder: folder });

  // Load view-specific data
  if (activeView === 'chat') loadChatHistory(folder);
  else if (activeView === 'memory') loadMemoryFiles(folder);
  else if (activeView === 'logs') loadLogs(folder);
  else showView('chat'); // navigate to chat on group click
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  const res = await apiFetch('/api/dashboard');
  if (!res.ok) return;
  const data = await res.json();
  const el = document.getElementById('dashboard-content');
  if (!data.groups.length) { el.innerHTML = '<div class="empty">No groups registered.</div>'; return; }
  el.innerHTML = data.groups.map(g => {
    const isRunning = runningFolders.has(g.folder);
    return `
    <div class="group-card" data-folder="${g.folder}">
      <h3>${escHtml(g.name)}${isRunning ? '<span class="running-chip">&#9679; running</span>' : ''}</h3>
      <div class="stat">&#x1F9E0; ${g.memoryFiles} memory file${g.memoryFiles !== 1 ? 's' : ''}</div>
      <div class="stat">&#x1F4BE; ${(g.memoryBytes / 1024).toFixed(1)} KB</div>
    </div>`;
  }).join('');
  el.querySelectorAll('.group-card').forEach(card => {
    card.addEventListener('click', () => { selectGroup(card.dataset.folder); showView('chat'); });
  });
}

// ── Containers ────────────────────────────────────────────────────────────────
async function pollContainers() {
  try {
    const res = await apiFetch('/api/containers');
    if (!res.ok) return;
    const containers = await res.json();
    const prev = runningFolders;
    runningFolders = new Set(containers.map(c => c.folder));
    // Only re-render if something changed
    const changed = runningFolders.size !== prev.size ||
      [...runningFolders].some(f => !prev.has(f)) ||
      [...prev].some(f => !runningFolders.has(f));
    if (changed) {
      renderGroupList();
      if (activeView === 'dashboard') loadDashboard();
    }
  } catch { /* ignore */ }
}

// ── Logs ──────────────────────────────────────────────────────────────────────
function relTime(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

async function loadLogs(folder) {
  const sidebar = document.getElementById('logs-sidebar');
  const content = document.getElementById('logs-content');
  document.getElementById('logs-group-badge').textContent = groups.find(g => g.folder === folder)?.name ?? folder;
  sidebar.innerHTML = '<div class="empty">Loading...</div>';
  content.innerHTML = '<div class="empty">Select a log entry.</div>';

  const res = await apiFetch(`/api/groups/${folder}/logs`);
  if (!res.ok) { sidebar.innerHTML = '<div class="empty">No logs.</div>'; return; }
  const entries = await res.json();
  if (!entries.length) { sidebar.innerHTML = '<div class="empty">No logs yet.</div>'; return; }

  sidebar.innerHTML = '';
  for (const e of entries) {
    const btn = document.createElement('button');
    btn.className = 'log-entry-btn';
    const exitOk = e.exitCode === '0';
    btn.innerHTML =
      `<span class="log-time">${relTime(e.timestamp)}</span>` +
      `<span class="log-exit ${exitOk ? 'ok' : 'fail'}">${exitOk ? '✓' : '✗'} ${e.exitCode}</span>` +
      `<span class="log-dur">${e.duration}</span>`;
    btn.addEventListener('click', () => loadLog(folder, e.filename, btn));
    sidebar.appendChild(btn);
  }
}

async function loadLog(folder, filename, btn) {
  document.querySelectorAll('.log-entry-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const content = document.getElementById('logs-content');
  content.innerHTML = '<div class="empty">Loading...</div>';
  const res = await apiFetch(`/api/groups/${folder}/logs/${encodeURIComponent(filename)}`);
  if (!res.ok) { content.innerHTML = '<div class="empty">Could not load log.</div>'; return; }
  const text = await res.text();
  // Colorize section headers and key: value metadata lines
  const colorized = escHtml(text)
    .replace(/^(=== .+ ===)$/gm, '<span class="log-h">$1</span>')
    .replace(/^(Timestamp|Group|IsMain|Duration|Exit Code|Stdout Truncated|Stderr Truncated): (.+)$/gm,
      '<span class="log-k">$1:</span> <span class="log-v">$2</span>');
  content.innerHTML = `<pre class="log-pre">${colorized}</pre>`;
}

document.getElementById('logs-refresh').addEventListener('click', () => {
  if (activeGroup) loadLogs(activeGroup);
});

// ── Chat ──────────────────────────────────────────────────────────────────────
async function loadChatHistory(folder) {
  const msgs = document.getElementById('chat-messages');
  msgs.innerHTML = '<div class="empty">Loading...</div>';
  const res = await apiFetch(`/api/groups/${folder}/messages`);
  if (!res.ok) { msgs.innerHTML = '<div class="empty">Could not load history.</div>'; return; }
  const history = await res.json();
  msgs.innerHTML = '';
  for (const m of history) {
    addChatMsg(m.content, m.is_bot_message ? 'bot' : 'user');
  }
  msgs.scrollTop = msgs.scrollHeight;
}

function addChatMsg(text, role, el) {
  const msgs = document.getElementById('chat-messages');
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg ' + role;
    msgs.appendChild(el);
  }
  el.textContent = text;
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}

function onBotChunk(text) {
  if (!botMsgEl) {
    botMsgEl = addChatMsg('', 'bot');
  }
  botMsgEl.textContent += text;
  document.getElementById('chat-messages').scrollTop = 9999;
}

function showChatError(msg) {
  addChatMsg('Error: ' + msg, 'bot typing');
}

function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !activeGroup) return;

  addChatMsg(text, 'user');
  botMsgEl = null;  // reset streaming target
  input.value = '';
  input.style.height = '40px';

  wsSend({ type: 'message', groupFolder: activeGroup, text });
}

document.getElementById('chat-send').addEventListener('click', sendMessage);
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
// Auto-resize textarea
document.getElementById('chat-input').addEventListener('input', function() {
  this.style.height = '40px';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// ── Memory browser ────────────────────────────────────────────────────────────
async function loadMemoryFiles(folder) {
  const sidebar = document.getElementById('memory-sidebar');
  const content = document.getElementById('memory-content');
  sidebar.innerHTML = '<div class="empty">Loading...</div>';
  content.innerHTML = '<div class="empty">Select a file.</div>';

  const res = await apiFetch(`/api/groups/${folder}/memory`);
  if (!res.ok) { sidebar.innerHTML = '<div class="empty">No memory dir.</div>'; return; }
  const files = await res.json();
  sidebar.innerHTML = '';
  for (const f of files) {
    const btn = document.createElement('button');
    btn.className = 'memory-file-btn';
    btn.textContent = f;
    btn.addEventListener('click', () => loadMemoryFile(folder, f, btn));
    sidebar.appendChild(btn);
  }
}

async function loadMemoryFile(folder, file, btn) {
  document.querySelectorAll('.memory-file-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const content = document.getElementById('memory-content');
  content.innerHTML = '<div class="empty">Loading...</div>';
  const res = await apiFetch(`/api/groups/${folder}/memory/${file}`);
  if (!res.ok) { content.innerHTML = '<div class="empty">Could not load file.</div>'; return; }
  const text = await res.text();
  content.innerHTML = `<pre>${escHtml(text)}</pre>`;
}

// Memory search
document.getElementById('memory-search-btn').addEventListener('click', doMemorySearch);
document.getElementById('memory-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doMemorySearch();
});

async function doMemorySearch() {
  if (!activeGroup) { alert('Select a group first.'); return; }
  const q = document.getElementById('memory-search-input').value.trim();
  if (!q) return;
  const content = document.getElementById('memory-content');
  content.innerHTML = '<div class="empty">Searching...</div>';
  const res = await apiFetch(`/api/groups/${activeGroup}/memory/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) { content.innerHTML = '<div class="empty">Search failed.</div>'; return; }
  const results = await res.json();
  if (!results.length) { content.innerHTML = '<div class="empty">No results.</div>'; return; }
  content.innerHTML = results.map(r => `
    <div class="search-result">
      <div class="src">${r.source?.split('/').slice(-2).join('/') ?? ''} <span class="score">${r.score !== undefined ? (r.score * 100).toFixed(0) + '%' : ''}</span></div>
      <div class="body">${escHtml(r.content)}</div>
    </div>
  `).join('');
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
async function loadTasks() {
  const content = document.getElementById('tasks-content');
  content.innerHTML = '<div class="empty">Loading...</div>';
  const res = await apiFetch('/api/tasks');
  if (!res.ok) { content.innerHTML = '<div class="empty">Could not load tasks.</div>'; return; }
  const tasks = await res.json();
  if (!tasks.length) { content.innerHTML = '<div class="empty">No scheduled tasks.</div>'; return; }
  content.innerHTML = tasks.map(t => `
    <div class="task-row">
      <div class="task-info">
        <div class="task-name">${escHtml(t.prompt.slice(0, 80))}${t.prompt.length > 80 ? '…' : ''}</div>
        <div class="task-meta">${t.group_folder} &middot; ${t.schedule_type}: ${escHtml(t.schedule_value)} &middot; next: ${t.next_run ? new Date(t.next_run).toLocaleString() : 'N/A'}</div>
      </div>
      <span class="status ${t.status}">${t.status}</span>
    </div>
  `).join('');
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
connectWS();
pollContainers();
setInterval(pollContainers, 5000);
loadGroups().then(() => {
  if (groups.length) {
    // Auto-select first group
    selectGroup(groups[0].folder);
    showView('dashboard');
  }
});
