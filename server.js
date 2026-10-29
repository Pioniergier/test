/**
 * Panel bota (Node.js + puppeteer-real-browser): konta + token, strony, skanowanie, start/stop,
 * podgląd strony z zaznaczaniem elementów.
 *
 *   npm install          (puppeteer-real-browser + Chrome; na Linuxie: sudo apt-get install xvfb)
 *   npm start             ->  http://127.0.0.1:5000
 *
 * Silnik: puppeteer-real-browser (connect + turnstile: true, headless: false),
 * humanizacja: losowe opóźnienia + naturalne ruchy myszy / scroll przed interakcją.
 */
const express = require('express');
const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pause = require('./pause');
const { CpuGovernor, findRootByPort } = require('./cpulimit');
const { mountDevtools } = require('./devtools');                    // DevTools w panelu (Konsola / Sieć / Elementy)
const { inspectChallenge, resolveChallenge } = require('./human');   // weryfikacja „czy jesteś człowiekiem” → pauza   // „czekam na człowieka” (captcha, zrzut ekranu) + konta z utraconą sesją

// Tryb „hosting”: boot.js ustawia CHROME_PATH (chrome-headless-shell, bez Xvfb, bez okna). Lokalnie – jak dawniej.
const IS_HOSTED = !!process.env.CHROME_PATH || process.env.BOT_HOSTED === '1';

const HEADLESS_DEFAULT = false; // real-browser najlepiej działa z widocznym oknem (ukrywa flagi automatu)
const DELAY_MS = 1000;          // przerwa między stronami
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT_MS) || 30000;      // limit ładowania strony
const DEFAULT_TIMEOUT = Number(process.env.DEFAULT_TIMEOUT_MS) || 15000;   // domyślny limit operacji na stronie (czekanie na selektor itp.)
const IDLE_WAIT_MS = Number(process.env.IDLE_WAIT_MS) || 8000;        // ile najwyżej czekać po załadowaniu, aż sieć „ucichnie”
const CLOSE_DELAY_MS = Number(process.env.CLOSE_DELAY_MS) || (IS_HOSTED ? 5000 : 30000);   // tyle czeka bot przed zamknięciem przeglądarki
// Ile runSiteSteps czeka na (spóźnione, np. JS-owe) przekierowanie, zanim uzna, że żaden krok nie pasuje:
const REDIRECT_GRACE_MS = 8000;             // na starcie strony
const REDIRECT_GRACE_AFTER_STEP_MS = 2500;  // po wykonanym kroku
const REDIRECT_GRACE_NO_SITE_MS = 1500;     // domena bez skryptu w strony/ – tu nie ma po co czekać długo
const PREVIEW_IDLE_MS = 60000;  // przeglądarka podglądu (/preview) zamyka się po tylu ms bezczynności

const PORT = Number(process.env.PORT || process.env.SERVER_PORT) || (IS_HOSTED ? 16927 : 5000);
const HOST = process.env.HOST || (IS_HOSTED ? '0.0.0.0' : '0.0.0.0');
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PASS_FILE = path.join(__dirname, 'panel-password.txt');
const EXPOSED = !['0.0.0.0', 'localhost', '::1'].includes(HOST);   // panel dostępny z sieci
// Hasło panelu: PANEL_PASSWORD, a gdy brak – plik panel-password.txt. Gdy panel jest dostępny z sieci, a hasła nie ma,
// generujemy je (panel steruje zalogowaną przeglądarką, więc nie może stać w internecie bez hasła).
let PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
let PASSWORD_GENERATED = false;
if (!PANEL_PASSWORD) { try { PANEL_PASSWORD = fs.readFileSync(PASS_FILE, 'utf8').trim(); } catch {} }
if (!PANEL_PASSWORD && EXPOSED) {
  PANEL_PASSWORD = crypto.randomBytes(12).toString('base64url');
  try { fs.writeFileSync(PASS_FILE, PANEL_PASSWORD + '\n', { mode: 0o600 }); } catch {}
  PASSWORD_GENERATED = true;
}

const DATA_FILE = path.join(__dirname, 'data.json');
const RESULTS_FILE = path.join(__dirname, 'results.jsonl');
const STRONY_DIR = path.join(__dirname, 'strony');   // skrypty sekwencji: strony/<domena>.js

const app = express();

// Panel steruje zalogowaną przeglądarką (podgląd i klikanie w karty) – patrz PANEL_PASSWORD wyżej.
if (PANEL_PASSWORD) {
  const sha = x => crypto.createHash('sha256').update(String(x)).digest();
  const wantUser = sha(PANEL_USER), wantPass = sha(PANEL_PASSWORD);
  app.use((req, res, next) => {
    const m = /^Basic (.+)$/i.exec(req.headers.authorization || '');
    if (m) {
      const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
      const okU = crypto.timingSafeEqual(sha(u), wantUser), okP = crypto.timingSafeEqual(sha(rest.join(':')), wantPass);
      if (okU && okP) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Panel bota", charset="UTF-8"').status(401).send('Wymagane logowanie');
  });
}
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshoty', express.static(path.join(__dirname, 'screenshoty')));   // zrzuty ekranu z pauz bota

const LOG = [];
const BOT = { running: false, stop: false, scanning: false };
// rejestr żywych przeglądarek – dla podglądu kart w panelu
const LIVE = { browsers: new Set() };   // przeglądarki bota / skanu, które aktualnie żyją
const CTX_META = new WeakMap();         // kontekst przeglądarki -> { accId, name }
const uid = () => crypto.randomBytes(4).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Jak sleep, ale kończy się od razu po kliknięciu „Stop” (sprawdza co 250 ms). */
async function sleepStop(ms) {
  const end = Date.now() + ms;
  while (!BOT.stop && Date.now() < end) await sleep(Math.min(250, end - Date.now()));
}
const errMsg = e => String(e && e.message || e).split('\n')[0].slice(0, 200);
const rand = (min, max) => min + Math.random() * (max - min);

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  LOG.push(`${t}  ${msg}`);
  if (LOG.length > 300) LOG.splice(0, LOG.length - 300);
}

// ---------- dane ----------
function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { accounts: [], pages: [], settings: {} }; }
}
/** Zapis atomowy (plik tymczasowy + rename) – nagłe ubicie procesu nie zostawia uciętego data.json. */
function save(s) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/** true = przeglądarka niewidoczna, false = widać okno Chrome. Czytane przy każdym uruchomieniu. */
function isHeadless(s = load()) {
  if (IS_HOSTED) return true;                 // na hostingu nie ma okna
  const v = (s.settings || {}).headless;
  return v === undefined ? HEADLESS_DEFAULT : !!v;
}

function withTimeout(p, ms, msg = 'Przekroczono czas odpowiedzi') {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}

