/* ТЕЛЕМЕТРИЯ — перенос TELE-модуля из v5.html:483–536 (контракт /tele НЕ меняется:
 * тот же дамп {sid, seat, started, now, os, mobile, demo, ws, events}, JSONL на сервере,
 * rubric.py продолжает есть события; DoD п.10). Отличия от v5: модуль-фабрика без глобалов,
 * без камерных полей (cfg/gpu/nogate — специфика v5). Буфер в localStorage + досылка
 * (offline-паттерн: локально/оффлайн fetch тихо падает — данные не теряются). */

export function createTele({ url = '/tele', seat = null, demo = false, ws = false,
                             immediateTypes = [], storage } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const nav = typeof navigator !== 'undefined' ? navigator : { userAgent: '' };
  const IMM = new Set(['seat', 'gate_enter', 'version_committed', 'reveal_seen', 'measure',
                       'stuck_pressed', 'hint', 'override', 'artifact_saved', 'boot_fail',
                       'engine_fallback',   // откат движка — диагностика, дамп сразу
                       'boot_ok',           // каким путём взялись фичи (готовые/аварийный MediaPipe)
                       ...immediateTypes]);
  const t = {
    sid: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    seat, t0: Date.now(), events: [], _saveT: 0,

    push(type, data) {
      t.events.push({ t: Date.now() - t.t0, type, ...(data || {}) });
      if (IMM.has(type)) t._saveT = 0;      // веховое — мимо троттла, дамп не должен потеряться
      t._save();
      if (IMM.has(type)) t.send();
    },
    _save() {
      const now = Date.now();
      if (now - t._saveT < 1500) return;
      t._saveT = now;
      if (store) try { store.setItem('tele_' + t.sid, JSON.stringify(t.dump())); } catch (e) {}
    },
    dump() {
      const ua = nav.userAgent || '';
      return {
        sid: t.sid, seat: t.seat, started: new Date(t.t0).toISOString(), now: Date.now(),
        os: /Windows/.test(ua) ? 'win' : /Mac/.test(ua) ? 'mac' : /Android/.test(ua) ? 'android'
          : /iPhone|iPad/.test(ua) ? 'ios' : /CrOS/.test(ua) ? 'chromeos' : 'other',
        mobile: /Mobi|Android|iPhone|iPad/.test(ua),
        demo, ws, events: t.events,
      };
    },
    send(beacon) {
      if (!url) return;
      const body = JSON.stringify(t.dump());
      try {
        if (beacon && nav.sendBeacon) nav.sendBeacon(url, body);
        else fetch(url, { method: 'POST', body, keepalive: true }).catch(() => {});
      } catch (e) {}
    },
    cleanup() {   // приватность: тексты не живут на устройстве вечно — TTL 7 дней (как v5)
      if (!store) return;
      try {
        for (const k of Object.keys(store)) {
          if (!k.startsWith('tele_') || k === 'tele_' + t.sid) continue;
          const d = JSON.parse(store.getItem(k));
          if (Date.now() - new Date(d.started) > 7 * 864e5) store.removeItem(k);
        }
      } catch (e) {}
    },
    resend() {    // досылка недоставленного; чужой ключ удаляем только после 204 (сервер дедупит по sid)
      if (!url || !store) return;
      try {
        for (const k of Object.keys(store)) {
          if (!k.startsWith('tele_')) continue;
          const body = store.getItem(k);
          if (!body) continue;
          fetch(url, { method: 'POST', body, keepalive: true })
            .then(r => { if (r.ok && k !== 'tele_' + t.sid) store.removeItem(k); })
            .catch(() => {});
        }
      } catch (e) {}
    },
    /** Повесить штатные хуки страницы (pagehide-дамп + досылка при возврате сети). */
    attach() {
      if (typeof addEventListener === 'undefined') return t;
      addEventListener('pagehide', () => { t._saveT = 0; t._save(); t.send(true); });
      addEventListener('online', () => t.resend());
      return t;
    },
  };
  return t;
}
