// term.ai：移动端 AI 终端（对话 / 代码生成 / 联网搜索）

/* ---------- 工具 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '');
const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

const log = $('#log'), input = $('#input'), form = $('#form'), sendBtn = $('#send'), cmdsEl = $('#cmds');
const drawer = $('#drawer'), scrim = $('#scrim'), dlg = $('#settings'), pv = $('#preview');
const coarse = matchMedia('(pointer: coarse)').matches;

/* ---------- 存储：IndexedDB 存会话 ---------- */
const wrapReq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idb = await (async () => {
  try {
    const open = indexedDB.open('termai', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('sessions', { keyPath: 'id' });
    const db = await wrapReq(open);
    const store = (mode) => db.transaction('sessions', mode).objectStore('sessions');
    return {
      all: () => wrapReq(store('readonly').getAll()),
      put: (s) => wrapReq(store('readwrite').put(s)),
      del: (id) => wrapReq(store('readwrite').delete(id)),
    };
  } catch {
    console.warn('IndexedDB 不可用，会话不会保存');
    return { all: async () => [], put: async () => {}, del: async () => {} };
  }
})();

/* ---------- 配置 ---------- */
const TEMPLATES = {
  openai: { name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  deepseek: { name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openrouter: { name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  ollama: { name: 'Ollama', type: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
};
const CFG_KEY = 'termai.cfg', KEYS_KEY = 'termai.keys';
const CODE_SYS = '你现在是代码助手。优先给出完整、可直接运行的代码，放在带语言标注的代码块中；解释保持简短；除非用户要求，不要用省略号省略代码。';

function defaultCfg() {
  const p = { id: uid(), ...TEMPLATES.openai, apiKey: '' };
  return {
    providers: [p], active: p.id,
    search: { type: 'none', endpoint: '', apiKey: '' },
    proxy: { url: '', token: '' },
    system: '', temperature: 0.7, maxTokens: 4096,
    remember: true, theme: 'dark', web: false, code: false,
  };
}

function loadCfg() {
  const d = defaultCfg();
  let c = null;
  try { c = JSON.parse(localStorage.getItem(CFG_KEY)); } catch {}
  c = { ...d, ...(c || {}) };
  c.search = { ...d.search, ...c.search };
  c.proxy = { ...d.proxy, ...c.proxy };
  if (!c.providers?.length) { c.providers = d.providers; c.active = d.active; }
  if (!c.remember) {
    // 未勾选"保存 Key"时，Key 只放在 sessionStorage
    let k = {};
    try { k = JSON.parse(sessionStorage.getItem(KEYS_KEY)) || {}; } catch {}
    c.providers.forEach((p) => (p.apiKey = k.p?.[p.id] || ''));
    c.search.apiKey = k.s || '';
    c.proxy.token = k.x || '';
  }
  return c;
}

function saveCfg() {
  const c = structuredClone(cfg);
  if (!c.remember) {
    sessionStorage.setItem(KEYS_KEY, JSON.stringify({
      p: Object.fromEntries(c.providers.map((p) => [p.id, p.apiKey])),
      s: c.search.apiKey, x: c.proxy.token,
    }));
    c.providers.forEach((p) => (p.apiKey = ''));
    c.search.apiKey = '';
    c.proxy.token = '';
  } else {
    sessionStorage.removeItem(KEYS_KEY);
  }
  localStorage.setItem(CFG_KEY, JSON.stringify(c));
}

let cfg = loadCfg();
const activeProvider = () => cfg.providers.find((p) => p.id === cfg.active) || cfg.providers[0];

/* ---------- 网络 ---------- */
// 配置了代理时，所有外部请求经 Worker 转发
function xfetch(url, opts = {}) {
  if (!cfg.proxy.url) return fetch(url, opts);
  const headers = new Headers(opts.headers);
  headers.set('X-Target-URL', url);
  if (cfg.proxy.token) headers.set('X-Proxy-Token', cfg.proxy.token);
  return fetch(cfg.proxy.url, { ...opts, headers });
}

async function ensureOk(res) {
  if (res.ok) return res;
  let msg = '';
  try { msg = await res.text(); } catch {}
  try { const j = JSON.parse(msg); msg = j.error?.message || j.message || j.detail || msg; } catch {}
  throw new Error(`HTTP ${res.status} ${String(msg).slice(0, 300)}`);
}

// 解析 SSE 流，逐条产出 JSON
async function* sse(res) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch {}
    }
  }
}

// 统一的流式对话接口，产出 {text} 或 {usage}
async function* streamChat(messages, system, signal) {
  const p = activeProvider();
  if (!p) throw new Error('未配置模型');
  const base = p.baseUrl.replace(/\/+$/, '');

  if (p.type === 'anthropic') {
    const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    const headers = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (p.apiKey) headers['x-api-key'] = p.apiKey;
    const res = await ensureOk(await xfetch(url, {
      method: 'POST', signal, headers,
      body: JSON.stringify({
        model: p.model, max_tokens: cfg.maxTokens, temperature: cfg.temperature,
        ...(system ? { system } : {}), messages, stream: true,
      }),
    }));
    for await (const e of sse(res)) {
      if (e.type === 'content_block_delta' && e.delta?.text) yield { text: e.delta.text };
      else if (e.type === 'message_start') yield { usage: e.message?.usage?.input_tokens || 0 };
      else if (e.type === 'message_delta') yield { usage: e.usage?.output_tokens || 0 };
      else if (e.type === 'error') throw new Error(e.error?.message || 'stream error');
    }
    return;
  }

  const headers = { 'content-type': 'application/json' };
  if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
  const res = await ensureOk(await xfetch(`${base}/chat/completions`, {
    method: 'POST', signal, headers,
    body: JSON.stringify({
      model: p.model,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
      temperature: cfg.temperature, max_tokens: cfg.maxTokens,
      stream: true, stream_options: { include_usage: true },
    }),
  }));
  for await (const e of sse(res)) {
    if (e.error) throw new Error(e.error.message || 'stream error');
    const t = e.choices?.[0]?.delta?.content;
    if (t) yield { text: t };
    if (e.usage?.total_tokens) yield { usage: e.usage.total_tokens };
  }
}

/* ---------- 搜索 ---------- */
async function search(q, signal) {
  const s = cfg.search;
  const clip = (t) => stripTags(t).replace(/\s+/g, ' ').slice(0, 300);

  if (s.type === 'tavily') {
    const headers = { 'content-type': 'application/json' };
    if (s.apiKey) headers.authorization = `Bearer ${s.apiKey}`;
    const res = await ensureOk(await xfetch('https://api.tavily.com/search', {
      method: 'POST', signal, headers, body: JSON.stringify({ query: q, max_results: 5 }),
    }));
    const d = await res.json();
    return (d.results || []).map((r) => ({ title: r.title, url: r.url, snippet: clip(r.content) }));
  }
  if (s.type === 'brave') {
    const headers = { accept: 'application/json' };
    if (s.apiKey) headers['x-subscription-token'] = s.apiKey;
    const url = `https://api.search.brave.com/res/v1/web/search?count=5&q=${encodeURIComponent(q)}`;
    const res = await ensureOk(await xfetch(url, { signal, headers }));
    const d = await res.json();
    return (d.web?.results || []).map((r) => ({ title: stripTags(r.title), url: r.url, snippet: clip(r.description) }));
  }
  if (s.type === 'searxng') {
    if (!s.endpoint) throw new Error('未填写 SearXNG 地址');
    const url = `${s.endpoint.replace(/\/+$/, '')}/search?format=json&q=${encodeURIComponent(q)}`;
    const res = await ensureOk(await xfetch(url, { signal }));
    const d = await res.json();
    return (d.results || []).slice(0, 5).map((r) => ({ title: r.title, url: r.url, snippet: clip(r.content) }));
  }
  throw new Error('未配置搜索引擎，请在设置中选择');
}

const webCtx = (rs) =>
  `以下是针对用户最新问题的联网搜索结果（今天是 ${new Date().toLocaleDateString('zh-CN')}）。` +
  '请结合这些信息回答，引用时标注 [编号]，不要编造来源：\n\n' +
  rs.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');

/* ---------- 渲染 ---------- */
const hasMd = !!(window.marked && window.DOMPurify);
if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', (n) => {
    if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
  });
}
// Markdown 经 DOMPurify 过滤后再插入，防 XSS
const md = (t) => (hasMd ? DOMPurify.sanitize(marked.parse(t || '', { gfm: true, breaks: true })) : `<pre>${esc(t)}</pre>`);

