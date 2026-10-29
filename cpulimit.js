'use strict';
/**
 * Programowy limit CPU dla przeglądarki bota (Linux, bez roota).
 *
 * Jak działa (jak narzędzie `cpulimit`): co 100 ms procesy Chrome (cała gałąź procesów) są wznawiane (SIGCONT)
 * na część cyklu, a resztę cyklu wstrzymywane (SIGSTOP). Długość „pracy” wynika z limitu i zmierzonego zużycia
 * (z /proc), a wolna korekta „kredytu” usuwa systematyczny błąd pomiaru. Wstrzymywane są wszystkie procesy naraz,
 * więc Chrome nie wykrywa „zawieszonych” procesów potomnych.
 *
 * Limit jest w % JEDNEGO rdzenia (jak w top i w panelach hostingu: 100 = jeden pełny rdzeń, 35 = ⅓ rdzenia).
 * Do budżetu wliczamy też zużycie samego Node'a (serwer, puppeteer), więc limit dotyczy całości.
 */
const fs = require('fs');
const { execSync } = require('child_process');

const SUPPORTED = process.platform === 'linux' && fs.existsSync('/proc/self/stat');
const PERIOD_MS = 100;       // długość jednego cyklu pracuj/stoj
const MIN_RUN_MS = 4;        // najkrótsza „praca” w cyklu
const RESCAN_MS = 1000;      // co ile odświeżamy listę procesów potomnych
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hr = () => process.hrtime.bigint();

let CLK_TCK = 100;
if (SUPPORTED) { try { CLK_TCK = Number(execSync('getconf CLK_TCK', { encoding: 'utf8' }).trim()) || 100; } catch { /* zwykle 100 */ } }

/** { state, ppid, ticks } z /proc/<pid>/stat (ticks = utime + stime wszystkich wątków procesu). */
function readStat(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');      // nazwa procesu może zawierać spacje i nawiasy
    return { state: f[0], ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]) };
  } catch { return null; }
}
const listPids = () => { try { return fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number); } catch { return []; } };

/** Podane procesy i wszystkie ich potomki. */
function descendants(roots) {
  const kids = new Map();
  for (const pid of listPids()) {
    const st = readStat(pid);
    if (st) { if (!kids.has(st.ppid)) kids.set(st.ppid, []); kids.get(st.ppid).push(pid); }
  }
  const out = new Set(), stack = [...roots];
  while (stack.length) {
    const p = stack.pop();
    if (out.has(p)) continue;
    out.add(p);
    for (const c of kids.get(p) || []) stack.push(c);
  }
  return [...out];
}

/** Główny proces Chrome uruchomiony z --remote-debugging-port=<port> (bez --type=, czyli nie proces potomny). */
function findRootByPort(port) {
  const needle = `--remote-debugging-port=${port}`;
  for (const pid of listPids()) {
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (args.includes(needle) && !args.some(a => a.startsWith('--type='))) return pid;
    } catch { /* proces zniknął */ }
  }
  return null;
}

class CpuGovernor {
  /**
   * @param getLimit  () => procent jednego rdzenia (0 = bez limitu); czytane co cykl, więc zmiana działa od razu
   * @param getRoots  () => [pid, …] głównych procesów przeglądarek
   */
  constructor({ getLimit, getRoots }) {
    this.getLimit = getLimit;
    this.getRoots = getRoots;
    this.running = false;
    this.tracked = new Set();
    this.holdUntil = 0;
    this.stat = { active: false, browser: 0, node: 0, pids: 0 };
  }

  get supported() { return SUPPORTED; }

  start() {
    if (this.running) return;
    this.running = true;
    this._loop().catch(() => { this.running = false; this.release(); });
  }

  stop() { this.running = false; this.release(); }

  /** Wznawia wszystkie wstrzymane procesy. */
  release() {
    for (const pid of this.tracked) { try { process.kill(pid, 'SIGCONT'); } catch { /* już nie istnieje */ } }
  }

