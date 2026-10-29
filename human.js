'use strict';
/**
 * Weryfikacja „czy jesteś człowiekiem” (captcha) – wspólne dla server.js i skryptów w strony/.
 *
 * inspectChallenge(page)  – co widać na stronie: { blocking, kinds }
 * resolveChallenge(...)   – jeśli coś blokuje: najpierw czeka, aż przejdzie samo (Turnstile klika puppeteer-real-browser),
 *                           potem robi zrzut ekranu i ZATRZYMUJE pracę konta aż do „Wznów pracę” w panelu (jak przy dołączaniu).
 * needHuman(...)          – zrzut ekranu + pauza (też do innych sytuacji „coś poszło nie tak”).
 *
 * Wyłączenie: zmienna CAPTCHA_PAUSE=0. Czas oczekiwania na samoistne przejście: CAPTCHA_AUTO_WAIT_MS (domyślnie 15000).
 */
const fs = require('fs');
const path = require('path');
const pause = require('./pause');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshoty');
const ENABLED = process.env.CAPTCHA_PAUSE !== '0';
const AUTO_WAIT_MS = Number(process.env.CAPTCHA_AUTO_WAIT_MS) || 15000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Zrzut ekranu + czekanie, aż ktoś kliknie „Wznów pracę” w panelu (true) albo praca zostanie zatrzymana (false).
 *  Zrzut: http://127.0.0.1:<port>/screenshoty/<plik>. */
async function needHuman(page, acc, log, reason) {
  let base = null;
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const who = String((acc && acc.name) || 'konto').replace(/[^\w.@-]+/g, '_');
    base = `${new Date().toISOString().replace(/[:.]/g, '-')}_${who}.png`;
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, base), fullPage: true });
  } catch (e) {
    log(`nie udało się zrobić zrzutu ekranu: ${String(e.message || e).split('\n')[0]}`);
    base = null;
  }
  log(`${reason} – zatrzymuję pracę${base ? `, zrzut ekranu: screenshoty/${base}` : ''}. Otwórz „Karty przeglądarki” w panelu, rozwiąż problem i kliknij „Wznów pracę”`);
  await page.bringToFront().catch(() => {});
  return pause.waitForHuman(acc && acc.id || 'default', base ? `${reason} · zrzut: /screenshoty/${base}` : reason);
}

/** Wykonywane W STRONIE (musi być samowystarczalne). Zwraca { blocking, kinds }. */
function pageProbe() {
  const visible = el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width >= 40 && r.height >= 30 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05
      && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const filled = sel => [...document.querySelectorAll(sel)].some(e => ((e.value || e.getAttribute('data-hcaptcha-response') || '') + '').length > 0);
  const kinds = [];

  // 1) pełnostronicowy ekran Cloudflare („Just a moment…”, „Chwileczkę…”)
  const titleHit = /just a moment|chwileczkę|checking your browser|attention required|verifying you are human|sprawdzanie|weryfikacja/i.test(document.title || '');
  if (titleHit && document.querySelector('script[src*="/cdn-cgi/challenge-platform/"], #challenge-form, #challenge-stage, #challenge-running')) kinds.push('cloudflare');

  // 2) widżety w ramkach – liczą się tylko WIDOCZNE i jeszcze nierozwiązane (rozwiązane mają wypełnioną odpowiedź)
  const providers = [
    ['turnstile', /challenges\.cloudflare\.com|turnstile/i, 'input[name="cf-turnstile-response"]'],
    ['hcaptcha', /hcaptcha\.com/i, 'textarea[name="h-captcha-response"], iframe[data-hcaptcha-response]'],
    ['recaptcha', /recaptcha/i, 'textarea[name="g-recaptcha-response"], #g-recaptcha-response'],
  ];
  for (const [kind, re, solvedSel] of providers) {
    const shown = [...document.querySelectorAll('iframe')].some(f => re.test(f.getAttribute('src') || '') && visible(f));
    if (shown && !filled(solvedSel)) kinds.push(kind);
  }

  // 3) awaryjnie: krótki, widoczny napis w stylu „Czy jesteś człowiekiem?” (gdy nie znaleziono nic powyżej)
  if (!kinds.length) {
    const re = /czy jesteś (człowiekiem|robotem)|jesteś człowiekiem\?|are you (a )?human|verify you are human|potwierdź,? że jesteś człowiekiem|zweryfikuj,? że jesteś człowiekiem/i;
    const hit = [...document.querySelectorAll('h1,h2,h3,label,legend,strong,span,div,p')]
      .some(e => e.children.length <= 3 && (e.textContent || '').trim().length <= 90 && re.test(e.textContent || '') && visible(e));
    if (hit) kinds.push('tekst');
  }
  return { blocking: kinds.length > 0, kinds };
}

/** Co blokuje stronę teraz. Błąd (np. trwa nawigacja) = nic nie blokuje. */
async function inspectChallenge(page) {
  if (!ENABLED) return { blocking: false, kinds: [] };
  try {
    const r = await page.evaluate(pageProbe);
    return r && typeof r === 'object' && Array.isArray(r.kinds) ? r : { blocking: false, kinds: [] };
  } catch { return { blocking: false, kinds: [] }; }
}

/**
 * Jeśli na stronie jest weryfikacja „czy jesteś człowiekiem”: czeka, aż przejdzie sama, a potem zatrzymuje pracę
 * i czeka na człowieka. Zwraca 'none' | 'auto' | 'human' | 'continued' | 'aborted'.
 * opts.autoWaitMs – ile czekać na samoistne przejście; opts.maxPauses – ile razy zatrzymać; opts.shouldStop – () => bool.
 */
async function resolveChallenge(page, acc, log, label = '', opts = {}) {
  const { autoWaitMs = AUTO_WAIT_MS, maxPauses = 3, shouldStop = () => false } = opts;
  let st = await inspectChallenge(page);
  if (!st.blocking) return 'none';

  const where = label ? ` (${label})` : '';
  log(`wykryto weryfikację „czy jesteś człowiekiem”${where}: ${st.kinds.join(', ')} – czekam do ${Math.round(autoWaitMs / 1000)} s, aż przejdzie sama`);
  const end = Date.now() + autoWaitMs;
  while (Date.now() < end) {
    if (shouldStop()) return 'aborted';
    await sleep(1000);
    st = await inspectChallenge(page);
    if (!st.blocking) { log('weryfikacja przeszła sama'); return 'auto'; }
  }

  for (let i = 0; i < maxPauses; i++) {
    if (shouldStop()) return 'aborted';
    const resumed = await needHuman(page, acc, log, `weryfikacja „czy jesteś człowiekiem”${where} – rozwiąż ją w „Karty przeglądarki”`);
    if (!resumed) { log('przerwano oczekiwanie na rozwiązanie weryfikacji'); return 'aborted'; }
    await sleep(1500);
    st = await inspectChallenge(page);
    if (!st.blocking) { log('weryfikacja rozwiązana – idę dalej'); return 'human'; }
  }
  log('po wznowieniu weryfikacja nadal wygląda na aktywną – ufam, że jest rozwiązana, idę dalej');
  return 'continued';
}

module.exports = { needHuman, inspectChallenge, resolveChallenge, pageProbe };
