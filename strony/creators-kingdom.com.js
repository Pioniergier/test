/**
 * Kroki dla https://creators-kingdom.com/   (plik = nazwa domeny: strony/<domena>.js)
 * Wczytywany od nowa przy każdej wizycie – po zmianie nie trzeba restartować serwera.
 *
 * Przebieg:
 *   1) https://creators-kingdom.com/auth/login → „Continue with Discord” → logowanie tokenem → „Autoryzuj”
 *   2) wejście na link podany przez użytkownika (z panelu) – strona z listą serwerów (.contributor-row)
 *   3) dołączenie do każdego serwera, który nie ma jeszcze data-joined="1"
 *   4) kliknięcie „Verify Entry” (#verify-btn)
 *
 * Każdy krok:
 *   name – nazwa w logach (krok wykonuje się najwyżej raz na wizytę)
 *   when – (URL) => boolean – kiedy krok ma ruszyć (sprawdzane po każdym przekierowaniu)
 *   run  – async ({ page, url, acc, log, sleep, click, startUrl }) => {...}   (API Puppeteer)
 */

const fs = require('fs');
const path = require('path');
const pause = require('../pause');
const DATA_FILE = path.join(__dirname, '..', 'data.json');   // ten sam plik, który zapisuje panel

const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- link podany przez użytkownika ----------
/** Skąd bot bierze adres strony z listą serwerów (kolejność):
 *   1) startUrl – adres, od którego bot zaczął (jeśli to NIE jest strona logowania; ewentualnie z parametru redirect/callbackUrl/next),
 *   2) konto z data.json (pola z listy ACC_URL_KEYS),
 *   3) ustawienia panelu w data.json (pola z listy SETTINGS_URL_KEYS).
 *  Jeśli w Twoim panelu link zapisywany jest pod inną nazwą – dopisz ją do jednej z tych list. */
const ACC_URL_KEYS = ['target_url', 'targetUrl', 'giveaway_url', 'giveawayUrl', 'url', 'link'];
const SETTINGS_URL_KEYS = ['creatorsKingdomUrl', 'targetUrl', 'giveawayUrl', 'url', 'link'];

const isSiteUrl = u => { try { return /(^|\.)creators-kingdom\.com$/.test(new URL(u).hostname); } catch { return false; } };
const isLoginPath = p => /^\/auth\/login\/?$/.test(p);

function targetUrl(startUrl, acc) {
  // 1) startUrl
  try {
    const x = new URL(startUrl);
    if (isSiteUrl(x.href)) {
      if (!isLoginPath(x.pathname)) return x.href;
      for (const k of ['redirect', 'callbackUrl', 'next', 'returnTo', 'return_to']) {
        const v = x.searchParams.get(k);
        if (v) { const c = new URL(v, x.href); if (isSiteUrl(c.href) && !isLoginPath(c.pathname)) return c.href; }
      }
    }
  } catch {}
  // 2) + 3) data.json
  let d = {};
  try { d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  const fromAcc = a => { for (const k of ACC_URL_KEYS) if (a && typeof a[k] === 'string' && isSiteUrl(a[k])) return a[k].trim(); return null; };
  const a = acc && (fromAcc(acc) || fromAcc((d.accounts || []).find(x => x.id === acc.id)));
  if (a) return a;
  const s = d.settings || {};
  for (const k of SETTINGS_URL_KEYS) if (typeof s[k] === 'string' && isSiteUrl(s[k])) return s[k].trim();
  return null;
}

// ---------- token Discorda ----------
/** Token konta z data.json: najpierw z konta przekazanego przez bota (`acc` pochodzi z data.json),
 *  a gdyby go brakowało – czyta plik bezpośrednio (to samo konto po id, a bez konta – pierwsze aktywne z tokenem). */
function tokenFromData(acc) {
  if (acc && acc.token) return { token: String(acc.token).trim(), name: acc.token_name };
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const a = (d.accounts || []).find(x => x.token && (acc ? x.id === acc.id : x.active !== false));
    return a ? { token: String(a.token).trim(), name: a.token_name } : null;
  } catch { return null; }
}

/** Wpisuje token do localStorage na discord.com – tam Discord go czyta (klucz „token”, wartość jako JSON-string).
 *  Robi to w osobnej, krótkiej karcie; localStorage jest wspólny dla wszystkich kart tej domeny w tym kontekście. */