  /** Na ms milisekund wyłącza dławienie i wznawia procesy (np. na czas zamykania przeglądarki). */
  hold(ms) { this.holdUntil = Date.now() + ms; this.release(); }

  status() { return { supported: SUPPORTED, limit: Number(this.getLimit()) || 0, ...this.stat }; }

  _signal(pids, sig) { for (const pid of pids) { try { process.kill(pid, sig); } catch { /* proces zakończony */ } } }

  async _loop() {
    let rate = 0;                       // zużycie (w rdzeniach) procesów przeglądarki, gdy są wznowione – średnia wygładzona
    let nodeRate = 0;                   // zużycie samego Node'a
    let credit = 0;                     // zaoszczędzone (+) lub przekroczone (−) sekundy CPU, ±2 s
    let prev = new Map(), pids = [], lastScan = 0;
    let lastNode = process.cpuUsage(), lastNodeT = hr();

    while (this.running) {
      const limit = (Number(this.getLimit()) || 0) / 100;
      if (!SUPPORTED || !(limit > 0) || Date.now() < this.holdUntil) {
        this.release();
        this.stat = { active: false, browser: 0, node: nodeRate, pids: 0 };
        credit = 0;
        await sleep(300);
        lastNode = process.cpuUsage(); lastNodeT = hr();
        continue;
      }

      if (Date.now() - lastScan >= RESCAN_MS) {
        const roots = this.getRoots();
        const all = roots.length ? descendants(roots) : [];
        const cur = new Map();
        for (const pid of all) {
          const st = readStat(pid);
          if (st) cur.set(pid, prev.has(pid) ? prev.get(pid) : st.ticks);   // nowy proces: bez doliczania jego dotychczasowego CPU
        }
        prev = cur; pids = [...cur.keys()]; this.tracked = new Set(pids); lastScan = Date.now();
      }
      if (!pids.length) { this.stat = { active: false, browser: 0, node: nodeRate, pids: 0 }; await sleep(400); continue; }

      // ile rdzenia wolno przeznaczyć na przeglądarkę: limit − Node, plus powolna korekta kredytu
      const allowed = Math.max(0.02, limit - nodeRate + credit / 2);
      const runMs = rate <= allowed ? PERIOD_MS : Math.max(MIN_RUN_MS, Math.round(PERIOD_MS * allowed / rate));

      const t0 = hr();
      this._signal(pids, 'SIGCONT');
      await sleep(runMs);

      let used = 0;                                         // CPU zużyte przez przeglądarkę w tym cyklu (sekundy)
      for (const pid of pids) {
        const st = readStat(pid);
        if (!st) continue;
        const p = prev.get(pid);
        if (p !== undefined && st.ticks >= p) used += st.ticks - p;
        prev.set(pid, st.ticks);
      }
      used /= CLK_TCK;
      const runWall = Number(hr() - t0) / 1e9;
      rate = 0.7 * rate + 0.3 * (used / Math.max(runWall, 0.001));

      if (runMs < PERIOD_MS) { this._signal(pids, 'SIGSTOP'); await sleep(PERIOD_MS - runMs); }

      const nu = process.cpuUsage(), nt = hr();
      const cycleWall = Number(nt - t0) / 1e9;
      const nodeUsed = ((nu.user - lastNode.user) + (nu.system - lastNode.system)) / 1e6;
      nodeRate = 0.7 * nodeRate + 0.3 * (nodeUsed / Math.max(Number(nt - lastNodeT) / 1e9, 0.001));
      lastNode = nu; lastNodeT = nt;

      credit = Math.max(-2, Math.min(2, credit + limit * cycleWall - used - nodeUsed));
      this.stat = { active: true, browser: used / cycleWall, node: nodeRate, pids: pids.length };
    }
    this.release();
  }
}

module.exports = { CpuGovernor, SUPPORTED, findRootByPort, descendants, readStat, CLK_TCK };
