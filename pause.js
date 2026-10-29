/** Wspólny rejestr „czekam na człowieka” (np. captcha). Jeden egzemplarz dla server.js i strony/*.js
 *  (strony są przeładowywane bez restartu, ten plik – nie). */
const waiting = new Map();   // accountId -> { label, since, done }

/** Zatrzymuje wywołującego, aż ktoś kliknie „Wznów pracę” (true), bot zostanie zatrzymany lub minie limit czasu (false). */
function waitForHuman(id, label, timeoutMs = 15 * 60 * 1000) {
  return new Promise(resolve => {
    const done = v => { clearTimeout(t); waiting.delete(id); resolve(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    waiting.set(id, { label, since: Date.now(), done });
  });
}
const resume = id => { const w = waiting.get(id); if (w) w.done(true); return !!w; };
const cancelAll = () => { for (const w of [...waiting.values()]) w.done(false); };
const list = () => [...waiting.entries()].map(([id, w]) => ({ id, label: w.label, since: w.since }));

const cancel = id => { const w = waiting.get(id); if (w) w.done(false); };

/** Konta, którym Discord odebrał sesję/token (wykryte przez watchdog) – bot przestaje na nich pracować. */
const revoked = new Map();   // accountId -> { reason, at }
const markRevoked = (id, reason) => { revoked.set(id, { reason, at: Date.now() }); cancel(id); };
const isRevoked = id => revoked.has(id);
const clearRevoked = () => revoked.clear();
const revokedList = () => [...revoked.entries()].map(([id, r]) => ({ id, ...r }));

module.exports = { waitForHuman, resume, cancel, cancelAll, list, markRevoked, isRevoked, clearRevoked, revokedList };