const EXT = {
  javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', jsx: 'jsx', tsx: 'tsx', python: 'py', py: 'py',
  html: 'html', htm: 'html', css: 'css', json: 'json', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh',
  go: 'go', rust: 'rs', rs: 'rs', java: 'java', kotlin: 'kt', swift: 'swift', c: 'c', cpp: 'cpp', 'c++': 'cpp',
  csharp: 'cs', cs: 'cs', ruby: 'rb', php: 'php', sql: 'sql', yaml: 'yml', yml: 'yml', markdown: 'md', md: 'md',
  vue: 'vue', xml: 'xml', svg: 'svg', lua: 'lua', dart: 'dart', toml: 'toml', dockerfile: 'Dockerfile',
};

function enhance(root, final) {
  root.querySelectorAll('.md pre > code').forEach((code) => {
    const pre = code.parentElement;
    const lang = ((code.className.match(/language-(\S+)/) || [])[1] || '').toLowerCase();
    if (final && window.hljs) { try { hljs.highlightElement(code); } catch {} }
    const wrap = document.createElement('div');
    wrap.className = 'cb';
    wrap.dataset.lang = lang;
    wrap.innerHTML = `<div class="cb-bar"><span>${esc(lang || 'text')}</span>` +
      '<button type="button" data-cb="copy">copy</button><button type="button" data-cb="save">save</button>' +
      (/^(html|htm|svg)$/.test(lang) ? '<button type="button" data-cb="run">run</button>' : '') + '</div>';
    pre.replaceWith(wrap);
    wrap.append(pre);
  });
}