// Flagi Chrome na hostingu: mniej pamięci/procesów, bez usług w tle; karty w tle nie są spowalniane
// (każde konto ma własne okno/kontekst, a bot pracuje na kilku kartach naraz).
const HOSTED_CHROME_FLAGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
  '--disable-default-apps', '--disable-background-networking', '--metrics-recording-only', '--mute-audio',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-blink-features=AutomationControlled',
];
const PROFILE_DIRS = new WeakMap();   // przeglądarka -> jej tymczasowy profil (usuwany przy zamknięciu)

/**
 * Uruchamia prawdziwą przeglądarkę przez puppeteer-real-browser.
 * - turnstile: true  → automatyczne klikanie Cloudflare Turnstile
 * - lokalnie: headless: false (zalecane) i Xvfb na Linuxie; na hostingu: chrome-headless-shell bez Xvfb
 * - na hostingu każdy start ma własny, tymczasowy profil (nie ma konfliktu blokad ani rosnącego katalogu)
 * - track: true → przeglądarka trafia do rejestru (karty widać w panelu); /preview używa track: false
 */
async function launchBrowser({ forceHeadless = false, track = true } = {}) {
  const headless = IS_HOSTED || forceHeadless ? true : isHeadless();
  const profileDir = IS_HOSTED ? fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-profile-')) : null;
  try {
    const { browser } = await connect({
      headless,
      args: IS_HOSTED ? [...HOSTED_CHROME_FLAGS, `--user-data-dir=${profileDir}`] : ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      customConfig: {},
      turnstile: true,
      connectOption: headless ? {} : { defaultViewport: null },
      disableXvfb: IS_HOSTED,
      ignoreAllFlags: false,
    });
    if (profileDir) PROFILE_DIRS.set(browser, profileDir);
    if (track) LIVE.browsers.add(browser);
    return browser;
  } catch (e) {
    if (profileDir) fs.rm(profileDir, { recursive: true, force: true }, () => {});
    throw e;
  }
}

/** Zamyka przeglądarkę (z limitem czasu), wyrejestrowuje ją i sprząta profil. delayMs – opcjonalna pauza „na obejrzenie efektu”. */
async function closeBrowser(browser, { delayMs = 0 } = {}) {
  if (!browser) return;
  if (delayMs > 0 && !BOT.stop) { log(`Czekam ${delayMs / 1000} s przed zamknięciem przeglądarki`); await sleep(delayMs); }
  governor.hold(8000);                      // zamrożony (SIGSTOP) Chrome nie odpowiedziałby na close()
  await withTimeout(Promise.resolve(browser.close()), 10000, 'zamykanie przeglądarki trwa za długo').catch(() => {});
  LIVE.browsers.delete(browser);
  const dir = PROFILE_DIRS.get(browser);
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});   // await: przy shutdown zaraz po tym jest process.exit
}

/** Limity czasu dla każdej strony bota (na hostingu ładowanie bywa wolne). */
function setupPage(page) {
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.setDefaultTimeout(DEFAULT_TIMEOUT);
}

/** Tryby tokenu inne niż „discord” (nagłówek Authorization, cookie, localStorage) – dla stron z Twojego panelu. */
async function configurePage(page, acc, pages) {
  if (!acc || !acc.token) return;
  const origins = [...new Set(pages.map(p => new URL(p.url).origin))];
  const hosts = new Set(origins.map(o => new URL(o).host));
  const mode = acc.token_mode || 'bearer';
  const name = acc.token_name || 'token';
  if (mode === 'bearer' || mode === 'header') {
    const value = mode === 'bearer' ? `Bearer ${acc.token}` : acc.token;
    await page.setRequestInterception(true);
    page.on('request', req => {
      let host = '';
      try { host = new URL(req.url()).host; } catch {}
      const headers = hosts.has(host) ? { ...req.headers(), authorization: value } : req.headers();
      req.continue({ headers }).catch(() => {});
    });
  } else if (mode === 'cookie') {
    for (const url of origins) await page.setCookie({ name, value: acc.token, url });
  } else if (mode === 'localstorage') {
    await page.evaluateOnNewDocument((origins, key, token) => {
      if (origins.includes(location.origin)) { try { localStorage.setItem(key, token); } catch {} }
    }, origins, name, acc.token);
  }
}

/**
 * Humanize – upodobnienie zachowania do człowieka przed interakcją z elementami / hCaptcha.
 * 1) losowe opóźnienie 2–5 s po załadowaniu
 * 2) delikatne, nieliniowe ruchy myszy
 * 3) naturalne przewijanie strony (scroll kółkiem)
 */
async function humanize(page, label = '') {
  const tag = label ? ` [${label}]` : '';
  try {
    const delayMs = Math.floor(rand(2000, 5000));
    log(`Humanize${tag}: czekam ${Math.round(delayMs / 1000)} s…`);
    await sleepStop(delayMs);
    if (BOT.stop) return;

    // viewport (gdy null – bierzemy rozsądne wartości)
    let w = 1280, h = 800;
    try {
      const vp = page.viewport();
      if (vp) { w = vp.width; h = vp.height; }
      else {
        const size = await page.evaluate(() => ({
          w: window.innerWidth || document.documentElement.clientWidth || 1280,
          h: window.innerHeight || document.documentElement.clientHeight || 800,
        }));
        w = size.w; h = size.h;
      }
    } catch {}

    // delikatne, nieliniowe ruchy myszy (kilka krótkich odcinków)
    let x = rand(80, Math.min(400, w * 0.4));
    let y = rand(80, Math.min(300, h * 0.35));
    await page.mouse.move(x, y, { steps: 1 }).catch(() => {});
    const moves = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < moves; i++) {
      x += (Math.random() - 0.5) * 180;
      y += (Math.random() - 0.5) * 120;
      x = Math.max(12, Math.min(w - 12, x));
      y = Math.max(12, Math.min(h - 12, y));
      const steps = 6 + Math.floor(Math.random() * 12);
      await page.mouse.move(x, y, { steps }).catch(() => {});
      await sleep(rand(40, 160));
    }

    // naturalne przewijanie (2–4 „pociągnięcia” kółkiem, z przerwami)
    const scrolls = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < scrolls; i++) {
      const delta = Math.floor(rand(80, 280)) * (Math.random() > 0.15 ? 1 : -1);
      await page.mouse.wheel({ deltaY: delta }).catch(() => {});
      await sleep(rand(250, 700));
    }

    // lekki powrót w górę (jak ktoś czyta)
    if (Math.random() > 0.4) {
      await page.mouse.wheel({ deltaY: -Math.floor(rand(40, 120)) }).catch(() => {});
      await sleep(rand(200, 500));
    }

    log(`Humanize${tag}: ruchy myszy + scroll zakończone`);
  } catch (e) {
    log(`Humanize${tag}: pominięto (${errMsg(e)})`);
  }
}

