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
 * /save несёт epoch seat'а (аудит ядра 18.07, critical 2): задержанный снапшот,
 * собранный до /host/reset_version, сервер отклоняет по несовпадению epoch —
 * отменённая версия не возвращается дебаунс-сейвом.
 *
 * Single-writer: 409 other_tab → UI «Открыто в другой вкладке» + «Продолжить здесь»;
 * takeover — CLAIM-ONLY (аудит 18.07, critical 3): сервер атомарно даёт generation+1,
 * НЕ принимая payload перехватчика; локальный хвост сбрасывается, страница чисто
 * перезагружается от серверного снапшота. Буфер старой вкладки честно теряется
 * (≤ окна дебаунса, §1.1) — а не становится серверной базой новой generation. */

import { initialPayload, replay } from './reducer.js';

const uuid = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

export function newInstanceId() { return uuid(); }

/** Идентичность вкладки (single-writer §1.1; аудит 18.07, critical «две вкладки»).
 * sessionStorage переживает F5 ТОЙ ЖЕ вкладки, но дублирование вкладки КОПИРУЕТ
 * sessionStorage — два живых документа унаследовали бы один client_instance_id и
 * сервер принял бы их одинаковые (generation, rev) как идемпотентный повтор.
 * Разводим Web Locks: живая вкладка держит лок 'z1_tab_<id>' до закрытия; дубль,
 * не получивший лок, обязан взять СВОЙ id (и честно словить other_tab).
 * Нет Web Locks API (старый браузер, Node-тест без инжекта) — доверяем sessionStorage,
 * как раньше. locks инжектится в тестах. */
export async function claimInstanceId({ storage, key, locks,
                                        retry = { attempts: 8, delayMs: 150 } } = {}) {
  const store = storage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
  const lockApi = locks !== undefined ? locks
    : (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null);
  const tryHold = (name) => {
    if (!lockApi) return Promise.resolve(true);
    return new Promise(resolve => {
      // сбой Lock API — fail-SAFE (закалка 18.07): считаем лок НЕ взятым. Fail-open
      // давал дублям вкладки один instanceId — сервер видел их одним писателем.
      // Цена fail-safe — свежий id после F5 при сломанном API (честный other_tab)
      try {
        lockApi.request(name, { ifAvailable: true }, lock => {
          if (!lock) { resolve(false); return; }
          resolve(true);
          return new Promise(() => {});   // держим лок до закрытия вкладки
        }).catch(() => resolve(false));
      } catch (e) { resolve(false); }
    });
  };
  let saved = null;
  try { saved = ((store && JSON.parse(store.getItem(key) || 'null')) || {}).id || null; } catch (e) {}
  let id = saved;
  if (id) {
    // location.reload(): лок предыдущего документа ЭТОЙ ЖЕ вкладки Chrome отпускает
    // с задержкой (замер: ~150 мс) — даём ему умереть, прежде чем решить «занято».
    // Дубль вкладки: лок держит ЖИВАЯ вкладка и не отпустит — после ретраев честно
    // берём новый id (цена — ~1 c на boot дубля, которому всё равно жить с other_tab)
    let got = await tryHold('z1_tab_' + id);
    for (let i = 0; !got && i < retry.attempts; i++) {
      await new Promise(r => setTimeout(r, retry.delayMs));
      got = await tryHold('z1_tab_' + id);
    }
    if (!got) id = null;
  }
  if (!id) {
    id = newInstanceId();
    await tryHold('z1_tab_' + id);
  }
  try { if (store) store.setItem(key, JSON.stringify({ id })); } catch (e) {}
  return id;
}

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
                                 getGeneration, setGeneration, getEpoch = () => 0,
                                 getState, getPayload, getSuspended = () => null,
                                 journal, debounceMs = 1000,
                                 onAccepted = () => {}, onOtherTab = () => {},
                                 onStale = () => {}, fetchFn } = {}) {
  const doFetch = fetchFn || ((...a) => fetch(...a));
  let timer = null, inflight = false, dirtyAgain = false;

  const body = (extra = {}) => ({
    seat, run_id: runId, client_instance_id: instanceId,
    writer_generation: getGeneration(), epoch: getEpoch(), lesson_id: lessonId,
    state: getState(), payload: getPayload(), suspended: getSuspended(),
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
      // stale_epoch: снапшот собран до сброса ведущим — не принят и не должен быть;
      // поллинг принесёт новый epoch, handleVersionReset пересоберёт и дошлёт
      return resp;   // stale_run/no_run и пр. — вернём вызвавшему
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
    /** «Продолжить здесь»: атомарный CLAIM-ONLY takeover (generation+1 БЕЗ записи
     * нашего payload — база остаётся серверным снапшотом), буфер — с нуля. */
    async takeover() {
      const resp = await doFetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seat, run_id: runId, client_instance_id: instanceId,
                               takeover: true }),
      }).then(r => r.json().catch(() => ({}))).catch(() => null);
      if (resp && resp.ok) {
        if (typeof resp.writer_generation === 'number') setGeneration(resp.writer_generation);
        journal.reset(resp.server_rev || 0);
      }
      return resp;
    },
  };
  return api;
}
