/* Поллинг /sync ~5 с (ТЗ §1.3, §4.1): никакого realtime — лаг допустим только на ЧУЖИХ
 * событиях (reveal, гейт, чат — темп ведущего). Курсор — монотонный серверный event_seq,
 * НЕ timestamp; перекрёстные ответы с курсором старее применённого отбрасываются. */

export function createPoll({ url = '/sync', seat, intervalMs = 5000,
                             onUpdate = () => {}, onOffline = () => {}, fetchFn } = {}) {
  const doFetch = fetchFn || ((...a) => fetch(...a));
  let cursor = 0, timer = null, stopped = true, missedPolls = 0;

  const tick = async () => {
    try {
      const r = await doFetch(`${url}?seat=${encodeURIComponent(seat)}&cursor=${cursor}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const resp = await r.json();
      missedPolls = 0;
      if (typeof resp.next_cursor === 'number' && resp.next_cursor < cursor)
        return;                       // перекрёстный устаревший ответ — отбрасываем
      cursor = resp.next_cursor ?? cursor;
      onUpdate(resp);
    } catch (e) {
      missedPolls += 1;               // детект офлайна с лагом — только для UI-лампочки;
      if (missedPolls >= 2) onOffline(missedPolls);   // переходы и так acked по построению
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      tick();
      timer = setInterval(tick, intervalMs);
    },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; },
    tickNow: tick,
    get cursor() { return cursor; },
  };
}
