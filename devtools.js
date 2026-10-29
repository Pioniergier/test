'use strict';
/**
 * Własne „DevTools” w panelu (karty.html): Konsola z REPL, Sieć, Elementy (z wskazywaniem elementu na obrazie karty).
 *
 * To wersja uproszczona: oficjalny frontend DevTools nie jest dostępny dla chrome-headless-shell, a pakiet
 * chrome-devtools-frontend z npm to kod źródłowy (do zbudowania potrzebny toolchain Chromium). Dane pochodzą
 * z zdarzeń Puppeteera (konsola, żądania) i z CDP (Runtime.evaluate dla REPL).
 *
 * Sesja jest włączana na żądanie dla jednej karty i sama się wyłącza po minucie bez odpytywania.
 */
const MAX_CONSOLE = 500;
const MAX_NET = 400;
const IDLE_STOP_MS = 60000;

const SESS = new Map();                 // id karty -> sesja
const REQ_IDS = new WeakMap();          // obiekt żądania -> numer
let reqSeq = 0;

const push = (arr, item, max) => { arr.push(item); if (arr.length > max) arr.splice(0, arr.length - max); };
const offEvent = (page, ev, fn) => (page.off ? page.off(ev, fn) : page.removeListener(ev, fn));

function stopSession(id) {
  const s = SESS.get(id);
  if (!s) return;
  for (const [ev, fn] of s.handlers) { try { offEvent(s.page, ev, fn); } catch { /* strona już zamknięta */ } }
  if (s.client) s.client.detach().catch(() => {});
  SESS.delete(id);
}

function startSession(id, page) {
  if (SESS.has(id)) { SESS.get(id).lastPoll = Date.now(); return SESS.get(id); }
  const s = { id, page, seq: 0, console: [], net: new Map(), client: null, handlers: [], lastPoll: Date.now() };
  const bump = () => ++s.seq;
  const on = (ev, fn) => { page.on(ev, fn); s.handlers.push([ev, fn]); };

  on('console', msg => {
    let loc = '';
    try { const l = msg.location(); if (l && l.url) loc = `${l.url}${l.lineNumber != null ? ':' + l.lineNumber : ''}`; } catch { /* brak lokalizacji */ }
    push(s.console, { seq: bump(), t: Date.now(), type: msg.type(), text: msg.text(), loc }, MAX_CONSOLE);
  });
  on('pageerror', err => push(s.console, { seq: bump(), t: Date.now(), type: 'error', text: String((err && err.message) || err), loc: '' }, MAX_CONSOLE));

  const entry = req => {
    const id2 = REQ_IDS.get(req);
    return id2 ? s.net.get(id2) : null;
  };
  on('request', req => {
    const rid = ++reqSeq;
    REQ_IDS.set(req, rid);
    s.net.set(rid, {
      id: rid, seq: bump(), t0: Date.now(), method: req.method(), url: req.url(), type: req.resourceType(),
      reqHeaders: req.headers(), status: null, statusText: '', resHeaders: null, size: null, ms: null, failed: null, cached: false,
    });
    if (s.net.size > MAX_NET) s.net.delete(s.net.keys().next().value);
  });
  on('response', res => {
    const e = entry(res.request());
    if (!e) return;
    const h = res.headers();
    Object.assign(e, { seq: bump(), status: res.status(), statusText: res.statusText ? res.statusText() : '', resHeaders: h, cached: !!(res.fromCache && res.fromCache()) });
    if (h['content-length'] != null) e.size = Number(h['content-length']) || 0;
  });
  on('requestfinished', req => { const e = entry(req); if (e) { e.ms = Date.now() - e.t0; e.seq = bump(); } });
  on('requestfailed', req => {
    const e = entry(req);
    if (e) { e.ms = Date.now() - e.t0; e.failed = (req.failure && req.failure() && req.failure().errorText) || 'błąd'; e.seq = bump(); }
  });
  page.once('close', () => stopSession(id));

  SESS.set(id, s);
  return s;
}

// zapomniane sesje (panel zamknięty bez „wyłącz”) nie mogą zbierać danych w nieskończoność
setInterval(() => { for (const s of [...SESS.values()]) if (Date.now() - s.lastPoll > IDLE_STOP_MS) stopSession(s.id); }, 15000).unref();

