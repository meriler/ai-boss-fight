/* Acked-транспорт (/commit, ТЗ §4.1): ДВА класса действий ждут подтверждения сервера
 * по построению — приватный коммит (version/choice/forecast/captcha) и переход шага/гейт
 * (step_enter/gate_enter). Клиент показывает «Отправляю…», при отсутствии связи —
 * «нет связи — повторю сам» с автоповтором; экран не блокируется.
 *
 * Идемпотентность: op_id генерится при ПЕРВОЙ попытке и не меняется в ретраях (переживает
 * F5 через localStorage-очередь) — потерянный HTTP-ответ + автоповтор не плодит второй
 * коммит. client_instance_id, writer_generation и epoch ЗАМОРАЖИВАЮТСЯ в операции при
 * создании и ретраятся без изменений (аудит ядра 18.07, critical 1): операция, зависшая
 * до /host/reset_version или takeover, обязана прийти со СТАРЫМИ правами и получить
 * stale_epoch/other_tab — свежие значения в ретрае воскресили бы отменённый коммит. */

const uuid = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

export function createAcked({ url = '/commit', seat, runId, instanceId,
                              getGeneration, getEpoch,
                              onStatus = () => {}, onOtherTab = () => {},
                              storageKey = 'z1_acked_pending', storage,
                              retryMs = [1000, 2000, 4000, 5000], fetchFn } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const doFetch = fetchFn || ((...a) => fetch(...a));
  let pending = [];

  const persist = () => {
    if (!store) return;
    try { store.setItem(storageKey, JSON.stringify(pending)); } catch (e) {}
  };

  const attempt = async (op) => {
    const body = {
      seat, run_id: runId,
      // ТОЛЬКО замороженные права операции — никаких фолбэков на текущие: оп без
      // identity мигрирует в resendPending, а ретрай, подобравший свежий epoch после
      // reset/takeover, воскресил бы отменённый коммит (закалка 18.07, high 3)
      client_instance_id: op.instance,
      writer_generation: op.generation,
      epoch: op.epoch,
      op_id: op.op_id, type: op.type, step: op.step, payload: op.data,
    };
    const r = await doFetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const resp = await r.json().catch(() => ({}));
    if (r.ok && resp.ok) return { done: true, resp };
    if (resp.error === 'other_tab') { onOtherTab(resp); return { done: true, resp, failed: true }; }
    // stale_epoch / stale_run / bad_code — терминальные отказы: не ретраим, отдаём наверх
    if (r.status === 409 || r.status === 403) return { done: true, resp, failed: true };
    return { done: false, resp };   // 5xx — можно повторить
  };

  const runOp = async (op) => {
    onStatus('sending', op);
    for (let i = 0; ; i++) {
      try {
        const { done, resp, failed } = await attempt(op);
        if (done) {
          pending = pending.filter(p => p.op_id !== op.op_id);
          persist();
          onStatus(failed ? 'rejected' : 'acked', op, resp);
          if (failed) throw Object.assign(new Error(resp.error || 'commit rejected'), { resp });
          return resp;
        }
      } catch (e) {
        if (e && e.resp) throw e;   // терминальный отказ — наверх
        /* сеть упала — «нет связи — повторю сам» */
      }
      onStatus('offline_retry', op);
      await new Promise(res => setTimeout(res, retryMs[Math.min(i, retryMs.length - 1)]));
    }
  };

  const api = {
    /** Отправить acked-действие; резолвится ТОЛЬКО по ack сервера (или терминальному отказу).
     * Права (instance/generation/epoch) замораживаются здесь и не меняются в ретраях. */
    commit(type, step, data) {
      const op = { op_id: uuid(), type, step, data: data || {},
                   instance: instanceId, generation: getGeneration(), epoch: getEpoch() };
      pending.push(op);
      persist();
      return runOp(op);
    },
    /** После F5: дослать неподтверждённые операции с ИХ ЖЕ op_id и ИХ ЖЕ замороженными
     * правами (сервер дедупит; операция из отменённой эпохи получает stale_epoch).
     * Миграция rolling deploy (закалка 18.07): оп СТАРОГО формата без identity
     * замораживается к правам момента загрузки (сразу после restore) и персистится —
     * свежие права от будущего reset/takeover ему уже не достанутся. */
    resendPending() {
      if (store) {
        try {
          const d = JSON.parse(store.getItem(storageKey) || '[]');
          if (Array.isArray(d)) {
            pending = d.map(op => op.instance != null ? op :
              { ...op, instance: instanceId, generation: getGeneration(), epoch: getEpoch() });
            persist();
          }
        } catch (e) {}
      }
      return Promise.allSettled(pending.map(runOp));
    },
    /** Сброс очереди (takeover: операции старого поколения не должны пугать новую вкладку). */
    clearPending() {
      pending = [];
      persist();
    },
    pendingCount: () => pending.length,
  };
  return api;
}
