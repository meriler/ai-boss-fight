/* Локальный буфер — ЖУРНАЛ ДЕЙСТВИЙ фиксированного словаря (ТЗ §1.1, схема journal.schema.json).
 * rev — монотонный per-instance счётчик, единый источник rev и для записей журнала,
 * и для снапшотов /save. Стартовый rev нового инстанса = max(server_rev, local_rev) + 1.
 * Персист в localStorage (паттерн TELE): F5 не теряет несинхронизированный хвост.
 *
 * Владелец записи (аудит ядра 18.07, critical 4): каждая запись несёт inst+gen писателя;
 * load() отдаёт в replay ТОЛЬКО хвост текущего (instance, generation) — хвост старого
 * писателя с большим rev не реплеится поверх базы нового поколения (localStorage общий
 * между вкладками одного браузера). Счётчик rev при этом остаётся глобальным максимумом,
 * чтобы новый писатель не переиспользовал rev чужих записей. */

export function createJournal({ storageKey = 'z1_journal', storage, owner } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  let entries = [];
  let foreign = [];         // записи ДРУГИХ писателей в общем localStorage — не наша
                            // собственность: persist/reset их не уничтожают (закалка 18.07,
                            // high «offline-хвост при takeover стирался целиком»)
  let counter = 0;          // последний выданный rev

  const persist = () => {
    if (!store) return;
    try { store.setItem(storageKey, JSON.stringify({ counter, entries: [...foreign, ...entries] })); } catch (e) { /* quota */ }
  };

  const mine = (e) => !owner || (e.inst === owner.inst && e.gen === owner.gen);

  const api = {
    /** Поднять хвост из localStorage (вызвать до restore — его rev участвуют в max).
     * Записи СТАРОГО ФОРМАТА без владельца (журнал до rolling deploy этого поля)
     * усыновляются текущим писателем — накопленный прогресс не отбрасывается (закалка
     * 18.07, critical rolling deploy). Чужие записи (другой instance/generation)
     * в replay не попадают, но их rev двигают счётчик, а сами они сохраняются. */
    load() {
      if (!store) return api;
      try {
        const d = JSON.parse(store.getItem(storageKey) || 'null');
        if (d && Array.isArray(d.entries)) {
          counter = Math.max(d.counter || 0, ...d.entries.map(e => e.rev || 0), 0);
          let adopted = false;
          if (owner) for (const e of d.entries) {
            if (e.inst == null && e.gen == null) { e.inst = owner.inst; e.gen = owner.gen; adopted = true; }
          }
          foreign = d.entries.filter(e => !mine(e));
          entries = d.entries.filter(mine);
          if (adopted) persist();
        }
      } catch (e) { /* битый кэш — начинаем чисто */ }
      return api;
    },
    /** Сериализованное усыновление legacy-хвоста (хвост ревью 19.07, п.4): две вкладки,
     * открытые в момент rolling deploy, без сериализации усыновили бы ОДИН хвост обе —
     * каждая проштамповала бы записи СВОИМ владельцем, и поздний persist затёр бы
     * ранний (потеря replay-хвоста у одной из них). Web Lock на storageKey: победитель
     * усыновляет и персистит ПОД локом, второй внутри лока перечитывает storage и
     * видит записи уже чужими (foreign) — не трогает. Нет Lock API — как раньше
     * (load усыновляет без сериализации). */
    async migrateLegacy({ locks } = {}) {
      const lockApi = locks !== undefined ? locks
        : (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null);
      if (!lockApi) { api.load(); return api; }
      try {
        await lockApi.request(storageKey + ':adopt', () => { api.load(); });
      } catch (e) { api.load(); }   // сбой Lock API — поведение до фикса
      return api;
    },
    /** Стартовая инициализация rev по правилу §1.1 (после /restore). */
    initRev(serverRev) {
      counter = Math.max(serverRev || 0, counter);
      return api;
    },
    append(type, args) {
      counter += 1;
      const entry = { type, args: args || {}, rev: counter, ts: Date.now(),
                      ...(owner ? { inst: owner.inst, gen: owner.gen } : {}) };
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
    /** Сброс СВОЕГО буфера (перехват «Продолжить здесь» в ДРУГОЙ вкладке: её буфер
     * сбрасывается). Чужой хвост в общем localStorage физически не уничтожается —
     * старый писатель ещё может дослать его своим /save (закалка 18.07). */
    reset(startRev = 0) {
      entries = [];
      counter = startRev;
      persist();
    },
  };
  return api;
}
