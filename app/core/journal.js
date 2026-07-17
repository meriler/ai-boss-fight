/* Локальный буфер — ЖУРНАЛ ДЕЙСТВИЙ фиксированного словаря (ТЗ §1.1, схема journal.schema.json).
 * rev — монотонный per-instance счётчик, единый источник rev и для записей журнала,
 * и для снапшотов /save. Стартовый rev нового инстанса = max(server_rev, local_rev) + 1.
 * Персист в localStorage (паттерн TELE): F5 не теряет несинхронизированный хвост. */

export function createJournal({ storageKey = 'z1_journal', storage } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  let entries = [];
  let counter = 0;          // последний выданный rev

  const persist = () => {
    if (!store) return;
    try { store.setItem(storageKey, JSON.stringify({ counter, entries })); } catch (e) { /* quota */ }
  };

  const api = {
    /** Поднять хвост из localStorage (вызвать до restore — его rev участвуют в max). */
    load() {
      if (!store) return api;
      try {
        const d = JSON.parse(store.getItem(storageKey) || 'null');
        if (d && Array.isArray(d.entries)) { entries = d.entries; counter = d.counter || 0; }
      } catch (e) { /* битый кэш — начинаем чисто */ }
      return api;
    },
    /** Стартовая инициализация rev по правилу §1.1 (после /restore). */
    initRev(serverRev) {
      counter = Math.max(serverRev || 0, counter);
      return api;
    },
    append(type, args) {
      counter += 1;
      const entry = { type, args: args || {}, rev: counter, ts: Date.now() };
      entries.push(entry);
      persist();
      return entry;
    },
    entries: () => entries.slice(),
    maxRev: () => counter,
    /** Подрезать подтверждённое сервером (accepted_rev из /save) — хвост остаётся для replay. */
    pruneThrough(rev) {
      entries = entries.filter(e => e.rev > rev);
      persist();
    },
    /** Сброс буфера (перехват «Продолжить здесь» в ДРУГОЙ вкладке: её буфер сбрасывается). */
    reset(startRev = 0) {
      entries = [];
      counter = startRev;
      persist();
    },
  };
  return api;
}