const srcList = (rs, snip) => `<ol class="src">${rs.map((r) =>
  `<li><a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer">${esc(r.title || r.url)}</a> ` +
  `<span class="dim">${esc(host(r.url))}</span>${snip && r.snippet ? `<div class="dim snip">${esc(r.snippet)}</div>` : ''}</li>`
).join('')}</ol>`;

function actions(m) {
  const b = (a, t) => `<button type="button" data-m="${a}" data-id="${m.id}">${t}</button>`;
  const set = m.role === 'user' ? b('copy', 'copy') + b('edit', 'edit') + b('del', 'del')
    : m.role === 'assistant' ? b('copy', 'copy') + b('retry', 'retry') + b('del', 'del')
    : m.role === 'search' ? b('copy', 'copy') + b('del', 'del') : b('del', 'del');
  return `<nav class="acts" aria-label="消息操作">${set}</nav>`;
}

function fillMsg(el, m, final) {
  let h = '';
  if (m.role === 'user') {
    h = `<div class="u"><span aria-hidden="true">&gt;</span><div class="txt">${esc(m.content)}</div></div>`;
  } else if (m.role === 'assistant') {
    if (m.content) h += `<div class="md">${md(m.content)}</div>`;
    else if (!final) h += `<div class="dim">${esc(m.status || '…')}</div>`;
    if (m.warn) h += `<div class="err">! ${esc(m.warn)}</div>`;
    if (m.sources?.length) h += srcList(m.sources, false);
    if (m.error) h += `<div class="err">! ${esc(m.error)}</div>`;
  } else if (m.role === 'search') {
    h = `<div class="dim">search: ${esc(m.query)}</div>`;
    if (m.pending) h += '<div class="dim">…</div>';
    else if (m.error) h += `<div class="err">! ${esc(m.error)}</div>`;
    else h += m.results.length ? srcList(m.results, true) : '<div class="dim">无结果</div>';
  } else {
    h = `<pre class="note">${esc(m.content)}</pre>`;
  }
  if (final) h += actions(m);
  el.innerHTML = h;
  el.classList.toggle('streaming', !final && !!m.content);
  enhance(el, final);
}

function msgNode(m) {
  const el = document.createElement('article');
  el.className = `msg ${m.role}`;
  el.dataset.id = m.id;
  fillMsg(el, m, !m.pending);
  return el;
}

function welcome() {
  const p = activeProvider();
  const need = !p || (!p.apiKey && !cfg.proxy.url && !/localhost|127\.0\.0\.1/.test(p.baseUrl));
  return `<div class="welcome dim"><div class="logo">term.ai</div><div>输入消息开始对话，输入 / 查看命令</div>` +
    (need ? '<div class="err">尚未配置 API Key，点右上角 ⚙ 设置</div>' : '') + '</div>';
}

let stick = true;
log.addEventListener('scroll', () => { stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80; });
function scrollEnd(force) { if (force || stick) log.scrollTop = log.scrollHeight; }

function render() {
  log.innerHTML = cur.messages.length ? '' : welcome();
  cur.messages.forEach((m) => log.append(msgNode(m)));
  updateBar();
  scrollEnd(true);
}
function appendMsg(m) { log.querySelector('.welcome')?.remove(); log.append(msgNode(m)); scrollEnd(true); }
function refresh(m, final = true) { const el = log.querySelector(`[data-id="${m.id}"]`); if (el) fillMsg(el, m, final); }

// 流式输出时用 rAF 节流重绘
let raf = 0;
function paint(m) {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; refresh(m, false); scrollEnd(); });
}

function updateBar() {
  const p = activeProvider();
  $('#st-model').textContent = p ? p.model || p.name : '未配置';
  const w = $('#st-web');
  w.textContent = `web:${cfg.web ? 'on' : 'off'}`;
  w.setAttribute('aria-pressed', String(cfg.web));
  $('#st-tok').textContent = `${fmtTok(cur?.tokens || 0)} tok`;
  document.querySelectorAll('[data-chip=web],[data-chip=code]').forEach((b) =>
    b.setAttribute('aria-pressed', String(!!cfg[b.dataset.chip])));
}

let toastT;
function toast(t) {
  const el = $('#toast');
  el.textContent = t;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---------- 会话 ---------- */
let sessions = [], cur = null, busy = false, ctrl = null;

function newSession() {
  if (cur && !cur.messages.length) { render(); return; }
  cur = { id: uid(), title: '新会话', messages: [], tokens: 0, updated: Date.now() };
  sessions.unshift(cur);
  render();
}
async function persist(s = cur) {
  s.updated = Date.now();
  try { await idb.put(s); } catch (e) { console.warn(e); }
}

// 组装发给模型的历史，合并相邻同角色消息（Anthropic 要求交替）
function apiMessages(s, uptoId) {
  const out = [];
  for (const m of s.messages) {
    if (m.id === uptoId) break;
    if ((m.role !== 'user' && m.role !== 'assistant') || !m.content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function setBusy(b) {
  busy = b;
  sendBtn.classList.toggle('busy', b);
  sendBtn.textContent = b ? '■' : '↵';
  sendBtn.setAttribute('aria-label', b ? '停止生成' : '发送');
}

async function runAssistant(s, a) {
  const history = apiMessages(s, a.id);
  if (!history.length) { a.error = '没有可发送的用户消息'; refresh(a); return; }
  setBusy(true);
  ctrl = new AbortController();
  Object.assign(a, { content: '', error: '', warn: '', sources: null });
  let used = 0;
  try {
    let system = [cfg.system, cfg.code ? CODE_SYS : ''].filter(Boolean).join('\n\n');
    if (cfg.web) {
      a.status = 'searching…'; paint(a);
      try {
        const q = [...history].reverse().find((m) => m.role === 'user').content.slice(0, 400);
        a.sources = await search(q, ctrl.signal);
        if (a.sources.length) system = [system, webCtx(a.sources)].filter(Boolean).join('\n\n');
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        a.warn = `搜索失败：${e.message}`;
      }
    }
    a.status = 'waiting…'; paint(a);
    for await (const ev of streamChat(history, system, ctrl.signal)) {
      if (ev.text) { a.content += ev.text; paint(a); }
      if (ev.usage) used += ev.usage;
    }
  } catch (e) {
    if (e.name === 'AbortError') a.error = '已中断';
    else a.error = e instanceof TypeError ? `${e.message}（可能是网络或 CORS 问题，可在设置中配置代理）` : e.message || String(e);
  } finally {
    delete a.status;
    cancelAnimationFrame(raf); raf = 0;
    // 服务商不返回用量时按字符粗略估算
    s.tokens = (s.tokens || 0) + (used || Math.ceil((JSON.stringify(history).length + a.content.length) / 4));
    setBusy(false);
    refresh(a, true);
    scrollEnd();
    updateBar();
    await persist(s);
  }
}

async function send(text) {
  if (busy) return toast('正在生成…');
  const s = cur;
  const u = { id: uid(), role: 'user', content: text };
  s.messages.push(u);
  appendMsg(u);
  if (s.title === '新会话') s.title = text.replace(/\s+/g, ' ').slice(0, 40);
  const a = { id: uid(), role: 'assistant', content: '', pending: true };
  s.messages.push(a);
  appendMsg(a);
  delete a.pending;
  await runAssistant(s, a);
}

async function doSearch(q) {
  const m = { id: uid(), role: 'search', query: q, results: [], pending: true };
  cur.messages.push(m);
  appendMsg(m);
  try { m.results = await search(q); } catch (e) { m.error = e.message; }
  delete m.pending;
  refresh(m);
  scrollEnd();
  if (cur.title === '新会话') cur.title = `search: ${q}`.slice(0, 40);
  await persist();
}

/* ---------- 命令 ---------- */
const COMMANDS = [
  ['/new', '新会话'], ['/model', '切换模型'], ['/search', '<关键词> 搜索'], ['/code', '<语言> <需求> 生成代码'],
  ['/web', '联网开关'], ['/sys', '编辑 System Prompt'], ['/export', '导出 Markdown'],
  ['/clear', '清空当前会话'], ['/theme', '切换主题'], ['/help', '帮助'],
];
const NOARG = new Set(['/new', '/model', '/web', '/sys', '/export', '/clear', '/theme', '/help']);
const HELP = COMMANDS.map(([c, d]) => c.padEnd(9) + d).join('\n') +
  '\n\n桌面端 Enter 发送，Shift+Enter 换行；手机端点 ↵ 发送。\n左边缘右滑打开会话列表。';

function toggle(k) {
  cfg[k] = !cfg[k];
  saveCfg();
  updateBar();
  if (k === 'web' && cfg.web && cfg.search.type === 'none') toast('请先在设置中配置搜索引擎');
  else toast(`${k === 'web' ? '联网' : '代码模式'}：${cfg[k] ? '开' : '关'}`);
}

function applyTheme() {
  document.documentElement.dataset.theme = cfg.theme;
  $('#hl-theme').href = `https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github${cfg.theme === 'light' ? '' : '-dark'}.min.css`;
  $('meta[name=theme-color]').content = cfg.theme === 'light' ? '#fafafa' : '#0d0f12';
}

function exportMd() {
  const body = cur.messages.map((m) => {
    if (m.role === 'user') return `> ${m.content.replace(/\n/g, '\n> ')}`;
    if (m.role === 'assistant') return m.content + (m.sources?.length ? '\n\n' + m.sources.map((r, i) => `[${i + 1}] ${r.title} ${r.url}`).join('\n') : '');
    if (m.role === 'search') return `**search:** ${m.query}\n\n` + m.results.map((r, i) => `${i + 1}. [${r.title}](${r.url})`).join('\n');
    return '';
  }).filter(Boolean).join('\n\n---\n\n');
  download(`${cur.title.replace(/[\\/:*?"<>|]/g, '_')}.md`, `# ${cur.title}\n\n${body}\n`);
}

async function runCmd(t) {
  const c = t.split(/\s+/)[0].toLowerCase();
  const arg = t.slice(c.length).trim();
  switch (c) {
    case '/new': newSession(); break;
    case '/clear':
      if (busy) return toast('正在生成…');
      cur.messages = []; cur.tokens = 0; await persist(); render(); break;
    case '/model': {
      if (!arg) return pickModel();
      const p = cfg.providers.find((x) => x.name.toLowerCase() === arg.toLowerCase() || x.model === arg);
      if (!p) return toast(`未找到：${arg}`);
      cfg.active = p.id; saveCfg(); updateBar(); toast(`→ ${p.name} · ${p.model}`); break;
    }
    case '/search':
      if (!arg) return toast('用法：/search 关键词');
      doSearch(arg); break;
    case '/code': {
      const m = arg.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) return toast('用法：/code 语言 需求');
      send(`用 ${m[1]} 实现：${m[2]}\n\n要求：给出完整可运行的代码，放在一个 ${m[1]} 代码块中，说明尽量简短。`); break;
    }
    case '/web': toggle('web'); break;
    case '/sys': openSettings('g-sys'); break;
    case '/export': exportMd(); break;
    case '/theme': cfg.theme = cfg.theme === 'dark' ? 'light' : 'dark'; applyTheme(); saveCfg(); break;
    case '/help': { const m = { id: uid(), role: 'note', content: HELP }; cur.messages.push(m); appendMsg(m); break; }
    default: toast(`未知命令：${c}`);
  }
}

/* ---------- 输入 & 补全 ---------- */
function grow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, innerHeight * 0.4)}px`;
}
function hideCmds() { cmdsEl.hidden = true; cmdsEl.innerHTML = ''; }
function showCmds(items) {
  if (!items.length) return hideCmds();
  cmdsEl.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.innerHTML = `<b>${esc(it.label)}</b> <span class="dim">${esc(it.desc || '')}</span>`;
    b.onclick = it.run;
    cmdsEl.append(b);
  }
  cmdsEl.hidden = false;
}

function pickModel() {
  showCmds(cfg.providers.map((p) => ({
    label: p.name || '(未命名)',
    desc: `${p.model}${p.id === cfg.active ? '  ●' : ''}`,
    run: () => { cfg.active = p.id; saveCfg(); updateBar(); hideCmds(); toast(`→ ${p.name} · ${p.model}`); },
  })));
}

function lastCode() {
  for (let i = cur.messages.length - 1; i >= 0; i--) {
    const m = cur.messages[i];
    if (m.role !== 'assistant' || !m.content) continue;
    const blocks = [...m.content.matchAll(/```([\w+#.-]*)\n([\s\S]*?)```/g)];
    if (blocks.length) { const b = blocks[blocks.length - 1]; return { lang: b[1], code: b[2] }; }
  }
  return null;
}
function attachCode() {
  const c = lastCode();
  if (!c) return toast('没有找到代码块');
  input.value = `${input.value ? input.value + '\n' : ''}\`\`\`${c.lang}\n${c.code}\`\`\`\n`;
  grow();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

input.addEventListener('input', () => {
  grow();
  const v = input.value;
  if (/^\/\S*$/.test(v)) {
    showCmds(COMMANDS.filter(([c]) => c.startsWith(v.toLowerCase())).map(([c, d]) => ({
      label: c, desc: d,
      run: () => {
        hideCmds();
        if (NOARG.has(c)) { input.value = ''; grow(); runCmd(c); }
        else { input.value = `${c} `; input.focus(); }
      },
    })));
  } else if (!cmdsEl.hidden && v) {
    hideCmds();
  }
});

input.addEventListener('keydown', (e) => {
  if (e.isComposing) return; // 中文输入法组词中
  if (e.key === 'Tab' && !cmdsEl.hidden) { e.preventDefault(); cmdsEl.querySelector('button')?.click(); }
  else if (e.key === 'Escape') hideCmds();
  else if (e.key === 'Enter' && !e.shiftKey && !coarse) { e.preventDefault(); form.requestSubmit(); }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) { ctrl?.abort(); return; }
  const t = input.value.trim();
  if (!t) return;
  input.value = '';
  grow();
  hideCmds();
  if (t.startsWith('/')) runCmd(t); else send(t);
});