async function pasteTokenToDiscord(ctx, t, log) {
  const key = t.name || 'token';
  const token = String(t.token).trim().replace(/^"+|"+$/g, '');
  const tab = await ctx.newPage();
  try {
    await tab.goto('https://discord.com/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Discord usuwa window.localStorage – przez ramkę iframe nadal da się zapisać w tej samej domenie
    await tab.evaluate((k, v) => {
      const ifr = document.createElement('iframe');
      document.body.appendChild(ifr);
      ifr.contentWindow.localStorage.setItem(k, JSON.stringify(v));
    }, key, token);
    await wait(500);
    log(`wpisano token do localStorage na discord.com (klucz „${key}”, wartość z data.json)`);
    return true;
  } catch (e) {
    log(`błąd przy wpisywaniu tokenu do localStorage na discord.com: ${String(e.message || e).split('\n')[0]}`);
    return false;
  } finally {
    await tab.close().catch(() => {});
    log('zamknięto kartę discord.com');
  }
}

// ---------- pomocnicze ----------
/** Szuka widocznego elementu pasującego do selektora, którego tekst zawiera `text` (string) albo pasuje do wyrażenia (RegExp). */
async function findByText(page, selector, text, timeout = 10000) {
  const match = t => (text instanceof RegExp ? text.test(t) : t.includes(text));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const handles = await page.$$(selector);
    for (const h of handles) {
      const t = await page.evaluate(el => (el.innerText || el.textContent || '').trim(), h);
      if (match(t)) return h;
    }
    await wait(250);
  }
  return null;
}

/** Odpytuje po stronie Node (nie w stronie), aż fn() zwróci prawdziwą wartość albo minie czas. */
async function waitUntil(fn, timeout, every = 500) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() >= end) return null;
    await wait(every);
  }
}

const sameUrl = (a, b) => {
  try {
    const f = u => { const x = new URL(u); x.hash = ''; return x.href.replace(/\/$/, ''); };
    return f(a) === f(b);
  } catch { return false; }
};

const isDiscordUrl = u => { try { return /(^|\.)discord\.com$/.test(new URL(u).hostname); } catch { return false; } };
const isInviteUrl = u => { try { return /(^|\.)(discord\.gg|discord\.com|discordapp\.com)$/.test(new URL(u).hostname); } catch { return false; } };

/** Konto z auto-logowaniem (adres strony logowania) – wtedy token jest pomijany (tak samo robi bot w server.js). */
const hasAutoLogin = acc => !!(acc && acc.login_url);

/** Limit dołączeń na konto w jednym uruchomieniu – z panelu (settings.maxJoins), domyślnie 5. */
function joinLimit() {
  try { const v = Number((JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).settings || {}).maxJoins); if (Number.isInteger(v) && v >= 0) return v; } catch {}
  return 5;
}
const JOIN_DELAY_MS = 3000;   // przerwa między dołączeniami do kolejnych serwerów

// ---------- przekierowanie na Discorda po kliknięciu przycisku logowania ----------
/** Przycisk logowania zwykle NIE otwiera popupu, tylko przekierowuje bieżącą kartę na discord.com.
 *  Dlatego przed kliknięciem zakładamy nasłuch na trzy sytuacje:
 *   1) 'intercepted' – skrypt w stronie zatrzymał nawigację na discord.com i podał nam adres,
 *   2) 'popup'       – przycisk otworzył nową kartę,
 *   3) 'redirected'  – nawigacji nie dało się zatrzymać i bieżąca karta już jest na discord.com. */
async function installNavHook(page) {
  if (!page.__ckExposed) {
    await page.exposeFunction('__ckDiscordNav', u => { if (page.__ckOnUrl) page.__ckOnUrl(u); });
    page.__ckExposed = true;
  }
  await page.evaluate(() => {
    if (window.__ckNavInstalled || !window.navigation) return;
    window.__ckNavInstalled = true;
    window.navigation.addEventListener('navigate', e => {
      try {
        const host = new URL(e.destination.url).hostname;
        if (/(^|\.)discord\.com$/.test(host) && e.cancelable && !e.hashChange) {
          e.preventDefault();
          window.__ckDiscordNav(e.destination.url);
        }
      } catch {}
    });
  }).catch(() => {});
}

