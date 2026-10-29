const fs = require('fs');
const path = require('path');

function find(d) {
  if (!fs.existsSync(d)) return null;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { const r = find(p); if (r) return r; }
    else if (e.name === 'chrome-headless-shell') return p;
  }
  return null;
}

process.env.HOME = '/tmp';
process.env.XDG_CONFIG_HOME = '/tmp';
process.env.XDG_CACHE_HOME = '/tmp';
process.env.CHROME_PATH = find(path.join(__dirname, 'shell'));
console.log('CHROME_PATH =', process.env.CHROME_PATH);

const { connect } = require('puppeteer-real-browser');
(async () => {
  const { browser } = await connect({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
           '--user-data-dir=/tmp/chrome-profile', '--no-first-run'],
    customConfig: {},
    turnstile: true,
    connectOption: {},
    disableXvfb: true,
    ignoreAllFlags: false,
  });
  const page = await browser.newPage();
  await page.goto('https://example.com', { waitUntil: 'load', timeout: 20000 });
  console.log('TYTUŁ STRONY:', await page.title());
  await browser.close();
  console.log('OK, przeglądarka działa');
  process.exit(0);
})().catch(e => { console.log('BŁĄD:', e.message); process.exit(1); });