// 点击快捷栏、补全菜单时不让输入框失焦（避免键盘收起）
['#chips', '#cmds'].forEach((s) => $(s).addEventListener('mousedown', (e) => e.preventDefault()));
document.addEventListener('pointerdown', (e) => {
  if (!cmdsEl.hidden && !cmdsEl.contains(e.target) && e.target !== input && !e.target.closest('#chips,#st-model')) hideCmds();
});

/* ---------- 消息 & 代码块操作 ---------- */
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('已复制');
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

log.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;

  if (b.dataset.cb) {
    const wrap = b.closest('.cb');
    const code = wrap.querySelector('code').textContent;
    const lang = wrap.dataset.lang;
    if (b.dataset.cb === 'copy') copyText(code);
    else if (b.dataset.cb === 'save') {
      const ext = EXT[lang] || 'txt';
      download(ext === 'Dockerfile' ? 'Dockerfile' : `code.${ext}`, code);
    } else if (b.dataset.cb === 'run') { $('#pv-frame').srcdoc = code; pv.showModal(); }
    return;
  }

  const act = b.dataset.m;
  if (!act) return;
  const i = cur.messages.findIndex((m) => m.id === b.dataset.id);
  if (i < 0) return;
  const m = cur.messages[i];
  if (act === 'copy') {
    return copyText(m.role === 'search' ? m.results.map((r) => `${r.title}\n${r.url}`).join('\n\n') : m.content);
  }
  if (busy) return toast('正在生成…');
  const hasAfter = i < cur.messages.length - 1;

  if (act === 'del') {
    cur.messages.splice(i, 1);
  } else if (act === 'edit') {
    if (hasAfter && !confirm('编辑后将删除此后的消息，继续？')) return;
    cur.messages.splice(i);
    input.value = m.content; grow(); input.focus();
  } else if (act === 'retry') {
    if (hasAfter && !confirm('将删除此后的消息并重新生成，继续？')) return;
    cur.messages.splice(i);
    const a = { id: uid(), role: 'assistant', content: '' };
    cur.messages.push(a);
    render();
    return runAssistant(cur, a);
  }
  await persist();
  render();
});