function watchForDiscord(page, timeout = 10000) {
  let finish;
  const result = new Promise(r => { finish = r; });
  const onPopup = popup => finish({ kind: 'popup', popup });
  const onReq = req => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() && isDiscordUrl(req.url())) finish({ kind: 'redirected', url: req.url() });
  };
  page.on('popup', onPopup);
  page.on('request', onReq);
  page.__ckOnUrl = url => finish({ kind: 'intercepted', url });
  const timer = setTimeout(() => finish(null), timeout);
  return result.finally(() => {
    clearTimeout(timer);
    page.off('popup', onPopup);
    page.off('request', onReq);
    page.__ckOnUrl = null;
  });
}

// ---------- autoryzacja aplikacji na Discordzie ----------
/** Przewija na sam dół okno autoryzacji Discorda. Dopóki nie dojedziemy na dół, przycisk jest nieaktywny. */
async function scrollModalDown(tab) {
  return tab.evaluate(() => {
    const all = [...document.querySelectorAll('[data-mana-component="modal"] [class*="scrollerBase"], [class*="scrollerBase"]')];
    const el = all.find(e => e.scrollHeight > e.clientHeight + 2);
    if (!el) return false;
    el.scrollTop = el.scrollHeight;
    return true;
  });
}

/** Aktywny przycisk „Autoryzuj” / „Authorize”. */
async function findAuthorizeButton(tab) {
  const h = await tab.evaluateHandle(() => {
    const re = /^(autoryzuj|authorize)$/i;
    return [...document.querySelectorAll('button')]
      .find(b => re.test((b.innerText || '').trim()) && !b.disabled && b.getAttribute('aria-disabled') !== 'true') || null;
  });
  return h.asElement();
}

/** Ostatni krok logowania: przewija okno na dół, klika „Autoryzuj” i czeka na powrót na creators-kingdom.com.
 *  Zwraca adres, na którym wylądowała karta (po zakończeniu przekierowań), albo null. */
async function authorizeOnDiscord(tab, log) {
  const deadline = Date.now() + 30000;
  let scrolls = 0;
  while (Date.now() < deadline) {
    if (isSiteUrl(tab.url())) break;                          // Discord od razu przekierował (aplikacja już autoryzowana)

    const btn = await findAuthorizeButton(tab).catch(() => null);
    if (btn) {
      await btn.click();
      log('kliknięto „Autoryzuj”');
      break;
    }

    if (await scrollModalDown(tab).catch(() => false)) {
      if (++scrolls === 1) log('przewijam okno autoryzacji na dół');
      if (scrolls >= 3) {                                     // awaryjnie: prawdziwe kółko myszy nad oknem
        const box = await (await tab.$('[data-mana-component="modal"]').catch(() => null))?.boundingBox().catch(() => null);
        if (box) { await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await tab.mouse.wheel({ deltaY: 3000 }); }
      }
    }
    await wait(500);
  }

  // czekamy aż Discord odeśle nas na creators-kingdom.com i skończą się przekierowania (/api/… /auth/callback… → docelowa strona)
  const landedOk = u => { try { const x = new URL(u); return isSiteUrl(u) && !x.pathname.startsWith('/api/') && !/^\/auth\/(?!login)/.test(x.pathname); } catch { return false; } };
  const until = Date.now() + 30000;
  let ok = false;
  while (Date.now() < until) {
    if (landedOk(tab.url())) { ok = true; break; }
    await wait(300);
  }
  if (!ok) { log(`nie wróciłem na creators-kingdom.com po autoryzacji – karta jest na: ${tab.url()}`); return null; }
  log(`wróciłem na creators-kingdom.com: ${tab.url()}`);
  await tab.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
  return tab.url();
}

// ---------- dołączanie do serwerów ----------
/** „ippostudio” dla https://discord.gg/ippostudio, „/invite/EDuZKM7Zuv” dla https://discord.com/invite/EDuZKM7Zuv */
function invitePart(u) {
  const m = String(u).match(/^https?:\/\/discord\.gg\/(.*)$/i);
  if (m) return m[1];
  try { const x = new URL(u); return x.pathname + x.search; } catch { return String(u); }
}

