/* Поллинг /sync ~5 с (ТЗ §1.3, §4.1): никакого realtime — лаг допустим только на ЧУЖИХ
 * событиях (reveal, гейт, чат — темп ведущего). Курсор — монотонный серверный event_seq,
 * НЕ timestamp; перекрёстные ответы с курсором старее применённого отбрасываются.
 *
 * Сериализация (аудит ядра 18.07, п.9–10): в полёте держится ОДИН запрос (второй tick
 * при живом первом — no-op), а stop()/start() двигают токен поколения — ответ запроса,
 * стартовавшего до stop (other_tab, takeover), после await отбрасывается и onUpdate
 * не зовёт: устаревшее представление не применяется поверх нового. */

export function createPoll({ url = '/sync', seat, intervalMs = 5000,
                             onUpdate = () => {}, onOffline = () => {}, fetchFn } = {}) {
  const doFetch = fetchFn || ((...a) => fetch(...a));
  let cursor = 0, timer = null, stopped = true, missedPolls = 0;
  let gen = 0, inflight = false;

  const tick = async () => {
    if (inflight || stopped) return;    // один inflight-запрос, без гонки двух ответов
    inflight = true;
    const myGen = gen;
    try {
      const r = await doFetch(`${url}?seat=${encodeURIComponent(seat)}&cursor=${cursor}`);
      if (myGen !== gen) return;        // stop()/рестарт инвалидировали запрос
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const resp = await r.json();
      if (myGen !== gen) return;
      missedPolls = 0;
      if (typeof resp.next_cursor === 'number' && resp.next_cursor < cursor)
        return;                         // перекрёстный устаревший ответ — отбрасываем
      cursor = resp.next_cursor ?? cursor;
      onUpdate(resp);
    } catch (e) {
      if (myGen !== gen) return;
      missedPolls += 1;                 // детект офлайна с лагом — только для UI-лампочки;
      if (missedPolls >= 2) onOffline(missedPolls);   // переходы и так acked по построению
    } finally {
      inflight = false;
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      gen += 1;
      tick();
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      stopped = true;
      gen += 1;                         // летящий запрос после ответа отбрасывается
      if (timer) clearInterval(timer);
      timer = null;
    },
    tickNow: tick,
    get cursor() { return cursor; },
  };
}