$('#pv-close').onclick = () => pv.close();
pv.addEventListener('close', () => { $('#pv-frame').srcdoc = ''; });

/* ---------- 顶栏 & 快捷栏 ---------- */
$('#btn-menu').onclick = () => openDrawer();
$('#btn-set').onclick = () => openSettings();
$('#btn-theme').onclick = () => runCmd('/theme');
$('#st-model').onclick = pickModel;
$('#st-web').onclick = () => toggle('web');
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  ({
    web: () => toggle('web'),
    code: () => toggle('code'),
    model: pickModel,
    attach: attachCode,
    new: () => runCmd('/new'),
    slash: () => { input.value = '/'; input.dispatchEvent(new Event('input')); input.focus(); },
  })[b.dataset.chip]?.();
});

/* ---------- 会话抽屉 ---------- */
function renderDrawer() {
  const q = $('#d-q').value.trim().toLowerCase();
  const fmt = (t) => new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const list = sessions
    .filter((s) => s.messages.length || s === cur)
    .filter((s) => !q || s.title.toLowerCase().includes(q) ||
      s.messages.some((m) => (m.content || m.query || '').toLowerCase().includes(q)));
  $('#d-list').innerHTML = list.map((s) =>
    `<li class="${s === cur ? 'on' : ''}">` +
    `<button class="d-open" data-d="open" data-id="${s.id}"><span>${esc(s.title)}</span><small class="dim">${fmt(s.updated)}</small></button>` +
    `<button data-d="ren" data-id="${s.id}" aria-label="重命名 ${esc(s.title)}">✎</button>` +
    `<button data-d="del" data-id="${s.id}" aria-label="删除 ${esc(s.title)}">×</button></li>`
  ).join('') || '<li class="dim empty">无会话</li>';
}
function openDrawer() {
  renderDrawer();
  drawer.classList.add('open');
  drawer.inert = false;
  scrim.hidden = false;
  if (!coarse) $('#d-q').focus();
}
function closeDrawer() {
  drawer.classList.remove('open');
  drawer.inert = true;
  scrim.hidden = true;
}

