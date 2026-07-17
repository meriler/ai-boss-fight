/* Seat-save/restore (ТЗ §1.1, §4.1): дебаунс-снапшоты на сервер + restore «серверная
 * склейка + replay журнала через единый редьюсер».
 *
 * Схема restore (правило «кто побеждает», §1.1):
 *   1) GET /restore?seat=N → серверная СКЛЕЙКА: последний снапшот /save + поверх —
 *      авторитетные acked-коммиты seat (F5 в окне «коммит принят, дебаунс не доехал»
 *      не откатывает принятую версию/гейт) + run_id, writer_generation, epoch, server_rev;
 *   2) журнал: стартовый rev нового инстанса = max(server_rev, local_rev) + 1;
 *   3) payload = серверная база + replay локальных записей с rev > server_rev
 *      через ТОТ ЖЕ reduce, что применяет действия вживую.
 *
 * Single-writer: 409 other_tab → UI «Открыто в другой вкладке» + «Продолжить здесь»;
 * takeover = /save с takeover:true (сервер атомарно даёт generation+1), буфер СТАРОЙ
 * вкладки сбрасывается — честно теряем ≤ окна дебаунса (§1.1). */

import { initialPayload, replay } from './reducer.js';

const uuid = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

export function newInstanceId() { return uuid(); }

/** Шаг 1: забрать согласованное представление с сервера (склейку делает СЕРВЕР). */
export async function fetchRestore({ url = '/restore', seat, fetchFn } = {}) {
  const doFetch = fetchFn || ((...a) => fetch(...a));
  const r = await doFetch(`${url}?seat=${encodeURIComponent(seat)}`);
  if (!r.ok) throw new Error('/restore: HTTP ' + r.status);
  return r.json();
}

/** Шаги 2–3: локальная часть restore. Возвращает {payload, serverRev, view}. */
export function applyRestore(view, journal) {
  const serverRev = view.server_rev || 0;
  journal.load();
  journal.initRev(serverRev);          // rev нового инстанса = max(server, local) + 1
  const payload = view.payload && Object.keys(view.payload).length
    ? view.payload : initialPayload();
  replay(payload, journal.entries(), serverRev);
  return { payload, serverRev, view };
}

export function createSeatSave({ url = '/save', seat, runId, lessonId, instanceId,
                                 getGeneration, setGeneration, getState, getPayload,
                                 journal, debounceMs = 1000,
                                 onAccepted = () => {}, onOtherTab = () => {},
                                 onStale = () => {}, fetchFn } = {}) {
  const doFetch = fetchFn || ((...a) => fetch(...a));
  let timer = null, inflight = false, dirtyAgain = false;

  const body = (extra = {}) => ({
    seat, run_id: runId, client_instance_id: instanceId,
    writer_generation: getGeneration(), lesson_id: lessonId,
    state: getState(), payload: getPayload(),
    rev: journal.maxRev(), ts: Date.now(), ...extra,
  });

  const flush = async (extra = {}) => {
    if (inflight) { dirtyAgain = true; return null; }
    inflight = true;
    try {
      const r = await doFetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body(extra)),
      });
      const resp = await r.json().catch(() => ({}));
      if (r.ok && resp.ok) {
        if (typeof resp.writer_generation === 'number') setGeneration(resp.writer_generation);
        journal.pruneThrough(resp.accepted_rev || 0);
        onAccepted(resp);
        return resp;
      }
      if (resp.error === 'other_tab') { onOtherTab(resp); return resp; }
      if (resp.error === 'stale') { onStale(resp); return resp; }
      return resp;   // stale_run/no_run и пр. — наверх через onStale не гоняем, вернём вызвавшему
    } catch (e) {
      return null;   // офлайн: журнал в localStorage, TELE-паттерн досылки — доедет со следующим дебаунсом
    } finally {
      inflight = false;
      if (dirtyAgain) { dirtyAgain = false; api.markDirty(); }
    }
  };

  const api = {
    /** Дебаунс ~1 c на каждое действие с корзинами/ловушками (§1.1). */
    markDirty() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
    },
    /** Немедленный снапшот (вехи: переход состояния, ack коммита). */
    flushNow: () => flush(),
    /** «Продолжить здесь»: атомарный takeover на сервере (generation+1), буфер — с нуля. */
    async takeover() {
      const resp = await flush({ takeover: true });
      if (resp && resp.ok) journal.reset(resp.server_rev || journal.maxRev());
      return resp;
    },
  };
  return api;
}
