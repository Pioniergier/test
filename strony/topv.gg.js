/**
 * Kroki dla https://topv.gg/   (plik = nazwa domeny: strony/<domena>.js)
 * Wczytywany od nowa przy każdej wizycie – po zmianie nie trzeba restartować serwera.
 *
 * Każdy krok:
 *   name – nazwa w logach (krok wykonuje się najwyżej raz na wizytę)
 *   when – (URL) => boolean – kiedy krok ma ruszyć (sprawdzane po każdym przekierowaniu)
 *   run  – async ({ page, url, acc, log, sleep, click }) => {...}   (API Puppeteer)
 */

const fs = require('fs');
const path = require('path');
const pause = require('../pause');
const DATA_FILE = path.join(__dirname, '..', 'data.json');   // ten sam plik, który zapisuje panel

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
 *  Robi to w osobnej, krótkiej karcie; localStorage jest wspólny dla wszystkich kart tej domeny w tym kontekście,
 *  więc wcześniej otwarta karta po odświeżeniu zobaczy już zalogowane konto. */
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
    await new Promise(r => setTimeout(r, 500));
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

/** Szuka widocznego elementu pasującego do selektora, którego tekst zawiera `text`. */
async function findByText(page, selector, text, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const handles = await page.$$(selector);
    for (const h of handles) {
      const t = await page.evaluate(el => (el.innerText || el.textContent || '').trim(), h);
      if (t.includes(text)) return h;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

const isDiscordUrl = u => { try { return /(^|\.)discord\.com$/.test(new URL(u).hostname); } catch { return false; } };

/** Przycisk na topv.gg zwykle NIE otwiera popupu, tylko przekierowuje bieżącą kartę na discord.com.
 *  Dlatego przed kliknięciem zakładamy nasłuch na trzy sytuacje:
 *   1) 'intercepted' – skrypt w stronie zatrzymał nawigację na discord.com i podał nam adres (strona zostaje na topv.gg),
 *   2) 'popup'       – przycisk jednak otworzył nową kartę,
 *   3) 'redirected'  – nawigacji nie dało się zatrzymać i bieżąca karta już jest na discord.com.
 *  Zwraca { kind, url | popup } albo null po upływie czasu. */
async function installNavHook(page) {
  if (!page.__topvExposed) {
    await page.exposeFunction('__topvDiscordNav', u => { if (page.__topvOnUrl) page.__topvOnUrl(u); });
    page.__topvExposed = true;
  }
  await page.evaluate(() => {
    if (window.__topvNavInstalled || !window.navigation) return;
    window.__topvNavInstalled = true;
    window.navigation.addEventListener('navigate', e => {
      try {
        const host = new URL(e.destination.url).hostname;
        if (/(^|\.)discord\.com$/.test(host) && e.cancelable && !e.hashChange) {
          e.preventDefault();
          window.__topvDiscordNav(e.destination.url);
        }
      } catch {}
    });
  }).catch(() => {});
}

function watchForDiscord(page, timeout = 10000) {
  let finish;
  const result = new Promise(r => { finish = r; });
  const onPopup = popup => finish({ kind: 'popup', popup });
  // zdarzenie 'request' łapie adres discord.com jeszcze przed załadowaniem (także po przekierowaniach 302)
  const onReq = req => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() && isDiscordUrl(req.url())) finish({ kind: 'redirected', url: req.url() });
  };
  page.on('popup', onPopup);
  page.on('request', onReq);
  page.__topvOnUrl = url => finish({ kind: 'intercepted', url });
  const timer = setTimeout(() => finish(null), timeout);
  return result.finally(() => {
    clearTimeout(timer);
    page.off('popup', onPopup);
    page.off('request', onReq);
    page.__topvOnUrl = null;
  });
}