$('#d-list').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const s = sessions.find((x) => x.id === b.dataset.id);
  if (!s) return;
  if (b.dataset.d === 'open') {
    cur = s; render(); closeDrawer();
  } else if (b.dataset.d === 'ren') {
    const t = prompt('重命名会话', s.title);
    if (t?.trim()) { s.title = t.trim().slice(0, 60); await persist(s); renderDrawer(); }
  } else if (b.dataset.d === 'del') {
    if (!confirm(`删除「${s.title}」？`)) return;
    await idb.del(s.id);
    sessions = sessions.filter((x) => x !== s);
    if (cur === s) {
      cur = sessions.find((x) => x.messages.length) || null;
      if (cur) render(); else newSession();
    }
    renderDrawer();
  }
});
$('#d-q').addEventListener('input', renderDrawer);
$('#d-new').onclick = () => { runCmd('/new'); closeDrawer(); };
scrim.onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer(); });

// 左边缘右滑打开，抽屉内左滑关闭
let touch = null;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  touch = t.clientX < 24 || drawer.classList.contains('open') ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!touch) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x, dy = Math.abs(t.clientY - touch.y);
  const open = drawer.classList.contains('open');
  if (dy < 50) {
    if (dx > 60 && !open) openDrawer();
    else if (dx < -60 && open) closeDrawer();
  }
  touch = null;
}, { passive: true });