/** Przyciski na stronie zaproszenia Discorda – zależnie od serwera/języka mają różne napisy. */
const INVITE_BUTTON_TEXTS = ['Zaakceptuj zaproszenie', 'Dołącz do serwera', 'Dołącz do społeczności', 'Accept Invite', 'Join Server'];
async function findInviteButton(tab, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const h = await tab.evaluateHandle(texts => {
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const want = texts.map(norm);
      return [...document.querySelectorAll('button')]
        .find(b => !b.disabled && want.some(w => norm(b.innerText || b.textContent).includes(w))) || null;
    }, INVITE_BUTTON_TEXTS).catch(() => null);
    const el = h && h.asElement();
    if (el) return el;
    if (Date.now() >= end) return null;
    await wait(250);
  }
}

/** Wchodzi w zaproszenie w nowej karcie, klika „Zaakceptuj zaproszenie” / „Dołącz do serwera” / „Dołącz do społeczności” i zamyka kartę. */
async function acceptInvite(ctx, link, say, log, acc) {
  const part = invitePart(link);
  const tab = await ctx.newPage();
  const inServer = () => tab.waitForFunction(() => location.pathname.startsWith('/channels/'), { timeout: 15000 }).then(() => true).catch(() => false);
  /** Czeka na wejście na serwer; jeśli pojawi się hCaptcha – pauza, aż człowiek ją rozwiąże i kliknie „Wznów pracę”. */
  const waitJoined = async () => {
    for (let i = 0; i < 30; i++) {                       // ~15 s
      if (/^\/channels\//.test(new URL(tab.url()).pathname)) return true;
      if (await tab.$('iframe[src*="hcaptcha"]').catch(() => null)) return 'captcha';
      await wait(500);
    }
    return false;
  };
  try {
    await tab.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const btn = await findInviteButton(tab, 15000);
    if (!btn) { log(`${part}: brak przycisku dołączenia („Zaakceptuj zaproszenie” / „Dołącz do serwera” / „Dołącz do społeczności”) – już dołączono, link wygasł lub konto niezalogowane`); return false; }
    await btn.click();
    let ok = await waitJoined();
    if (ok === 'captcha') {
      log(`${part}: Discord wymaga captchy – rozwiąż ją w oknie przeglądarki i kliknij „Wznów pracę” w panelu`);
      await tab.bringToFront().catch(() => {});
      const resumed = await pause.waitForHuman(acc && acc.id || 'default', `captcha przy ${part}`);
      if (!resumed) { log(`${part}: przerwano oczekiwanie na captchę`); return false; }
      ok = await inServer();
      if (!ok) {                                         // czasem po captchy trzeba kliknąć jeszcze raz
        const again = await findInviteButton(tab, 3000);
        if (again) { await again.click(); ok = await inServer(); }
      }
    }
    if (ok !== true) { log(`${part}: kliknięto przycisk dołączenia, ale Discord nie wpuścił na serwer (weryfikacja?)`); return false; }
    say(`Dołączono do ${part}`);
    return true;
  } catch (e) {
    log(`${part}: błąd – ${String(e.message || e).split('\n')[0]}`);
    return false;
  } finally {
    await tab.close().catch(() => {});
  }
}

// ---------- lista serwerów na creators-kingdom.com ----------
/** Każdy wiersz listy: { id, name, joined, href }.
 *  joined = data-joined="1" (strona sama zmienia je po dołączeniu; dodatkowo klasa border-emerald-500/30),
 *  href   = link z przycisku „Join Discord” (a.join-link). */
const scanRows = page => page.$$eval('.contributor-row', rows => rows.map(r => {
  const a = r.querySelector('a.join-link');
  return {
    id: r.getAttribute('data-store-id') || '',
    name: ((r.querySelector('h3') || {}).textContent || r.getAttribute('data-name') || '').trim(),
    joined: r.getAttribute('data-joined') === '1' || r.classList.contains('border-emerald-500/30'),
    href: a ? a.href : null,
  };
})).catch(() => []);

/** Lista ma własny scroll (max-h + overflow-y-auto) – przewijamy ją, żeby mieć pewność, że wszystko się wyrenderowało. */
async function scrollList(page, rounds = 4) {
  await page.evaluate(async n => {
    const row = document.querySelector('.contributor-row');
    const box = row && row.parentElement;
    if (!box) return;
    for (let i = 0; i < n; i++) { box.scrollTop = box.scrollHeight; await new Promise(r => setTimeout(r, 150)); }
    box.scrollTop = 0;
  }, rounds).catch(() => {});
}

module.exports = {
  hosts: ['creators-kingdom.com'],
  steps: [
    {
      name: 'Logowanie przez Discord',

      // https://creators-kingdom.com/auth/login
      when: url => isLoginPath(url.pathname),

      run: async ({ page, log, acc, startUrl }) => {
        log('wykryto stronę logowania – szukam przycisku logowania przez Discord');

        // Nie znam dokładnego napisu na przycisku, więc szukam dowolnego przycisku/linku z „Discord” w tekście
        // (np. „Continue with Discord”, „Login with Discord”, „Kontynuuj z Discord”).
        const btn = await findByText(page, 'button, a', /discord/i);
        if (!btn) {
          log('nie znaleziono przycisku logowania przez Discord');
          return;
        }

        const ctx = page.browserContext();
        const loginUrl = page.url();

        // Nasłuch musi być założony PRZED kliknięciem.
        await installNavHook(page);
        const watcher = watchForDiscord(page, 10000);

        await btn.click();
        log('kliknięto przycisk logowania przez Discord');

        const found = await watcher;
        if (!found) {
          log('po kliknięciu nic się nie stało (brak popupu i przekierowania na discord.com) – kończę krok');
          return;
        }

        // Nowa karta, w której odbywa się logowanie przez Discord.
        let tab;
        if (found.kind === 'popup') {
          tab = found.popup;
          await tab.waitForNetworkIdle({ idleTime: 300, timeout: 8000 }).catch(() => {});
          log(`przycisk otworzył nową kartę: ${tab.url()}`);
        } else {
          log(found.kind === 'intercepted'
            ? 'przycisk chciał przekierować tę kartę – zatrzymałem to i otwieram Discord w nowej karcie'
            : 'przycisk przekierował tę kartę na Discord – otwieram ten adres w nowej karcie i wracam na stronę logowania');
          tab = await ctx.newPage();
          await tab.goto(found.url, { waitUntil: 'domcontentloaded', timeout: 20000 })
            .catch(e => log(`nowa karta: ${String(e.message || e).split('\n')[0]}`));
          if (found.kind === 'redirected') {
            await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          }
          await tab.bringToFront().catch(() => {});
          log(`otwarto nową kartę: ${tab.url()}`);
        }

        // Karta, która była otwarta PRZED kartą z tokenem (karta logowania Discord) – ją odświeżymy na końcu.
        const loginTab = tab;

        if (hasAutoLogin(acc)) {
          log('konto ma auto-logowanie – używam go zamiast tokenu, tokenu nie wpisuję');
        } else if (acc && acc.token_mode === 'discord') {
          log('konto ma token Discorda (karta startowa) – token jest już wpisany, pomijam');
        } else {
          // osobna karta na discord.com – tylko po to, by wpisać token do localStorage (tam Discord go czyta)
          const tok = tokenFromData(acc);
          if (!tok || !tok.token) log('brak tokenu tego konta w data.json – nie mam co wpisać');
          else await pasteTokenToDiscord(ctx, tok, log);
        }

        // po zamknięciu karty discord.com wracamy do karty logowania Discord i odświeżamy ją
        await loginTab.bringToFront().catch(() => {});
        await loginTab.reload({ waitUntil: 'load' }).catch(e => log(`błąd odświeżania: ${String(e.message || e).split('\n')[0]}`));
        log(`odświeżono wcześniej otwartą kartę (logowanie Discord): ${loginTab.url()}`);

        // ostatni krok logowania: przewiń okno autoryzacji na dół i kliknij „Autoryzuj”
        const landed = await authorizeOnDiscord(loginTab, log);
        if (!landed) return;
        console.log('Zalogowano pomyślnie!');
        log('Zalogowano pomyślnie!');

        await loginTab.close().catch(() => {});
        await page.bringToFront().catch(() => {});

        // wchodzimy na link podany przez użytkownika (z panelu); bez niego zostajemy tam, gdzie wylądowało logowanie
        const target = targetUrl(startUrl, acc) || landed;
        log(`otwieram stronę docelową: ${target}`);
        if (!sameUrl(page.url(), target)) {
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => log(`błąd otwierania: ${String(e.message || e).split('\n')[0]}`));
        }
        // dalej działa krok „Lista serwerów” (uruchamia się sam po zmianie adresu)
      },
    },

    {
      name: 'Lista serwerów',

      // dowolna strona creators-kingdom.com poza logowaniem i API (np. link podany przez użytkownika)
      when: url => !isLoginPath(url.pathname) && !url.pathname.startsWith('/api/') && !/^\/auth\//.test(url.pathname),

      run: async ({ page, log, acc, startUrl }) => {
        const say = m => { console.log(m); log(m); };
        const ctx = page.browserContext();

        // 0) jeśli strona po zalogowaniu wylądowała gdzie indziej niż link od użytkownika – wchodzimy na ten link
        const target = targetUrl(startUrl, acc);
        if (target && !sameUrl(page.url(), target)) {
          log(`strona jest na ${page.url()} zamiast na linku z panelu – otwieram: ${target}`);
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => log(`błąd otwierania: ${String(e.message || e).split('\n')[0]}`));
        }

        // 1) czekamy na listę serwerów
        const hasList = await page.waitForSelector('.contributor-row', { timeout: 15000 }).catch(() => null);
        if (!hasList) { log(`na stronie ${page.url()} nie ma listy serwerów (.contributor-row) – nic nie robię`); return; }
        await scrollList(page);

        const rows = await scanRows(page);
        const todo = rows.filter(r => !r.joined);
        log(`serwerów na liście: ${rows.length}, jeszcze nie dołączono: ${todo.length}`);

        // 2) dołączanie – każdy link „Join Discord” w nowej karcie → „Zaakceptuj zaproszenie”
        const queue = [...new Set(todo.filter(r => r.href && isInviteUrl(r.href)).map(r => r.href))];
        if (queue.length) {
          let joined = 0;
          const limit = joinLimit();
          for (let i = 0; i < queue.length; i++) {
            if (acc && pause.isRevoked(acc.id)) { log('konto utraciło sesję Discorda – przerywam dołączanie'); break; }
            if (joined >= limit) { log(`osiągnięto limit dołączeń (${limit}) – pozostałe ${queue.length - i} zaproszeń zostaje na następne uruchomienie`); break; }
            if (await acceptInvite(ctx, queue[i], say, log, acc)) joined++;
            if (i < queue.length - 1) await wait(JOIN_DELAY_MS);
          }
          log(`koniec: dołączono do ${joined} z ${queue.length} serwerów`);
        }
        if (acc && pause.isRevoked(acc.id)) return;
        await page.bringToFront().catch(() => {});

        // 3) czekamy, aż strona sama oznaczy wszystkie serwery jako dołączone (data-joined="1");
        //    jeśli nie – odświeżamy kartę i sprawdzamy jeszcze raz
        let pending = [];
        const allJoined = async timeout => waitUntil(async () => {
          await scrollList(page, 2);
          pending = (await scanRows(page)).filter(r => !r.joined).map(r => r.name || '?');
          return pending.length === 0;
        }, timeout, 1000);

        let ok = await allJoined(15000);
        if (!ok) {
          log(`strona nie oznaczyła jeszcze wszystkich serwerów jako dołączone (brakuje: ${pending.join(', ')}) – odświeżam kartę`);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => log(`błąd odświeżania: ${String(e.message || e).split('\n')[0]}`));
          await page.waitForSelector('.contributor-row', { timeout: 15000 }).catch(() => null);
          ok = await allJoined(10000);
        }
        if (!ok) {
          log(`nie wszystkie serwery mają „✓ Joined” (brakuje: ${pending.join(', ')}) – nie klikam „Verify Entry”, reszta przy następnym uruchomieniu`);
          return;
        }
        log('wszystkie serwery na liście: ✓ Joined');

        // 4) „Verify Entry”
        const verify = await page.waitForSelector('#verify-btn', { visible: true, timeout: 10000 }).catch(() => null);
        if (!verify) { log('nie znaleziono przycisku „Verify Entry” (#verify-btn)'); return; }
        await waitUntil(() => page.$eval('#verify-btn', b => !b.disabled && b.getAttribute('aria-disabled') !== 'true'), 10000, 300);
        await verify.click();
        say('Kliknięto „Verify Entry”');
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }).catch(() => {});
        log(`po weryfikacji karta jest na: ${page.url()}`);
      },
    },
  ],
};