// ---------- autoryzacja aplikacji TopV na Discordzie ----------
const isTopvUrl = u => { try { return /(^|\.)topv\.gg$/.test(new URL(u).hostname); } catch { return false; } };
const isInviteUrl = u => { try { return /(^|\.)(discord\.gg|discord\.com|discordapp\.com)$/.test(new URL(u).hostname); } catch { return false; } };
const wait = ms => new Promise(r => setTimeout(r, ms));
/** Limit dołączeń na konto w jednym uruchomieniu – z panelu (settings.maxJoins), domyślnie 5. */
function joinLimit() {
  try { const v = Number((JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).settings || {}).maxJoins); if (Number.isInteger(v) && v >= 0) return v; } catch {}
  return 5;
}
const JOIN_DELAY_MS = 3000;   // przerwa między dołączeniami do kolejnych serwerów

/** Przewija na sam dół okno autoryzacji Discorda (div z klasą scrollerBase… w oknie modal).
 *  Dopóki nie dojedziemy na dół, przycisk jest nieaktywny („Przewijaj dalej…”). */
async function scrollModalDown(tab) {
  return tab.evaluate(() => {
    const all = [...document.querySelectorAll('[data-mana-component="modal"] [class*="scrollerBase"], [class*="scrollerBase"]')];
    const el = all.find(e => e.scrollHeight > e.clientHeight + 2);
    if (!el) return false;
    el.scrollTop = el.scrollHeight;
    return true;
  });
}

/** Aktywny przycisk „Autoryzuj” (nieaktywny ma tekst „Przewijaj dalej…” i atrybut disabled). */
async function findAuthorizeButton(tab) {
  const h = await tab.evaluateHandle(() => {
    const re = /^(autoryzuj|authorize)$/i;
    return [...document.querySelectorAll('button')]
      .find(b => re.test((b.innerText || '').trim()) && !b.disabled && b.getAttribute('aria-disabled') !== 'true') || null;
  });
  return h.asElement();
}

/** Ostatni krok logowania: przewija okno na dół, klika „Autoryzuj” i czeka na powrót na topv.gg.
 *  Zwraca adres, na którym wylądowała karta (po zakończeniu przekierowań), albo null. */
async function authorizeOnDiscord(tab, log) {
  const deadline = Date.now() + 30000;
  let scrolls = 0;
  while (Date.now() < deadline) {
    if (isTopvUrl(tab.url())) break;                          // Discord od razu przekierował (aplikacja już autoryzowana)

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

  // czekamy aż Discord odeśle nas na topv.gg i skończą się przekierowania (/api/auth/callback… → docelowa strona).
  // Adres sprawdzamy po stronie Node (tab.url()), a nie przez tab.waitForFunction – to nie zależy od kontekstu strony
  // (CSP, zniszczony kontekst po przekierowaniu, wstrzymany requestAnimationFrame w karcie w tle).
  const landedOk = u => { try { const x = new URL(u); return isTopvUrl(u) && !x.pathname.startsWith('/api/'); } catch { return false; } };
  const until = Date.now() + 30000;
  let ok = false;
  while (Date.now() < until) {
    if (landedOk(tab.url())) { ok = true; break; }
    await wait(300);
  }
  if (!ok) { log(`nie wróciłem na topv.gg po autoryzacji – karta jest na: ${tab.url()}`); return null; }
  log(`wróciłem na topv.gg: ${tab.url()}`);
  await tab.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
  return tab.url();
}

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

// ---------- zapis udziału w losowaniu ----------
const WYNIKI_DIR = path.join(__dirname, '..', 'wyniki');            // wyniki/<id-giveawaya>.json
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshoty');  // zrzuty ekranu przy pauzie „czekam na człowieka”

/** 56 z https://topv.gg/pl/giveaway/56/participate */
const giveawayId = u => { const m = String(u).match(/\/giveaway\/(\d+)/); return m ? m[1] : null; };
/** Ostrzeżenie „na żółto”: w terminalu prawdziwy żółty (ANSI), w panelu (zwykły tekst) żółta kropka 🟡. */
function warn(log, acc, msg) {
  console.log(`\x1b[33m[${(acc && acc.name) || 'konto'}] ${msg}\x1b[0m`);
  log(`🟡 ${msg}`);
}

/** Na stronie losowania zamiast „Weź udział w losowaniu” jest plakietka „Jesteś zapisany do losowania”. */
const isAlreadyJoined = page => page.evaluate(() =>
  [...document.querySelectorAll('span.gv-btn--valide')].some(e => /Jesteś zapisany do losowania/i.test(e.textContent || ''))
).catch(() => false);

const isParticipateUrl = u => { try { return /\/giveaway\/\d+\/participate/.test(new URL(u).pathname); } catch { return false; } };

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

/** Lista sklepów ma własny scroll – przewijamy ją, żeby wszystko się wyrenderowało. */
async function scrollList(page, rounds = 8) {
  await page.evaluate(async n => {
    const ul = document.querySelector('ul.gv-pass-liste');
    if (!ul) return;
    for (let i = 0; i < n; i++) { ul.scrollTop = ul.scrollHeight; await new Promise(r => setTimeout(r, 150)); }
    ul.scrollTop = 0;
  }, rounds).catch(() => {});
}

/** Każdy sklep z listy: { name, verified } – verified = jest plakietka „Zweryfikowano” (a nie przycisk „Dołącz”). */
async function scanList(page) {
  return page.$$eval('ul.gv-pass-liste li.gv-pass-magasin', lis => lis.map(li => ({
    name: ((li.querySelector('img') || {}).alt || (li.querySelector('a') || {}).textContent || '').trim(),
    verified: [...li.querySelectorAll('.gv-btn--valide')].some(e => /Zweryfikowano/i.test(e.textContent || '')),
  })));
}

/** Blok „Jesteś zapisany / Data zapisu: …” → { date } albo null. */
async function readRegistration(page) {
  return page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find(x => /^\s*Jesteś zapisan/i.test(x.textContent || ''));
    if (!p) return null;
    const box = p.parentElement || p;
    const dp = [...box.querySelectorAll('p')].find(x => /Data zapisu:/i.test(x.textContent || ''));
    const m = dp && (dp.textContent || '').match(/Data zapisu:\s*(.+)$/i);
    return { date: m ? m[1].trim().replace(/\.$/, '') : null };
  }).catch(() => null);
}