/* ---------- 设置 ---------- */
let draft = null;
const PF = { name: '#p-name', type: '#p-type', baseUrl: '#p-base', apiKey: '#p-key', model: '#p-model' };
const draftP = () => draft.providers.find((p) => p.id === draft.active);

function fillProviderSelect() {
  $('#p-sel').innerHTML = draft.providers.map((p) => `<option value="${p.id}">${esc(p.name || '(未命名)')}</option>`).join('');
  $('#p-sel').value = draft.active;
}
function loadProvider(id) {
  const p = draft.providers.find((x) => x.id === id) || draft.providers[0];
  draft.active = p.id;
  $('#p-sel').value = p.id;
  for (const [k, s] of Object.entries(PF)) $(s).value = p[k] ?? '';
}

function openSettings(focusId) {
  draft = structuredClone(cfg);
  fillProviderSelect();
  loadProvider(draft.active);
  $('#s-type').value = draft.search.type;
  $('#s-endpoint').value = draft.search.endpoint;
  $('#s-key').value = draft.search.apiKey;
  $('#g-sys').value = draft.system;
  $('#g-temp').value = draft.temperature;
  $('#g-max').value = draft.maxTokens;
  $('#x-url').value = draft.proxy.url;
  $('#x-token').value = draft.proxy.token;
  $('#remember').checked = draft.remember;
  dlg.returnValue = '';
  dlg.showModal();
  if (focusId) $(`#${focusId}`).focus();
}