/** Wynik Runtime.evaluate -> tekst jak w konsoli DevTools. */
function fmtRemote(r) {
  if (!r || r.type === 'undefined') return 'undefined';
  if (r.subtype === 'null') return 'null';
  if (r.unserializableValue) return r.unserializableValue;
  if ('value' in r && r.type !== 'object') return r.type === 'string' ? JSON.stringify(r.value) : String(r.value);
  if (r.preview && Array.isArray(r.preview.properties)) {
    const arr = r.subtype === 'array';
    const items = r.preview.properties.slice(0, 10).map(p => {
      const v = p.type === 'string' ? JSON.stringify(p.value) : (p.value == null ? p.type : p.value);
      return arr ? v : `${p.name}: ${v}`;
    });
    const more = r.preview.overflow || r.preview.properties.length > 10 ? ', …' : '';
    return `${r.description || r.className || ''} ${arr ? '[' : '{'}${items.join(', ')}${more}${arr ? ']' : '}'}`.trim();
  }
  return r.description || r.className || r.type;
}

/** Uruchamiane W STRONIE (samowystarczalne): węzeł wskazany ścieżką indeksów childNodes albo punktem na ekranie. */
function pageNode(mode, a, b) {
  let el;
  if (mode === 'pick') el = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(a, b) : null;
  else { el = document; if (a) for (const i of String(a).split('.')) el = el && el.childNodes[Number(i)]; }
  if (!el) return { error: mode === 'pick' ? 'Brak elementu w tym miejscu' : 'Ten węzeł już nie istnieje (odśwież drzewo)' };
  if (el.nodeType !== 1) return { error: 'To nie jest element' };

  const esc = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
  const pathOf = n => { const p = []; for (let x = n; x && x !== document; x = x.parentNode) p.unshift(Array.prototype.indexOf.call(x.parentNode.childNodes, x)); return p.join('.'); };
  const selOf = n => {
    const parts = [];
    for (let e = n; e && e.nodeType === 1; e = e.parentElement) {
      if (e.id && document.querySelectorAll('#' + esc(e.id)).length === 1) { parts.unshift('#' + esc(e.id)); break; }
      let part = e.tagName.toLowerCase() + [...e.classList].slice(0, 2).map(c => '.' + esc(c)).join('');
      const same = e.parentElement ? [...e.parentElement.children].filter(x => x.tagName === e.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(e) + 1})`;
      parts.unshift(part);
      if (e === document.documentElement) break;
    }
    return parts.join(' > ');
  };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const style = {};
  for (const k of ['display', 'position', 'color', 'background-color', 'font-size', 'font-family', 'width', 'height', 'margin', 'padding', 'z-index', 'visibility', 'opacity']) style[k] = cs.getPropertyValue(k);
  const selector = selOf(el);
  let matches = 0;
  try { matches = document.querySelectorAll(selector).length; } catch { /* selektor niepoprawny */ }
  return {
    path: pathOf(el), selector, matches, tag: el.tagName.toLowerCase(),
    attrs: [...el.attributes].slice(0, 20).map(x => [x.name, x.value.length > 200 ? x.value.slice(0, 200) + '…' : x.value]),
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    html: el.outerHTML.slice(0, 4000), text: (el.innerText || el.textContent || '').trim().slice(0, 300), style,
  };
}

/** Uruchamiane W STRONIE: dzieci węzła o danej ścieżce (puste węzły tekstowe pomijamy; i = indeks w childNodes). */
function pageChildren(pathStr) {
  const MAX = 300;
  let node = document;
  if (pathStr) for (const i of String(pathStr).split('.')) node = node && node.childNodes[Number(i)];
  if (!node) return { error: 'Ten węzeł już nie istnieje (odśwież drzewo)' };
  const desc = n => {
    const t = n.nodeType;
    if (t === 1) return { type: 1, tag: n.tagName.toLowerCase(), attrs: [...n.attributes].slice(0, 6).map(a => [a.name, a.value.length > 80 ? a.value.slice(0, 80) + '…' : a.value]), n: n.childNodes.length };
    if (t === 3) return { type: 3, text: n.nodeValue.trim().slice(0, 160) };
    if (t === 8) return { type: 8, text: n.nodeValue.slice(0, 160) };
    if (t === 10) return { type: 10, text: n.name };
    return { type: t };
  };
  const kids = [];
  for (let i = 0; i < node.childNodes.length && kids.length < MAX; i++) {
    const c = node.childNodes[i];
    if (c.nodeType === 3 && !c.nodeValue.trim()) continue;
    kids.push({ i, ...desc(c) });
  }
  return { kids, truncated: node.childNodes.length > MAX };
}

const PATH_RE = /^(\d+(\.\d+)*)?$/;
const summary = e => ({ id: e.id, seq: e.seq, method: e.method, url: e.url, type: e.type, status: e.status, size: e.size, ms: e.ms, failed: e.failed, cached: e.cached });

/**
 * @param app  aplikacja express
 * @param deps { tabRoute(req, res, fn(page, body)), withTimeout(promise, ms, msg) } – z server.js
 */
function mountDevtools(app, { tabRoute, withTimeout }) {
  const need = id => { const s = SESS.get(id); if (!s) throw new Error('DevTools nie są włączone dla tej karty'); s.lastPoll = Date.now(); return s; };

  app.post('/api/tabs/:id/devtools', (req, res) => tabRoute(req, res, async (page, b) => {
    const id = Number(req.params.id);
    if (b.action === 'start') { const s = startSession(id, page); return { seq: s.seq }; }
    if (b.action === 'stop') { stopSession(id); return {}; }
    if (b.action === 'clear') { const s = need(id); s.console.length = 0; s.net.clear(); s.seq++; return { seq: s.seq }; }
    throw new Error('Nieznana akcja');
  }));

  /** Nowe wpisy od numeru `since` (konsola + zmienione/nowe żądania sieciowe). */
  app.get('/api/tabs/:id/devtools', (req, res) => tabRoute(req, res, () => {
    const s = need(Number(req.params.id));
    const since = Number(req.query.since) || 0;
    return { seq: s.seq, console: s.console.filter(c => c.seq > since), network: [...s.net.values()].filter(e => e.seq > since).map(summary) };
  }));

  app.get('/api/tabs/:id/devtools/request', (req, res) => tabRoute(req, res, () => {
    const s = need(Number(req.params.id));
    const e = s.net.get(Number(req.query.id));
    if (!e) throw new Error('To żądanie już nie jest w pamięci');
    return { request: { ...summary(e), statusText: e.statusText, reqHeaders: e.reqHeaders, resHeaders: e.resHeaders } };
  }));

  /** REPL: Runtime.evaluate (instrukcje, await na najwyższym poziomie, podgląd obiektów). */
  app.post('/api/tabs/:id/devtools/eval', (req, res) => tabRoute(req, res, async (page, b) => {
    const s = need(Number(req.params.id));
    const expression = String(b.expr == null ? '' : b.expr);
    if (!expression.trim() || expression.length > 20000) throw new Error('Wyrażenie musi mieć od 1 do 20000 znaków');
    if (!s.client) s.client = await (page.createCDPSession ? page.createCDPSession() : page.target().createCDPSession());
    const r = await withTimeout(s.client.send('Runtime.evaluate', {
      expression, awaitPromise: true, replMode: true, generatePreview: true, userGesture: true, timeout: 10000,
    }), 15000, 'Wyrażenie wykonuje się zbyt długo');
    if (r.exceptionDetails) {
      const ed = r.exceptionDetails;
      return { ok2: false, text: (ed.exception && (ed.exception.description || ed.exception.value)) || ed.text || 'Błąd' };
    }
    return { ok2: true, text: fmtRemote(r.result) };
  }));

  app.get('/api/tabs/:id/devtools/dom', (req, res) => tabRoute(req, res, async page => {
    need(Number(req.params.id));
    const p = String(req.query.path || '');
    if (!PATH_RE.test(p)) throw new Error('Niepoprawna ścieżka');
    const r = await page.evaluate(pageChildren, p);
    if (r.error) throw new Error(r.error);
    return r;
  }));

  app.get('/api/tabs/:id/devtools/node', (req, res) => tabRoute(req, res, async page => {
    need(Number(req.params.id));
    const p = String(req.query.path || '');
    if (!PATH_RE.test(p)) throw new Error('Niepoprawna ścieżka');
    const r = await page.evaluate(pageNode, 'path', p);
    if (r.error) throw new Error(r.error);
    return { node: r };
  }));

  app.post('/api/tabs/:id/devtools/pick', (req, res) => tabRoute(req, res, async (page, b) => {
    need(Number(req.params.id));
    const x = Number(b.x), y = Number(b.y);
    if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 20000)) throw new Error('Nieprawidłowa współrzędna');
    const r = await page.evaluate(pageNode, 'pick', x, y);
    if (r.error) throw new Error(r.error);
    return { node: r };
  }));
}

module.exports = { mountDevtools, startSession, stopSession, pageNode, pageChildren, fmtRemote, SESS };