function publicState() {
  const s = load();
  return {
    accounts: s.accounts.map(({ password, token, ...a }) => ({ ...a, has_password: !!password, has_token: !!token })),
    pages: s.pages.map(p => ({ ...p, script: siteFileFor(p.url) })),
    log: LOG,
    running: BOT.running,
    scanning: BOT.scanning,
    headless: isHeadless(s),
    cpuLimit: cpuLimitPct,
    cpu: governor.status(),
    maxJoins: (() => { const v = Number((s.settings || {}).maxJoins); return Number.isInteger(v) && v >= 0 ? v : 5; })(),
    waiting: pause.list(),
    revoked: pause.revokedList(),
  };
}

// ---------- przeglądarka ----------
/** Czeka (najwyżej IDLE_WAIT_MS), aż strona „ucichnie” (≤2 połączenia przez 500 ms, jak networkidle2) – bez ponownego
 *  ładowania strony, gdy to nie nastąpi (strony z websocketami / analityką często nigdy nie cichną). */
const settle = page => page.waitForNetworkIdle({ idleTime: 500, timeout: IDLE_WAIT_MS, concurrency: 2 }).catch(() => {});

/** Wchodzi na adres; zwraca odpowiedź HTTP (do odczytu statusu). */
async function goto(page, url, { human = true, label = '' } = {}) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await settle(page);
  if (human) await humanize(page, label || url);
  return resp;
}

/** Wypełnia pole formularza (czyści je najpierw). */
const LOGIN_SELECTOR_TIMEOUT_MS = 30000;   // ile czekać na pole login / hasło / przycisk na stronie logowania
const LOGIN_DONE_TIMEOUT_MS = 20000;       // ile czekać po kliknięciu „zaloguj”, aż strona się zmieni / pole hasła zniknie
// Domyślne selektory auto-logowania (gdy w panelu pole jest puste). Pierwszy z listy to #email / #password;
// reszta to zapasowe warianty (Discord ma w polach name="email" / name="password" i zmienne id).
const LOGIN_DEFAULTS = {
  user: '#email, input[name="email"], input[type="email"]',
  pass: '#password, input[name="password"], input[type="password"]',
  submit: 'button[type=submit]',
};
const loginSel = (v, def) => String(v || '').trim() || def;

async function waitForEl(page, sel, label, timeout) {
  try { return await page.waitForSelector(sel, { visible: true, timeout }); }
  catch { throw new Error(`nie znaleziono ${label} (selektor: ${sel}) na ${page.url()} w ciągu ${timeout / 1000} s`); }
}
/** Wpisuje tekst w pole. `timeout` – jak długo czekać na pole (wyszukiwanie na stronach: 8 s, logowanie: LOGIN_SELECTOR_TIMEOUT_MS). */
async function fillInput(page, sel, value, label = 'pola', timeout = 8000) {
  await waitForEl(page, sel, label, timeout);
  await page.click(sel, { clickCount: 3 }).catch(() => {});
  await page.evaluate(s => { const el = document.querySelector(s); if (el) el.value = ''; }, sel).catch(() => {});
  await page.type(sel, value || '', { delay: 8 + Math.floor(Math.random() * 20) });
}

/** Konto ma skonfigurowane auto-logowanie (adres strony logowania) – wtedy ono ma pierwszeństwo przed tokenem. */
const hasAutoLogin = acc => !!(acc && acc.login_url);

async function loginIfConfigured(page, acc) {
  if (!acc || !acc.login_url) return;
  const L = m => log(`[${acc.name}] ${m}`);
  // weryfikacja „czy jesteś człowiekiem”: czeka, aż przejdzie sama, a potem zatrzymuje pracę konta do „Wznów pracę”
  const chk = label => resolveChallenge(page, acc, L, label, { shouldStop: () => BOT.stop });
  const userSel = loginSel(acc.user_sel, LOGIN_DEFAULTS.user);
  const passSel = loginSel(acc.pass_sel, LOGIN_DEFAULTS.pass);
  const submitSel = loginSel(acc.submit_sel, LOGIN_DEFAULTS.submit);
  await goto(page, acc.login_url, { human: true, label: 'login' });
  await chk('strona logowania');                       // np. ekran Cloudflare przed formularzem
  await fillInput(page, userSel, acc.login, 'pola login', LOGIN_SELECTOR_TIMEOUT_MS);
  await fillInput(page, passSel, acc.password, 'pola hasło', LOGIN_SELECTOR_TIMEOUT_MS);
  await waitForEl(page, submitSel, 'przycisku logowania', LOGIN_SELECTOR_TIMEOUT_MS);
  const before = page.url();
  await page.click(submitSel);

  // czekamy, aż logowanie się skończy: adres się zmieni albo pole hasła zniknie (SPA nie zawsze robi nawigację);
  // po drodze pilnujemy captchy (Discord pokazuje ją dopiero PO kliknięciu „zaloguj”)
  const waitDone = async () => {
    const end = Date.now() + LOGIN_DONE_TIMEOUT_MS;
    for (let tick = 1; Date.now() < end && !BOT.stop; tick++) {
      await sleep(500);
      if (page.url() !== before) return 'done';
      if (!(await page.$(passSel).catch(() => null))) return 'done';
      if (tick % 2 === 0 && (await inspectChallenge(page)).blocking) return 'challenge';
    }
    return 'timeout';
  };
  let r = await waitDone();
  for (let i = 0; i < 3 && r === 'challenge'; i++) {
    if ((await chk('po kliknięciu „zaloguj”')) === 'aborted') return;
    r = await waitDone();
  }
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
}

/** Tryb tokenu "discord": zanim bot otworzy cokolwiek innego, otwiera kartę discord.com,
 *  wpisuje token do localStorage (klucz z panelu, domyślnie "token"), odświeża i zamyka kartę.
 *  Sesja zostaje w kontekście przeglądarki, więc kolejne strony (np. „Kontynuuj z Discord”) widzą zalogowane konto. */
async function primeDiscord(ctx, acc) {
  if (!acc || !acc.token || acc.token_mode !== 'discord') return;
  const key = acc.token_name || 'token';
  const token = String(acc.token).trim().replace(/^"+|"+$/g, '');
  const L = m => log(`[${acc.name}] Discord: ${m}`);
  let tab;
  try {
    tab = await ctx.newPage();
    L('otwieram discord.com');
    await tab.goto('https://discord.com/login', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await humanize(tab, 'discord-prime');
    // Discord usuwa window.localStorage – przez ramkę iframe nadal da się zapisać w tej samej domenie
    await tab.evaluate((k, t) => {
      const ifr = document.createElement('iframe');
      document.body.appendChild(ifr);
      ifr.contentWindow.localStorage.setItem(k, JSON.stringify(t));
    }, key, token);
    L(`zapisano token w localStorage (klucz „${key}”), odświeżam`);
    await sleep(500);
    await tab.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    const ok = await tab.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 15000 })
      .then(() => true).catch(() => false);
    L(ok ? `zalogowano (${new URL(tab.url()).pathname})` : 'token nie zadziałał – nadal ekran logowania (sprawdź token)');
  } catch (e) {
    L(`błąd – ${errMsg(e)}`);
  } finally {
    if (tab) await tab.close().catch(() => {});
  }
}