for (const [k, s] of Object.entries(PF)) {
  $(s).addEventListener('input', () => {
    draftP()[k] = $(s).value.trim();
    if (k === 'name') $('#p-sel').selectedOptions[0].textContent = draftP().name || '(未命名)';
  });
}
$('#p-sel').addEventListener('change', (e) => loadProvider(e.target.value));
$('#p-add').onclick = () => {
  const p = { id: uid(), ...TEMPLATES.openai, name: '新服务商', apiKey: '' };
  draft.providers.push(p);
  draft.active = p.id;
  fillProviderSelect();
  loadProvider(p.id);
  $('#p-name').focus();
};
$('#p-del').onclick = () => {
  if (draft.providers.length <= 1) return toast('至少保留一个');
  draft.providers = draft.providers.filter((p) => p.id !== draft.active);
  draft.active = draft.providers[0].id;
  fillProviderSelect();
  loadProvider(draft.active);
};
$('#p-tpl').addEventListener('change', (e) => {
  const t = TEMPLATES[e.target.value];
  if (t) { Object.assign(draftP(), t); fillProviderSelect(); loadProvider(draft.active); }
  e.target.value = '';
});

dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  draft.search = { type: $('#s-type').value, endpoint: $('#s-endpoint').value.trim(), apiKey: $('#s-key').value.trim() };
  draft.system = $('#g-sys').value;
  draft.temperature = Math.min(2, Math.max(0, parseFloat($('#g-temp').value) || 0));
  draft.maxTokens = Math.max(1, parseInt($('#g-max').value, 10) || 4096);
  draft.proxy = { url: $('#x-url').value.trim(), token: $('#x-token').value.trim() };
  draft.remember = $('#remember').checked;
  cfg = draft;
  saveCfg();
  applyTheme();
  updateBar();
  if (!cur.messages.length) render();
  toast('已保存');
});

/* ---------- 视口：适配软键盘 ---------- */
const vv = window.visualViewport;
function fitViewport() {
  document.documentElement.style.setProperty('--app-h', `${vv ? vv.height : innerHeight}px`);
  window.scrollTo(0, 0);
  scrollEnd();
}
(vv || window).addEventListener('resize', fitViewport);

/* ---------- 启动 ---------- */
applyTheme();
fitViewport();
closeDrawer();
sessions = (await idb.all()).sort((a, b) => b.updated - a.updated);
cur = sessions[0] || null;
if (cur) render(); else newSession();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
