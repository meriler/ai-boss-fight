/* SOLO-режим (?solo=1): самостоятельный проход демки ОДНИМ человеком по ссылке, без
 * ведущего и без заранее запущенного серверного run'а. Отправил ссылку — человек прошёл
 * занятие ОТ И ДО и НИГДЕ не встал в ожидание ведущего/сервера/других участников.
 *
 * Архитектура — ПОЛНОСТЬЮ КЛИЕНТСКАЯ: reveal решается локально (кнопка «Показать
 * разгадку» на своём же экране), seat-save и acked-коммиты живут в localStorage (F5
 * работает), /sync и /host НЕ нужны, телеметрия в /tele остаётся fire-and-forget.
 * Движок — НАСТОЯЩИЙ (реальный MobileNet, как ?ws=1): ?solo=1 не тянет ?demo=1, поэтому
 * методист щупает ровно то, что дети, а не синтетические фичи.
 *
 * Приём: solo даёт drop-in замены серверным транспортам с ТЕМ ЖЕ интерфейсом, чтобы
 * оркестратор app.js не ветвился на каждом вызове. Единственные точечные соло-развилки
 * в UI — гейт без кода, кнопка «Показать разгадку» вместо ожидания N/N, и разговорные
 * приписки «(в живом занятии — с ведущим)». Живой ?ws=1 при этом не трогается. */

const STEP_ENTRY = new Set(['step_enter', 'gate_enter']);

/** Персистентное состояние solo-прохода в localStorage: то, что в живом классе держит
 * сервер (acked-коммиты, acked_step, state/suspended, save_seq, открытость reveal).
 * Журнал действий (payload) хранится отдельно в createJournal и реплеится с server_rev=0. */
export function createSoloStore({ seat, storage } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const key = 'z1_solo_' + seat;
  let data = { acked: {}, acked_step: null, state: 'boot', suspended: null,
               save_seq: 0, reveal: {}, done: false };
  const persist = () => { if (store) try { store.setItem(key, JSON.stringify(data)); } catch (e) {} };
  try {
    const d = store && JSON.parse(store.getItem(key) || 'null');
    if (d && typeof d === 'object') data = { ...data, ...d };
  } catch (e) { /* битый кэш — начинаем чисто */ }

  return {
    get data() { return data; },
    /** Локальный ack коммита: step_enter/gate_enter двигают acked_step (авторитет позиции
     * шага после F5), приватные коммиты (version/choice/forecast/captcha) кладутся в acked
     * — как их вернул бы сервер в /restore. */
    recordAck(type, step, payload) {
      if (STEP_ENTRY.has(type)) data.acked_step = step;
      else (data.acked[step] = data.acked[step] || {})[type] = { data: payload };
      persist();
    },
    setSnapshot({ state, suspended, save_seq }) {
      data.state = state;
      data.suspended = suspended || null;
      if (typeof save_seq === 'number') data.save_seq = save_seq;
      data.done = state === 'done';
      persist();
    },
    /** Разгадку открывает сам проходящий (N=1): никого не ждём. */
    openReveal(step) { (data.reveal = data.reveal || {})[step] = { open: true }; persist(); },
    revealInfo(step) { return (data.reveal && data.reveal[step]) || null; },
    /** Синтетический view в форме серверного /restore. server_rev=0 → applyRestore
     * реплеит ВЕСЬ журнал из localStorage и полностью пересобирает payload. */
    buildView({ firstStepId } = {}) {
      return {
        run_id: 'solo', server_rev: 0, payload: {}, acked: data.acked,
        acked_step: data.acked_step, current_step: data.acked_step || firstStepId,
        writer_generation: 1, epoch: 0, state: data.state, save_seq: data.save_seq,
        suspended: data.suspended, reveal: data.reveal,
      };
    },
  };
}

/** Соло-acked (замена createAcked): коммит подтверждается ЛОКАЛЬНО — нет /commit, нет
 * ретраев/other_tab/bad_code, экран не ждёт сеть. Интерфейс идентичен createAcked. */
export function createSoloAcked({ store, onStatus = () => {} } = {}) {
  return {
    commit(type, step, data) {
      onStatus('sending', { type, step });
      store.recordAck(type, step, data || {});
      onStatus('acked', { type, step });
      return Promise.resolve({ ok: true });
    },
    resendPending() { return Promise.resolve([]); },
    clearPending() {},
    pendingCount: () => 0,
  };
}

/** Соло-seatSave (замена createSeatSave): снапшот пишется в solo-store (localStorage),
 * не на /save; журнал персистится сам (createJournal). Интерфейс как createSeatSave. */
export function createSoloSeatSave({ store, getState, getSuspended = () => null,
                                     initialSaveSeq = 0 } = {}) {
  let saveSeq = initialSaveSeq;
  const snap = () => store.setSnapshot({
    state: getState(), suspended: getSuspended(), save_seq: ++saveSeq });
  return {
    markDirty() { snap(); },
    flushNow() { snap(); return Promise.resolve({ ok: true }); },
    takeover() { return Promise.resolve({ ok: true, writer_generation: 1, server_rev: 0 }); },
  };
}

/** Соло-poll (замена createPoll): инертный — нет /sync и событий ведущего, проходом
 * управляет сам проходящий. Интерфейс как createPoll. */
export function createSoloPoll() {
  return { start() {}, stop() {}, tickNow() {}, get cursor() { return 0; } };
}