const idSel = id => `[id="${String(id).replace(/"/g, '\\"')}"]`;
const targetsOf = pg => [...(pg.targetId ? [idSel(pg.targetId.replace(/^#/, ''))] : []), ...(pg.selectors || [])];

// ---------- skanowanie ----------
async function scanWorker() {
  BOT.scanning = true;
  BOT.stop = false;
  log('Skanowanie: start');
  let browser;
  try {
    const s = load();
    const acc = s.accounts.find(a => a.active !== false) || null;
    browser = await launchBrowser();
    const ctx = await browser.createBrowserContext();
    CTX_META.set(ctx, { accId: acc ? acc.id : null, name: acc ? `${acc.name} (skan)` : 'skan' });
    const page = await ctx.newPage();
    setupPage(page);
    if (hasAutoLogin(acc)) { if (acc.token) log(`Skan: konto ma auto-logowanie – używam go zamiast tokenu`); }
    else { await primeDiscord(ctx, acc); await configurePage(page, acc, s.pages); }   // token tylko bez auto-logowania
    try { await loginIfConfigured(page, acc); } catch (e) { log(`Skan: błąd logowania – ${errMsg(e)}`); }
    for (const pg of s.pages) {
      const info = { at: new Date().toTimeString().slice(0, 8), account: acc ? acc.name : null };
      try {
        const resp = await goto(page, pg.url, { human: true, label: 'skan' });
        info.status = resp ? resp.status() : null;
        info.title = await page.title();
        // wszystkie liczniki jednym zapytaniem do strony (zamiast tworzyć uchwyty do każdego elementu)
        const targets = targetsOf(pg);
        const counts = await page.evaluate(sels => sels.map(q => document.querySelectorAll(q).length),
          ['a', 'input, textarea, select', 'button, [type=submit]', ...targets]);
        [info.links, info.inputs, info.buttons] = counts;
        info.matches = {};
        targets.forEach((sel, i) => { info.matches[sel] = counts[3 + i]; });
        const miss = Object.entries(info.matches).filter(([, n]) => !n).map(([k]) => k);
        log(`Skan OK: ${pg.url} (${info.status})${miss.length ? ' – brak: ' + miss.join(', ') : ''}`);
      } catch (e) {
        info.error = errMsg(e);
        log(`Skan BŁĄD: ${pg.url} – ${info.error}`);
      }
      const cur = load();
      const x = cur.pages.find(p => p.id === pg.id);
      if (x) { x.scan = info; save(cur); }
    }
    await ctx.close();
  } catch (e) {
    log(`Skanowanie przerwane: ${errMsg(e)}`);
  } finally {
    await closeBrowser(browser, { delayMs: CLOSE_DELAY_MS });
    BOT.scanning = false;
    log('Skanowanie: koniec');
  }
}

// ---------- skrypty stron: strony/<domena>.js ----------
const SITE_CACHE = new Map();   // plik -> { mtimeMs, mod }
function loadSiteScripts() {
  if (!fs.existsSync(STRONY_DIR)) fs.mkdirSync(STRONY_DIR, { recursive: true });
  const out = [];
  for (const f of fs.readdirSync(STRONY_DIR)) {
    if (!f.endsWith('.js')) continue;
    const p = path.join(STRONY_DIR, f);
    try {
      const mtimeMs = fs.statSync(p).mtimeMs;
      let c = SITE_CACHE.get(f);
      if (!c || c.mtimeMs !== mtimeMs) {          // zmiany w pliku działają bez restartu
        delete require.cache[require.resolve(p)];
        c = { mtimeMs, mod: require(p) };
        SITE_CACHE.set(f, c);
      }
      out.push({ file: f, ...c.mod });
    } catch (e) { log(`strony/${f}: błąd wczytywania – ${errMsg(e)}`); }
  }
  return out;
}
const bareHost = h => String(h).replace(/^www\./, '');
function siteFor(sites, urlStr) {
  let host; try { host = bareHost(new URL(urlStr).hostname); } catch { return null; }
  return sites.find(s => [path.basename(s.file, '.js'), ...(s.hosts || [])].map(bareHost).includes(host)) || null;
}
function siteFileFor(urlStr) {   // tylko do wyświetlenia w panelu (bez require)
  try {
    const f = bareHost(new URL(urlStr).hostname) + '.js';
    return fs.existsSync(path.join(STRONY_DIR, f)) ? f : null;
  } catch { return null; }
}
async function clickFirst(page, selectors, { timeout = 8000 } = {}) {
  const sel = [].concat(selectors).join(', ');
  await page.waitForSelector(sel, { visible: true, timeout });
  await page.click(sel);
}

/** Po wejściu na stronę sprawdza, na jakim jest adresie (też po przekierowaniach)
 *  i odpala pasujące kroki ze skryptu domeny. Każdy krok najwyżej raz na wizytę. */
async function runSiteSteps(page, accName, acc, startUrl) {
  const sites = loadSiteScripts(), done = new Set(), executed = [];
  const findStep = () => {
    const cur = new URL(page.url());
    const site = siteFor(sites, cur.href);
    const step = site && (site.steps || []).find(s => !done.has(s.name) && s.when(cur));
    return { cur, site, step };
  };
  for (let i = 0; i < 10 && !BOT.stop; i++) {
    let { cur, site, step } = findStep();
    if (!step) {
      // Przekierowanie (np. na topv.gg/pl/login) może nastąpić chwilę PO załadowaniu strony (JS/Next.js),
      // więc zanim uznamy, że nic nie pasuje, dajemy mu czas. Po wykonanym kroku czekamy krócej, a na domenie
      // BEZ skryptu w strony/ – bardzo krótko (chyba że adres zacznie się zmieniać: wtedy przekierowanie trwa).
      const full = executed.length ? REDIRECT_GRACE_AFTER_STEP_MS : REDIRECT_GRACE_MS;
      const quick = site ? full : Math.min(full, REDIRECT_GRACE_NO_SITE_MS);
      const startUrl0 = page.url();
      let seen = startUrl0, deadline = Date.now() + quick;
      while (!step && !BOT.stop && Date.now() < deadline) {
        await sleep(250);
        ({ cur, site, step } = findStep());
        if (!step && page.url() !== seen) { seen = page.url(); deadline = Date.now() + (site ? full : quick); }
      }
      if (step && page.url() !== startUrl0) log(`[${accName}] wykryto przekierowanie: ${startUrl0} → ${page.url()}`);
      if (!step) break;
    }
    done.add(step.name);
    const L = m => log(`[${accName}] ${site.file} › ${step.name}: ${m}`);
    L('start');
    try {
      await step.run({ page, url: cur, startUrl, acc, log: L, sleep, click: (sel, o) => clickFirst(page, sel, o), humanize: (p) => humanize(p || page, step.name) });
      executed.push(step.name);
    } catch (e) { L('błąd – ' + errMsg(e)); break; }
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
  }
  return executed;
}

// ---------- bot ----------
async function runPage(page, pg, accName, acc) {
  await goto(page, pg.url, { human: true, label: accName });
  await resolveChallenge(page, acc, m => log(`[${accName}] ${m}`), pg.url, { shouldStop: () => BOT.stop });   // np. „Just a moment…” zanim ruszą kroki
  const row = { account: accName, url: pg.url, at: new Date().toISOString(), data: {}, searched: null };
  row.steps = await runSiteSteps(page, accName, acc, pg.url);   // pg.url = adres, od którego bot zaczął (kroki mogą do niego wrócić)

  // jeśli kroki (np. logowanie przez Discord) wyprowadziły bota na inną domenę – nie czytamy cudzej strony
  if (bareHost(new URL(page.url()).host) !== bareHost(new URL(pg.url).host)) {
    log(`[${accName}] ${pg.url} – bot jest teraz na ${new URL(page.url()).host}, pomijam odczyt`);
    fs.appendFileSync(RESULTS_FILE, JSON.stringify(row) + '\n');
    return;
  }

  // 1) szukanie po ID i wpisanie frazy (akcja "search")
  if (pg.targetId && pg.action === 'search') {
    const sel = idSel(pg.targetId.replace(/^#/, ''));
    const box = await page.$(sel);
    if (!box) {
      log(`[${accName}] ${pg.url} – nie znaleziono elementu #${pg.targetId}`);
    } else {
      await fillInput(page, sel, pg.query || '');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => {}),
        page.keyboard.press('Enter'),
      ]);
      row.searched = { query: pg.query || '', resultUrl: page.url(), title: await page.title() };
      log(`[${accName}] wyszukano „${pg.query}” w #${pg.targetId} → ${page.url()}`);
    }
  }

  // 2) odczyt zaznaczonych elementów (+ element o podanym ID przy akcji "read")
  const sels = pg.action === 'search' ? (pg.selectors || []) : targetsOf(pg);
  for (const sel of sels) {
    const texts = await page.$$eval(sel, els => els.slice(0, 20).map(e => (e.innerText || e.textContent || '').trim().slice(0, 300)));
    row.data[sel] = texts;
    if (!texts.length) log(`[${accName}] ${pg.url} – brak elementu ${sel}`);
  }
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(row) + '\n');
  const got = Object.values(row.data).reduce((a, v) => a + v.length, 0);
  log(`[${accName}] ${pg.url} – pobrano ${got} wartości`);
}

async function botWorker() {
  Object.assign(BOT, { running: true, stop: false });
  log('Bot: start (puppeteer-real-browser, turnstile: true)');
  let browser;
  try {
    const s = load();
    const accounts = s.accounts.filter(a => a.active !== false);
    if (!accounts.length) accounts.push(null);
    browser = await launchBrowser();
    for (const acc of accounts) {
      if (BOT.stop) break;
      const name = acc ? acc.name : '(bez konta)';
      const ctx = await browser.createBrowserContext();
      CTX_META.set(ctx, { accId: acc ? acc.id : null, name });
      const page = await ctx.newPage();
      setupPage(page);
      const autoLogin = hasAutoLogin(acc);
      if (autoLogin) { if (acc.token) log(`[${name}] auto-logowanie ma pierwszeństwo – token pomijam`); }
      else { await primeDiscord(ctx, acc); await configurePage(page, acc, s.pages); }   // token tylko bez auto-logowania
      try {
        await loginIfConfigured(page, acc);
        if (acc) log(`[${name}] gotowe${autoLogin ? ' (auto-logowanie)' : acc.token ? ' (token ustawiony)' : ''}`);
      } catch (e) {
        log(`[${name}] błąd logowania: ${errMsg(e)}`);
        await ctx.close();
        continue;
      }
      for (const pg of s.pages) {
        if (BOT.stop) break;
        try { await runPage(page, pg, name, acc); }
        catch (e) { log(`[${name}] ${pg.url} – błąd: ${errMsg(e)}`); }
        await sleepStop(DELAY_MS);
      }
      await ctx.close();
    }
  } catch (e) {
    log(`Bot: błąd krytyczny: ${errMsg(e)}`);
  } finally {
    await closeBrowser(browser, { delayMs: CLOSE_DELAY_MS });
    log(BOT.stop ? 'Bot: zatrzymany' : 'Bot: koniec');
    BOT.running = false;
  }
}

// ---------- API ----------
app.get('/api/state', (req, res) => res.json(publicState()));

app.post('/api/accounts', (req, res) => {
  const d = req.body, s = load();
  let acc = s.accounts.find(a => a.id === d.id);
  if (!acc) { acc = { id: uid(), active: true }; s.accounts.push(acc); }
  for (const k of ['name', 'login', 'login_url', 'user_sel', 'pass_sel', 'submit_sel', 'token_mode', 'token_name'])
    if (k in d) acc[k] = String(d[k] || '').trim();
  if (d.password) acc.password = d.password;
  if (d.token) acc.token = d.token.trim();
  if (d.clear_token) delete acc.token;
  if ('active' in d) acc.active = !!d.active;
  save(s);
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', (req, res) => {
  const s = load();
  s.accounts = s.accounts.filter(a => a.id !== req.params.id);
  save(s);
  res.json({ ok: true });
});

app.post('/api/pages', (req, res) => {
  let url = String(req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { return res.status(400).json({ error: 'Nieprawidłowy adres' }); }
  const s = load();
  s.pages.push({ id: uid(), url, selectors: [], targetId: '', action: 'read', query: '' });
  save(s);
  res.json({ ok: true });
});

app.delete('/api/pages/:id', (req, res) => {
  const s = load();
  s.pages = s.pages.filter(p => p.id !== req.params.id);
  save(s);
  res.json({ ok: true });
});

app.post('/api/pages/:id', (req, res) => {
  const s = load();
  const p = s.pages.find(x => x.id === req.params.id);
  if (p) {
    const d = req.body;
    p.selectors = Array.isArray(d.selectors) ? d.selectors : [];
    p.targetId = String(d.targetId || '').trim().replace(/^#/, '');
    p.action = d.action === 'search' ? 'search' : 'read';
    p.query = String(d.query || '');
    save(s);
  }
  res.json({ ok: true });
});

app.post('/api/settings', (req, res) => {
  const s = load();
  s.settings = s.settings || {};
  if ('headless' in req.body) s.settings.headless = !!req.body.headless;
  if ('cpuLimit' in req.body) { const v = Number(req.body.cpuLimit); if (req.body.cpuLimit !== '' && validCpu(v)) { s.settings.cpuLimit = v; cpuLimitPct = v; } }
  if ('maxJoins' in req.body) { const v = Number(req.body.maxJoins); if (Number.isInteger(v) && v >= 0 && v <= 100) s.settings.maxJoins = v; }
  save(s);
  log(`Ustawienie: przeglądarka ${s.settings.headless === false ? 'WIDOCZNA' : 'ukryta'} (od następnego uruchomienia)`);
  res.json({ ok: true, headless: isHeadless() });
});

app.post('/api/scan', (req, res) => { if (!BOT.scanning && !BOT.running) scanWorker(); res.json({ ok: true }); });
app.post('/api/start', (req, res) => { if (!BOT.running && !BOT.scanning) botWorker(); res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { BOT.stop = true; pause.cancelAll(); res.json({ ok: true }); });
app.post('/api/accounts/:id/resume', (req, res) => res.json({ ok: pause.resume(req.params.id) }));

/** Podgląd: strona wyrenderowana w Chrome (opcjonalnie jako wybrane konto),
 *  bez skryptów, z <base>, żeby CSS i obrazki ładowały się z oryginału. */
const PREVIEW = { browser: null, launching: null, busy: 0, timer: null };
/** Przeglądarka dla /preview: żywa przeglądarka bota, a gdy jej nie ma – jedna wspólna, zamykana po bezczynności. */
async function acquirePreviewBrowser() {
  const live = [...LIVE.browsers].find(b => b.isConnected());
  if (live) return { browser: live, release() {} };
  clearTimeout(PREVIEW.timer);
  if (!PREVIEW.browser || !PREVIEW.browser.isConnected()) {
    PREVIEW.launching = PREVIEW.launching || launchBrowser({ forceHeadless: true, track: false })
      .finally(() => { PREVIEW.launching = null; });
    PREVIEW.browser = await PREVIEW.launching;
  }
  PREVIEW.busy++;
  return {
    browser: PREVIEW.browser,
    release() {
      if (--PREVIEW.busy > 0) return;
      PREVIEW.timer = setTimeout(() => { const b = PREVIEW.browser; PREVIEW.browser = null; closeBrowser(b); }, PREVIEW_IDLE_MS);
      PREVIEW.timer.unref();
    },
  };
}

/** Podgląd: strona wyrenderowana w Chrome (opcjonalnie jako wybrane konto),
 *  bez skryptów, z <base>, żeby CSS i obrazki ładowały się z oryginału. */
app.get('/preview', async (req, res) => {
  const url = String(req.query.url || '');
  let lease, ctx;
  try {
    new URL(url);
    const acc = load().accounts.find(a => a.id === req.query.account) || null;
    lease = await acquirePreviewBrowser();
    ctx = await lease.browser.createBrowserContext();
    CTX_META.set(ctx, { hidden: true });           // nie pokazuj w „Karty przeglądarki”
    const page = await ctx.newPage();
    setupPage(page);
    await page.setViewport({ width: 1280, height: 800 });
    await configurePage(page, acc, [{ url }]);
    await loginIfConfigured(page, acc).catch(() => {});
    await goto(page, url, { human: false });
    let html = await page.content();
    const final = page.url();
    html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    const base = `<base href="${final.replace(/"/g, '&quot;')}">`;
    html = /<head[^>]*>/i.test(html) ? html.replace(/(<head[^>]*>)/i, `$1${base}`) : base + html;
    res.type('html').send(html);
  } catch (e) {
    res.type('html').send(`<body style="font:16px sans-serif;padding:2rem">Nie udało się wczytać strony:<br><b>${errMsg(e).replace(/</g, '&lt;')}</b></body>`);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    if (lease) lease.release();
  }
});

// ---------- czyszczenie Discordów (opuszczanie serwerów przez API Discorda, tokenem konta) ----------
const DISCORD_API = 'https://discord.com/api/v9';
const DISCORD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DISCORD_HEADERS = {
  'User-Agent': DISCORD_UA,
  'Accept': '*/*',
  'Accept-Language': 'pl-PL,pl;q=0.9',
  'X-Discord-Locale': 'pl',
  'Origin': 'https://discord.com',
  'Referer': 'https://discord.com/channels/@me',
  'X-Super-Properties': Buffer.from(JSON.stringify({
    os: 'Windows', browser: 'Chrome', device: '', system_locale: 'pl-PL',
    browser_user_agent: DISCORD_UA, browser_version: '131.0.0.0', os_version: '10',
  })).toString('base64'),
};
const LEAVE_JOBS = {};   // id konta -> { running, cancel, total, done, results: [{ id, ok, error? }] }

/** Konto z tokenem Discorda (tryb „Discord – localStorage na discord.com”) albo komunikat błędu. */
function discordAcc(id) {
  const acc = load().accounts.find(a => a.id === id);
  if (!acc) return { error: 'Nie ma takiego konta' };
  if (!acc.token || acc.token_mode !== 'discord')
    return { error: 'To konto nie ma tokenu Discord (ustaw tryb „Discord – localStorage na discord.com” i wklej token)' };
  return { acc };
}

/** Zapytanie do API Discorda; przy 429 czeka tyle, ile każe Discord, i ponawia. */
async function discordFetch(acc, method, urlPath, body) {
  const token = String(acc.token).trim().replace(/^"+|"+$/g, '');
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(DISCORD_API + urlPath, {
      method,
      headers: { ...DISCORD_HEADERS, Authorization: token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status !== 429) return r;
    const j = await r.json().catch(() => ({}));
    await sleep(Math.min((Number(j.retry_after) || 2) * 1000 + 500, 60000));
  }
  throw new Error('Discord ciągle zwraca limit zapytań (429) – spróbuj za chwilę');
}

async function discordErrorText(r) {
  const j = await r.json().catch(() => ({}));
  const m = j && j.message ? ` – ${j.message}` : '';
  if (r.status === 401) return 'Token nieważny albo konto wylogowane (401)';
  if (r.status === 403) return `Discord odrzucił żądanie (403)${m}`;
  return `Discord: HTTP ${r.status}${m}`;
}

/** Konto + wszystkie jego serwery. */
app.get('/api/discord/:id/guilds', async (req, res) => {
  const { acc, error } = discordAcc(req.params.id);
  if (error) return res.json({ ok: false, error });
  try {
    const meR = await discordFetch(acc, 'GET', '/users/@me');
    if (!meR.ok) return res.json({ ok: false, error: await discordErrorText(meR) });
    const me = await meR.json();

    const all = [];
    let after = null;
    for (;;) {
      const r = await discordFetch(acc, 'GET', `/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`);
      if (!r.ok) return res.json({ ok: false, error: await discordErrorText(r) });
      const part = await r.json();
      all.push(...part);
      if (part.length < 200) break;
      after = part[part.length - 1].id;
    }
    const guilds = all
      .map(g => ({ id: g.id, name: g.name, owner: !!g.owner, icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pl', { sensitivity: 'base' }));
    res.json({
      ok: true,
      me: { id: me.id, name: me.global_name || me.username, username: me.username,
            avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null },
      guilds,
    });
  } catch (e) {
    res.json({ ok: false, error: 'Nie udało się połączyć z Discordem: ' + (e.message || e) });
  }
});

/** Start opuszczania zaznaczonych serwerów (w tle, z przerwami – Discord limituje tempo). */
app.post('/api/discord/:id/leave', (req, res) => {
  const { acc, error } = discordAcc(req.params.id);
  if (error) return res.json({ ok: false, error });
  if (BOT.running) return res.json({ ok: false, error: 'Bot działa – zatrzymaj go przed opuszczaniem serwerów (inaczej cofniesz mu dołączenia)' });
  if (LEAVE_JOBS[acc.id] && LEAVE_JOBS[acc.id].running) return res.json({ ok: false, error: 'Opuszczanie dla tego konta już trwa' });
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String).filter(x => /^\d{5,25}$/.test(x)))];
  if (!ids.length) return res.json({ ok: false, error: 'Nie zaznaczono żadnych serwerów' });

  const job = LEAVE_JOBS[acc.id] = { running: true, cancel: false, total: ids.length, done: 0, results: [] };
  res.json({ ok: true, total: ids.length });

  (async () => {
    log(`[${acc.name}] Discord: opuszczam ${ids.length} serwerów…`);
    for (const gid of ids) {
      if (job.cancel) break;
      try {
        const r = await discordFetch(acc, 'DELETE', `/users/@me/guilds/${gid}`, { lurking: false });
        if (r.ok) job.results.push({ id: gid, ok: true });
        else {
          const err = await discordErrorText(r);
          job.results.push({ id: gid, ok: false, error: err });
          if (r.status === 401) { job.done++; break; }          // token martwy – nie ma sensu dalej
        }
      } catch (e) {
        job.results.push({ id: gid, ok: false, error: String(e.message || e) });
      }
      job.done++;
      await sleep(1500 + Math.random() * 1500);                  // przerwa między kolejnymi wyjściami
    }
    job.running = false;
    const ok = job.results.filter(r => r.ok).length;
    log(`[${acc.name}] Discord: opuszczono ${ok} z ${ids.length} serwerów${job.cancel ? ' (przerwano)' : ''}${ok < job.results.length ? `, błędy: ${job.results.length - ok}` : ''}`);
  })();
});

app.get('/api/discord/:id/leave-status', (req, res) => {
  const j = LEAVE_JOBS[req.params.id];
  res.json(j ? { running: j.running, total: j.total, done: j.done, results: j.results, cancelled: j.cancel }
             : { running: false, total: 0, done: 0, results: [] });
});

app.post('/api/discord/:id/leave-cancel', (req, res) => {
  const j = LEAVE_JOBS[req.params.id];
  if (j && j.running) j.cancel = true;
  res.json({ ok: true });
});

// ---------- podgląd i sterowanie kartami przeglądarki z panelu (np. captcha, gdy bot stoi na serwerze bez ekranu) ----------
const TAB_IDS = new WeakMap(); let tabSeq = 0;
const tabIdOf = p => { if (!TAB_IDS.has(p)) TAB_IDS.set(p, ++tabSeq); return TAB_IDS.get(p); };

/** Wszystkie otwarte karty wszystkich żywych przeglądarek, z kontem, do którego należą. */
async function allTabs() {
  const out = [];
  for (const browser of [...LIVE.browsers]) {
    let ctxs = [];
    try { ctxs = browser.browserContexts(); } catch { continue; }
    for (const ctx of ctxs) {
      const meta = CTX_META.get(ctx) || {};
      if (meta.hidden) continue;                 // np. kontekst podglądu /preview
      let pages = [];
      try { pages = await ctx.pages(); } catch { continue; }
      for (const page of pages) if (!page.isClosed()) out.push({ id: tabIdOf(page), page, accId: meta.accId || null, account: meta.name || null });
    }
  }
  return out;
}

function numIn(v, lo, hi, what = 'współrzędna') {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`Nieprawidłowa ${what}`);
  return n;
}
const KEY_RE = /^(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2])|Enter|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Space|Arrow(?:Up|Down|Left|Right))$/;
const MOD_RE = /^(?:Control|Shift|Alt|Meta)$/;

/** Wspólna obsługa: znajdź kartę, wykonaj akcję, odpowiedz {ok}. */
async function tabRoute(req, res, fn) {
  try {
    const t = (await allTabs()).find(x => x.id === Number(req.params.id));
    if (!t) return res.status(404).json({ ok: false, error: 'Ta karta już nie istnieje (odśwież listę)' });
    const out = await withTimeout(Promise.resolve(fn(t.page, req.body || {})), 45000);
    res.json({ ok: true, ...(out || {}) });
  } catch (e) {
    res.json({ ok: false, error: String((e && e.message) || e).split('\n')[0] });
  }
}

app.get('/api/tabs', async (req, res) => {
  const W = Object.fromEntries(pause.list().map(w => [w.id, w.label]));
  const tabs = await Promise.all((await allTabs()).map(async t => ({
    id: t.id, url: t.page.url(), account: t.account, accId: t.accId,
    title: await withTimeout(t.page.title(), 1500).catch(() => ''),
    waiting: t.accId && W[t.accId] ? W[t.accId] : null,
  })));
  res.json({ ok: true, running: BOT.running || BOT.scanning, tabs });
});

/** Aktualny widok karty jako JPEG; rozmiar okna strony (CSS px) w nagłówku X-Viewport, potrzebny do przeliczenia kliknięć. */
app.get('/api/tabs/:id/screen.jpg', async (req, res) => {
  try {
    const t = (await allTabs()).find(x => x.id === Number(req.params.id));
    if (!t) return res.status(404).json({ ok: false, error: 'Ta karta już nie istnieje (odśwież listę)' });
    const quality = Math.min(90, Math.max(20, parseInt(req.query.q) || 55));
    const vpo = t.page.viewport();                // gdy ustawiony, nie trzeba pytać strony o rozmiar okna
    const [buf, vp] = await withTimeout(Promise.all([
      t.page.screenshot({ type: 'jpeg', quality, captureBeyondViewport: false, optimizeForSpeed: true }),
      vpo ? [vpo.width, vpo.height] : t.page.evaluate(() => [window.innerWidth, window.innerHeight]).catch(() => null),
    ]), 10000, 'Karta nie odpowiada (przekroczono czas)');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    if (Array.isArray(vp)) res.set('X-Viewport', `${vp[0]}x${vp[1]}`);
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(504).json({ ok: false, error: String((e && e.message) || e).split('\n')[0] });
  }
});

app.post('/api/tabs/:id/front', (req, res) => tabRoute(req, res, page => page.bringToFront()));

app.post('/api/tabs/:id/click', (req, res) => tabRoute(req, res, async (page, b) => {
  const x = numIn(b.x, 0, 20000), y = numIn(b.y, 0, 20000);
  const button = ['left', 'right', 'middle'].includes(b.button) ? b.button : 'left';
  const clickCount = Math.min(3, Math.max(1, parseInt(b.count) || 1));
  await page.mouse.move(x, y, { steps: 6 });                // „ludzkie” kliknięcie: dojazd, krótka pauza, wciśnięcie, puszczenie
  await sleep(40 + Math.random() * 60);
  await page.mouse.down({ button, clickCount });
  await sleep(40 + Math.random() * 80);
  await page.mouse.up({ button, clickCount });
}));

app.post('/api/tabs/:id/type', (req, res) => tabRoute(req, res, async (page, b) => {
  const text = String(b.text == null ? '' : b.text);
  if (!text || text.length > 2000) throw new Error('Tekst musi mieć od 1 do 2000 znaków');
  await page.keyboard.type(text, { delay: 20 + Math.floor(Math.random() * 40) });
}));

app.post('/api/tabs/:id/key', (req, res) => tabRoute(req, res, async (page, b) => {
  const parts = String(b.key || '').split('+');
  const main = parts.pop();
  if (!KEY_RE.test(main) || parts.some(m => !MOD_RE.test(m))) throw new Error('Niedozwolony klawisz');
  for (const m of parts) await page.keyboard.down(m);
  try { await page.keyboard.press(main); }
  finally { for (const m of [...parts].reverse()) await page.keyboard.up(m); }
}));

app.post('/api/tabs/:id/scroll', (req, res) => tabRoute(req, res, async (page, b) => {
  const x = numIn(b.x == null ? 400 : b.x, 0, 20000), y = numIn(b.y == null ? 300 : b.y, 0, 20000);
  const dx = numIn(b.dx || 0, -5000, 5000, 'wartość przewinięcia'), dy = numIn(b.dy || 0, -5000, 5000, 'wartość przewinięcia');
  await page.mouse.move(x, y);
  await page.mouse.wheel({ deltaX: dx, deltaY: dy });
}));

app.post('/api/tabs/:id/goto', (req, res) => tabRoute(req, res, async (page, b) => {
  let raw = String(b.url || '').trim();
  if (raw && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  let u; try { u = new URL(raw); } catch { throw new Error('Nieprawidłowy adres'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Dozwolone są tylko adresy http(s)');
  await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
}));

app.post('/api/tabs/:id/nav', (req, res) => tabRoute(req, res, async (page, b) => {
  const opt = { waitUntil: 'domcontentloaded', timeout: 30000 };
  if (b.action === 'back') await page.goBack(opt);
  else if (b.action === 'forward') await page.goForward(opt);
  else if (b.action === 'reload') await page.reload(opt);
  else throw new Error('Nieznana akcja');
}));

app.post('/api/tabs/:id/close', (req, res) => tabRoute(req, res, page => page.close()));
mountDevtools(app, { tabRoute, withTimeout });

// ---------- limit CPU (cpulimit.js): % jednego rdzenia dla całej przeglądarki bota; 0 = bez limitu ----------
const validCpu = v => Number.isFinite(v) && v >= 0 && v <= 800;
const CPU_LIMIT_ENV = process.env.CPU_LIMIT !== undefined && process.env.CPU_LIMIT !== '' ? Number(process.env.CPU_LIMIT) : 35;
const savedCpu = (load().settings || {}).cpuLimit;
let cpuLimitPct = savedCpu !== undefined && savedCpu !== '' && validCpu(Number(savedCpu)) ? Number(savedCpu) : (validCpu(CPU_LIMIT_ENV) ? CPU_LIMIT_ENV : 35);

const ROOT_PIDS = new WeakMap();   // przeglądarka -> pid głównego procesu Chrome (z portu zdalnego debugowania)
function browserRootPid(b) {
  let pid = ROOT_PIDS.get(b);
  if (pid && fs.existsSync(`/proc/${pid}`)) return pid;
  try { pid = findRootByPort(new URL(b.wsEndpoint()).port); } catch { pid = null; }
  if (pid) ROOT_PIDS.set(b, pid);
  return pid;
}
const governor = new CpuGovernor({
  getLimit: () => cpuLimitPct,
  getRoots: () => [...LIVE.browsers, ...(PREVIEW.browser ? [PREVIEW.browser] : [])].map(browserRootPid).filter(Boolean),
});
if (governor.supported) governor.start();
else if (cpuLimitPct > 0) console.log('Limit CPU: dostępny tylko na Linuksie – pomijam.');
process.on('exit', () => governor.release());   // nie zostawiaj zamrożonych procesów Chrome

// Błąd w tle (np. zamknięta karta w środku operacji puppeteera) nie może ubić całego panelu.
process.on('unhandledRejection', e => log(`Nieobsłużony błąd (async): ${errMsg(e)}`));
process.on('uncaughtException', e => { log(`Nieobsłużony wyjątek: ${errMsg(e)}`); console.error(e); });

// Zatrzymanie procesu (hosting wysyła SIGTERM): zamknij przeglądarki i sprzątnij profile, żeby nie zostały procesy Chrome.
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${sig}: zamykam przeglądarki…`);
  BOT.stop = true; pause.cancelAll(); governor.stop();
  const all = [...LIVE.browsers, ...(PREVIEW.browser ? [PREVIEW.browser] : [])];
  await Promise.all(all.map(b => closeBrowser(b)));
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

app.listen(PORT, HOST, () => {
  console.log(`Panel: ${process.env.PUBLIC_URL || `http://${HOST === '0.0.0.0' ? '<adres serwera>' : HOST}:${PORT}`}${IS_HOSTED ? '  [tryb hosting: chrome-headless-shell]' : ''}`);
  if (PASSWORD_GENERATED) {
    console.log(`\n=== PANEL JEST DOSTĘPNY Z SIECI, WIĘC USTAWIŁEM HASŁO ===\n  login: ${PANEL_USER}\n  hasło: ${PANEL_PASSWORD}\n  (zapisane w panel-password.txt; własne hasło ustawisz zmienną PANEL_PASSWORD)\n`);
  } else if (PANEL_PASSWORD) {
    console.log(`Panel wymaga logowania (login: ${PANEL_USER}).`);
  }
});
