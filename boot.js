/**
 * Start na hostingu (bez roota, zapisywalny tylko /tmp): instaluje zależności i chrome-headless-shell
 * WYŁĄCZNIE gdy trzeba, ustawia CHROME_PATH i uruchamia server.js (który wtedy działa w trybie „hosting”).
 */
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.chdir(__dirname);
const TMP = os.tmpdir();   // zwykle /tmp

// katalogi robocze Chrome / npm w zapisywalnym miejscu (ustawiamy PRZED zbudowaniem env dla procesów potomnych)
process.env.HOME = TMP;
process.env.XDG_CONFIG_HOME = TMP;
process.env.XDG_CACHE_HOME = TMP;
const env = {
  ...process.env,
  npm_config_cache: path.join(TMP, 'npm-cache'),
  PUPPETEER_SKIP_DOWNLOAD: '1',            // przeglądarkę pobieramy sami (chrome-headless-shell), nie przy npm install
  PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: '1',
};
const run = cmd => execSync(cmd, { stdio: 'inherit', env });
const SHELL_DIR = path.join(__dirname, 'shell');

/** Zależności: instalujemy, gdy brak node_modules albo zmienił się package.json / package-lock.json. */
function ensureDeps() {
  const files = ['package.json', 'package-lock.json'].filter(f => fs.existsSync(f));
  const stamp = crypto.createHash('sha1').update(files.map(f => fs.readFileSync(f)).join('\0')).digest('hex');
  const stampFile = path.join('node_modules', '.boot-stamp');
  const have = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8') : null;
  if (fs.existsSync('node_modules') && have === stamp) return;
  console.log('Instaluję zależności…');
  run('npm install --omit=dev --prefer-offline --no-fund --no-audit --loglevel=error');
  fs.writeFileSync(stampFile, stamp);       // stempel tylko po udanej instalacji
}

function findShell(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findShell(p); if (r) return r; }
    else if (e.name === 'chrome-headless-shell') return p;
  }
  return null;
}

function ensureShell() {
  let bin = findShell(SHELL_DIR);
  if (!bin) {
    console.log('Pobieram chrome-headless-shell…');
    run(`npx --yes @puppeteer/browsers install chrome-headless-shell@stable --path "${SHELL_DIR}"`);
    bin = findShell(SHELL_DIR);
  }
  if (!bin) throw new Error('Nie znaleziono chrome-headless-shell w ' + SHELL_DIR);
  try { fs.chmodSync(bin, 0o755); fs.accessSync(bin, fs.constants.X_OK); }
  catch (e) { throw new Error(`chrome-headless-shell nie jest wykonywalny (${bin}): ${e.message}`); }
  return bin;
}

/** Resztki po poprzednim (ubitym) uruchomieniu: profile Chrome i katalogi tymczasowe chrome-launchera. Przy starcie nic z nich nie działa. */
function cleanStaleTemp() {
  try {
    for (const n of fs.readdirSync(TMP)) {
      if (/^(chrome-profile|lighthouse\.|puppeteer_dev_)/.test(n)) fs.rmSync(path.join(TMP, n), { recursive: true, force: true });
    }
  } catch {}
}

try {
  cleanStaleTemp();
  ensureDeps();
  const bin = ensureShell();
  process.env.CHROME_PATH = bin;
  process.env.BOT_HOSTED = '1';
  console.log('CHROME_PATH =', bin);
} catch (e) {
  console.error('Start przerwany:', e.message);
  process.exit(1);
}
require('./server.js');