/** wyniki/<id>.json – tablica wpisów { uzytkownik, data }; ponowny zapis tego samego konta nadpisuje jego wpis. */
function saveRegistration(id, acc, date, log) {
  if (!id) { log('nie umiem ustalić ID losowania z adresu – nie zapisuję wyniku'); return null; }
  fs.mkdirSync(WYNIKI_DIR, { recursive: true });
  const file = path.join(WYNIKI_DIR, `${id}.json`);
  let list = [];
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j)) list = j; } catch {}
  const entry = { uzytkownik: (acc && acc.name) || '(bez konta)', data: date || new Date().toLocaleString('pl-PL') };
  const i = list.findIndex(x => x.uzytkownik === entry.uzytkownik);
  if (i >= 0) list[i] = entry; else list.push(entry);
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
  log(`zapisano wynik: wyniki/${id}.json (${entry.uzytkownik}, ${entry.data})`);
  return file;
}

/** Zatrzymuje pracę: robi zrzut ekranu i czeka, aż ktoś kliknie „Wznów pracę” w panelu (true) albo bot zostanie zatrzymany (false).
 *  Zrzut jest dostępny pod http://127.0.0.1:5000/screenshoty/<plik>. */
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
  log(`${reason} – zatrzymuję pracę${base ? `, zrzut ekranu: screenshoty/${base} (http://127.0.0.1:5000/screenshoty/${base})` : ''}. Sprawdź okno przeglądarki i kliknij „Wznów pracę” w panelu`);
  await page.bringToFront().catch(() => {});
  return pause.waitForHuman(acc && acc.id || 'default', base ? `${reason} · zrzut: /screenshoty/${base}` : reason);
}

// ---------- powrót na stronę startową ----------
/** Konto z auto-logowaniem (adres strony logowania) – wtedy token jest pomijany (tak samo robi bot w server.js). */
const hasAutoLogin = acc => !!(acc && acc.login_url);

const sameUrl = (a, b) => {
  try {
    const f = u => { const x = new URL(u); x.hash = ''; return x.href.replace(/\/$/, ''); };
    return f(a) === f(b);
  } catch { return false; }
};

/** Adresy, które bot ma otworzyć, gdy strona wylądowała nie tam, gdzie trzeba (np. /gracze-rp/ zamiast /giveaway/…):
 *  1) jeśli adres startowy to /login?callbackUrl=<strona> – najpierw ta strona z callbackUrl (to jest cel logowania),
 *  2) potem sam adres, od którego bot zaczął. */
function startTargets(startUrl) {
  const out = [];
  try {
    const cb = new URL(startUrl).searchParams.get('callbackUrl');
    if (cb) { const c = new URL(cb, startUrl); if (isTopvUrl(c.href)) out.push(c.href); }
  } catch {}
  if (startUrl) out.push(startUrl);
  return [...new Set(out)];
}

module.exports = {
  hosts: ['topv.gg'],
  steps: [
    {
      name: 'Logowanie przez Discord',

      // https://topv.gg/pl/login?callbackUrl=...
      when: url => /^\/(?:[a-z]{2}\/)?login\/?$/.test(url.pathname),

      run: async ({ page, log, acc }) => {
        log('wykryto stronę logowania – szukam przycisku „Kontynuuj z Discord”');

        const btn = await findByText(page, 'button.pc-bouton.pc-bouton-ch', 'Kontynuuj z Discord');
        if (!btn) {
          log('nie znaleziono przycisku „Kontynuuj z Discord”');
          return;
        }

        const ctx = page.browserContext();
        const loginUrl = page.url();

        // Nasłuch musi być założony PRZED kliknięciem.
        await installNavHook(page);
        const watcher = watchForDiscord(page, 10000);

        await btn.click();
        log('kliknięto przycisk „Kontynuuj z Discord”');

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
          // Auto-logowanie (login/hasło) ma pierwszeństwo przed tokenem – sesję Discorda ustawiło ono.
          log('konto ma auto-logowanie – używam go zamiast tokenu, tokenu nie wpisuję');
        } else if (acc && acc.token_mode === 'discord') {
          // Konto z tokenem Discorda jest już zalogowane (karta startowa) – nie trzeba nic wpisywać.
          log('konto ma token Discorda (karta startowa) – token jest już wpisany, pomijam');
        } else {
          // 1) osobna karta na discord.com – tylko po to, by wpisać token do localStorage (tam Discord go czyta)
          const tok = tokenFromData(acc);
          if (!tok || !tok.token) log('brak tokenu tego konta w data.json – nie mam co wpisać');
          else await pasteTokenToDiscord(ctx, tok, log);
        }

        // 2) po zamknięciu karty discord.com wracamy do karty, która była wcześniej otwarta, i odświeżamy ją
        await loginTab.bringToFront().catch(() => {});
        await loginTab.reload({ waitUntil: 'load' }).catch(e => log(`błąd odświeżania: ${String(e.message || e).split('\n')[0]}`));
        log(`odświeżono wcześniej otwartą kartę (logowanie Discord): ${loginTab.url()}`);

        // 3) ostatni krok logowania: przewiń okno autoryzacji na dół i kliknij „Autoryzuj”
        const landed = await authorizeOnDiscord(loginTab, log);
        if (!landed) return;
        console.log('Zalogowano pomyślnie!');
        log('Zalogowano pomyślnie!');

        // karta logowania zrobiła swoje (sesja jest wspólna dla kart) – wracamy na stronie głównej na adres docelowy,
        // dzięki temu kolejny krok (giveaway) odpali się sam
        await loginTab.close().catch(() => {});
        await page.bringToFront().catch(() => {});
        if (page.url() !== landed) await page.goto(landed, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      },
    },

    {
      name: 'Giveaway',

      // https://topv.gg/pl/giveaway/56   (strona …/participate ma własny krok poniżej)
      when: url => /^\/(?:[a-z]{2}\/)?giveaway\/\d+/.test(url.pathname) && !/\/participate/.test(url.pathname),

      run: async ({ page, log, acc }) => {
        const say = m => { console.log(m); log(m); };
        const ctx = page.browserContext();
        const id = giveawayId(page.url());

        // 0) jest już plakietka „Jesteś zapisany do losowania” (zamiast przycisku „Weź udział w losowaniu”)? → kończymy, lecimy dalej
        const state = await waitUntil(async () =>
          (await isAlreadyJoined(page)) ? 'joined' : ((await page.$('a[href="#hotes"]')) ? 'open' : null), 8000, 400);
        if (state === 'joined') {
          warn(log, acc, `konto jest już zapisane w losowaniu ${id} („Jesteś zapisany do losowania”) – pomijam, idę dalej`);
          const reg = await readRegistration(page);          // jeśli na stronie jest też data zapisu – uzupełniamy wyniki/<id>.json
          if (reg) saveRegistration(id, acc, reg.date, log);
          return;
        }

        // 1) po chwili wyskakuje okno „Nowość” – klikamy „Nie pokazuj ponownie”
        const noMore = await page.waitForSelector('button.n2-neplus', { visible: true, timeout: 10000 }).catch(() => null);
        if (noMore) {
          await noMore.click();
          await page.waitForSelector('button.n2-neplus', { hidden: true, timeout: 3000 }).catch(() => {});
          log('zamknięto okno „Nowość” (Nie pokazuj ponownie)');
        } else {
          log('okno „Nowość” się nie pojawiło – idę dalej');
        }

        // 1b) konto mogło już wcześniej wziąć udział – wtedy tylko zapisujemy wynik
        const already = await readRegistration(page);
        if (already) { warn(log, acc, `konto jest już zapisane w losowaniu ${id} – pomijam, idę dalej`); saveRegistration(id, acc, already.date, log); return; }

        // 2) „Weź udział w losowaniu”
        const join = (await findByText(page, 'a[href="#hotes"]', 'Weź udział w losowaniu', 10000))
                  || (await page.$('a.gv-btn--primaire.gv-btn--grand[href="#hotes"]'));
        if (!join) { log('nie znaleziono przycisku „Weź udział w losowaniu”'); return; }
        await join.click();
        log('kliknięto „Weź udział w losowaniu”');

        // 3) lista sklepów – zbieramy linki z przycisków „Dołącz” (sklepy już „Zweryfikowano” nie mają linku)
        await page.waitForSelector('ul.gv-pass-liste li.gv-pass-magasin', { timeout: 10000 }).catch(() => null);
        await scrollList(page);

        const items = await page.$$eval('ul.gv-pass-liste li.gv-pass-magasin', lis => lis.map(li => {
          const a = li.querySelector('a.gv-btn--primaire.gv-btn--petit');
          return { name: (li.querySelector('img') || {}).alt || '', href: a ? a.href : null };
        }));
        const queue = [...new Set(items.filter(i => i.href && isInviteUrl(i.href)).map(i => i.href))];
        log(`sklepów na liście: ${items.length}, do dołączenia (kolejka): ${queue.length}`);

        // 4) każdy link w nowej karcie → „Zaakceptuj zaproszenie”
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

        // 5) „Dołączyłem, sprawdź” + upewniamy się, że KAŻDY sklep na liście ma „Zweryfikowano” (a nie „Dołącz”)
        const check = await findByText(page, 'button.gv-btn--cyan', 'Dołączyłem', 10000);
        if (check) {
          await check.click();
          log('kliknięto „Dołączyłem, sprawdź”');
          await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
        } else {
          log('nie znaleziono przycisku „Dołączyłem, sprawdź” – sprawdzam listę bez niego');
        }

        let pending = [];
        const allVerified = await waitUntil(async () => {
          await scrollList(page, 3);
          pending = (await scanList(page)).filter(r => !r.verified).map(r => r.name || '?');
          return pending.length === 0;
        }, 20000, 1000);
        if (!allVerified) {
          log(`nie wszystkie serwery mają „Zweryfikowano” (brakuje: ${pending.join(', ')}) – kończę, reszta przy następnym uruchomieniu`);
          return;
        }
        log('wszystkie serwery na liście: Zweryfikowano');

        // 6) przycisk „Weź udział w losowaniu” (link …/participate); brak → odśwież kartę i sprawdź ponownie;
        //    nadal brak → zrzut ekranu i czekanie na człowieka
        const findLink = async () => (await page.evaluateHandle(() => document.querySelector('a[href*="/participate"]'))).asElement();
        let link = await waitUntil(findLink, 8000, 500);
        if (!link) {
          log('brak przycisku „Weź udział w losowaniu” (link /participate) – odświeżam kartę i sprawdzam ponownie');
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => log(`błąd odświeżania: ${String(e.message || e).split('\n')[0]}`));
          await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
          link = await waitUntil(findLink, 10000, 500);
        }
        if (!link) {
          const resumed = await needHuman(page, acc, log, `brak przycisku „Weź udział w losowaniu” (losowanie ${id})`);
          if (!resumed) { log('przerwano oczekiwanie – kończę'); return; }
          link = await waitUntil(findLink, 5000, 500);
          if (!link) { log('po wznowieniu nadal brak przycisku – kończę'); return; }
        }
        await link.click();
        log('kliknięto „Weź udział w losowaniu” – przechodzę na stronę uczestnictwa');
        const onPart = await waitUntil(() => isParticipateUrl(page.url()), 20000, 300);
        if (!onPart) log(`po kliknięciu nie ma strony /participate (karta jest na: ${page.url()})`);
        // dalej działa krok „Zapis na losowanie” (uruchamia się sam po zmianie adresu)
      },
    },

    {
      name: 'Zapis na losowanie',

      // https://topv.gg/pl/giveaway/56/participate
      when: url => /^\/(?:[a-z]{2}\/)?giveaway\/\d+\/participate\/?$/.test(url.pathname),

      run: async ({ page, log, acc }) => {
        const id = giveawayId(page.url());

        let reg = await readRegistration(page);               // mogło już być zapisane
        if (!reg) {
          const btn = await findByText(page, 'button.gv-btn--primaire.gv-btn--grand', 'Weź udział w losowaniu', 15000);
          if (btn) {
            await btn.click();
            log('kliknięto „Weź udział w losowaniu” (strona uczestnictwa)');
            reg = await waitUntil(() => readRegistration(page), 25000, 500);
          } else {
            log('nie znaleziono przycisku „Weź udział w losowaniu” na stronie uczestnictwa');
          }
        }
        if (!reg) {
          const resumed = await needHuman(page, acc, log, `brak potwierdzenia zapisu na losowanie ${id}`);
          if (resumed) reg = await waitUntil(() => readRegistration(page), 5000, 500);
        }
        if (!reg) { log('brak komunikatu „Jesteś zapisany” – nic nie zapisuję'); return; }

        log(`Jesteś zapisany${reg.date ? ` (data zapisu: ${reg.date})` : ''}`);
        saveRegistration(id, acc, reg.date, log);
      },
    },

    {
      name: 'Powrót na stronę startową',

      // Dowolna inna strona topv.gg niż logowanie / losowanie / uczestnictwo / API – np. /pl/gracze-rp/, na którą
      // serwis czasem przerzuca zamiast na /giveaway/…
      when: url => !url.pathname.startsWith('/api/')
        && !/^\/(?:[a-z]{2}\/)?login\/?$/.test(url.pathname)
        && !/\/giveaway\/\d+/.test(url.pathname),

      run: async ({ page, log, startUrl }) => {
        if (!startUrl || sameUrl(page.url(), startUrl)) return;     // bot jest tam, gdzie zaczął – nic do roboty
        const landedOn = page.url();
        for (const target of startTargets(startUrl)) {
          log(`strona wylądowała na ${landedOn} zamiast na docelowej – otwieram ponownie: ${target}`);
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => log(`błąd otwierania: ${String(e.message || e).split('\n')[0]}`));
          // serwis może jeszcze przerzucić dalej (JS) – dajemy mu chwilę i patrzymy, gdzie stoimy
          const ok = await waitUntil(() => giveawayId(page.url()) || sameUrl(page.url(), target), 6000, 300);
          if (ok && (giveawayId(page.url()) || sameUrl(page.url(), target))) { log(`otwarto: ${page.url()}`); return; }
          log(`nadal nie ta strona (${page.url()})`);
        }
        log('nie udało się wrócić na stronę docelową');
      },
    },
  ],
};