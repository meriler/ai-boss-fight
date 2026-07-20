/* Сквозные оверлеи (ТЗ-демка-з1 §2 комп.10, §1.1 расписание видимости):
 *  - «Застрял» — ЕДИНСТВЕННЫЙ элемент вне лимита ≤5, виден всегда; подсказки 3 уровней
 *    (l1 наводящий вопрос → l2 показ шага → l3 восстановление до контрольной точки);
 *  - буфер «предскажи» — только в тактах с overlays:['buffer'] (ожидания/паузы);
 *  - кнопка-реакция — только в тактах с overlays:['reaction'];
 *  - чат — иконка, разворачивается в talk_chat и после reveal (overlays:['chat']);
 *  - статус-пилюля «Отправляю…»/«нет связи — повторю сам» — состояние acked-действий;
 *  - модалка «Открыто в другой вкладке» + «Продолжить здесь» (single-writer §1.1).
 * Пока модалка открыта, #screen и #overlaybar получают inert — счётный лимит ≤5
 * держится и в модалке (DOM-чек в e2e считает не-inert элементы). */

import { h, bigBtn, imgCard, kidText, verdictCard } from './dom.js';

export function createOverlays(ctx) {
  const { ui } = ctx;
  const bar = document.getElementById('overlaybar');
  const modal = document.getElementById('modal');
  const pill = document.getElementById('statuspill');
  const stuckBtn = document.getElementById('stuck');
  let reacted = new Set();          // такты, где реакция уже нажата (one-shot)
  let hintLevel = {};               // 'step.phase' -> достигнутый уровень

  /* ---------- статус-пилюля ---------- */
  let pillTimer = null;
  function showPill(text, kind = 'info', sticky = false) {
    pill.textContent = text;
    pill.className = 'pill pill-' + kind + ' pill-on';
    if (pillTimer) clearTimeout(pillTimer);
    if (!sticky) pillTimer = setTimeout(() => { pill.className = 'pill'; }, 2500);
  }
  function hidePill() { if (pillTimer) clearTimeout(pillTimer); pill.className = 'pill'; }

  /* ---------- модалки ---------- */
  let lastFocus = null;   // возврат фокуса при закрытии (закалка 18.07, клавиатура)
  function openModal(...children) {
    if (!modal.classList.contains('on')) lastFocus = document.activeElement;
    const card = h('div', { class: 'modalcard', role: 'dialog', 'aria-modal': 'true',
                            tabindex: '-1' }, ...children);
    modal.replaceChildren(card);
    modal.classList.add('on');
    document.getElementById('screen').setAttribute('inert', '');
    bar.setAttribute('inert', '');
    // фокус — внутрь диалога (первый интерактив, иначе сама карточка)
    const target = card.querySelector('button:not(:disabled), input') || card;
    setTimeout(() => { if (document.contains(target)) target.focus(); }, 0);
  }
  function closeModal() {
    modal.classList.remove('on');
    modal.replaceChildren();
    document.getElementById('screen').removeAttribute('inert');
    bar.removeAttribute('inert');
    if (lastFocus && document.contains(lastFocus) && typeof lastFocus.focus === 'function')
      lastFocus.focus();
    lastFocus = null;
  }

  function showOtherTab(onTakeover) {
    openModal(
      kidText(ui.other_tab || 'Открыто в другой вкладке'),
      bigBtn(ui.continue_here || 'Продолжить здесь', async () => {
        closeModal();
        await onTakeover();
      }));
    stuckBtn.disabled = true;
  }

  /** Карточка догоняющему (правило 2 конституции): «что уже было + что делать сейчас». */
  function showCatchup(text, onGo) {
    openModal(
      h('div', { class: 'modal-title', 'data-kid': '1' }, ui.catchup_title || 'Что уже было'),
      kidText(text),
      bigBtn('Понятно, вперёд!', () => { closeModal(); onGo && onGo(); }, { id: 'btn_catchup_go' }));
  }

  /* ---------- «Застрял» + подсказки ---------- */
  function hintFor(stepId, phaseId) {
    return ctx.normalized.hints[stepId + '.' + phaseId] || null;
  }

  function openHint() {
    const step = ctx.machine.step();
    if (!step) return;
    const phase = ctx.machine.phase();
    const key = step.id + '.' + (phase ? phase.id : '');
    const hint = phase ? hintFor(step.id, phase.id) : null;
    const level = (hintLevel[key] || 0) + 1;
    hintLevel[key] = level;
    ctx.tele.push('stuck_pressed', { step: step.id });
    ctx.tele.push('hint', { level: Math.min(level, 3), step: step.id });

    const l1 = (hint && hint.l1) || step.catchup || 'Посмотри на задание ещё раз';
    const l2 = (hint && hint.l2) || (phase && phase.text) || 'Сделай то, что написано сверху';
    const body = [];
    body.push(h('div', { class: 'modal-title', 'data-kid': '1' }, 'Подсказка'));
    body.push(kidText(level >= 2 ? l2 : l1));
    const actions = [bigBtn('Понял!', closeModal, { kind: 'secondary' })];
    if (level === 1) actions.push(bigBtn('Ещё подсказку', () => { closeModal(); openHint(); }, { kind: 'ghost' }));
    else if (hint && hint.restore_to)
      actions.push(bigBtn('Сделай за меня до точки', () => {
        ctx.tele.push('hint', { level: 3, step: step.id });
        closeModal();
        ctx.applyRestorePoint(hint.restore_to);
      }, { kind: 'danger' }));
    body.push(h('div', { class: 'modal-actions' }, ...actions));
    openModal(...body);
  }
  // boot() может перезапускаться (no_run, офлайн) — не вешать второй обработчик
  if (!stuckBtn.dataset.bound) { stuckBtn.dataset.bound = '1'; stuckBtn.addEventListener('click', openHint); }

  /** Была ли помощь уровня ≥2 (честность карточки — правило 4). */
  function assisted() {
    return ctx.tele.events.some(e => e.type === 'hint' && e.level >= 2);
  }

  /* ---------- буфер «предскажи» ---------- */
  function renderBuffer() {
    const imgs = ctx.bankIndex.byRole.get('buffer') || [];
    const done = new Set(ctx.payload.buffer.map(b => b.img));
    const next = imgs.find(i => !done.has(i.id));
    const box = h('div', { class: 'buffer' },
      h('div', { class: 'buffer-title', 'data-kid': '1' }, ui.buffer_btn || 'Предскажи!'));
    if (!next) {
      box.append(kidText('Ты всё предсказал — молодец!', { small: true }));
      return box;
    }
    // первая встреча с буфером — «зачем»-строка (аудит линзы, решение владельца 17.07):
    // куда попадёт результат, а не действие без объяснения
    box.append(
      kidText(!ctx.payload.buffer.length
        ? 'Пока ждём: предскажи, что ещё сломает коробку — потом проверишь'
        : 'Какая это картинка? Предскажи ответ коробки', { small: true }),
      imgCard(ctx.assetsBase + next.src),
      h('div', { class: 'row' },
        ...ctx.bankIndex.bank.classes.map(c =>
          bigBtn(c.label, () => {
            ctx.j('buffer_predict', { img: next.id, predict: c.id });
            ctx.tele.push('buffer_forecast', { img: next.id, predict: c.id });
            let out = null;
            if (ctx.classifier.ready && ctx.classifier.exampleCount()) {
              const v = ctx.classifier.classify(next.id);
              const cl = ctx.bankIndex.classById.get(v.label);
              ctx.tele.push('buffer_result', { img: next.id, match: v.label === c.id });
              out = h('div', {},
                verdictCard('Коробка: ' + (cl ? cl.label : v.label), v.conf, { margin: v.margin }),
                kidText(v.label === c.id ? 'Ты угадал!' : 'А коробка думает иначе!', { small: true }));
            }
            const slot = box.querySelector('.row');
            slot.replaceChildren(out || kidText('Прогноз записан!', { small: true }),
              bigBtn('Дальше', () => refreshOverlays(), { kind: 'secondary' }));
          }, { kind: 'secondary' }))));
    return box;
  }

  /* ---------- кнопка-реакция ---------- */
  let reactionNotes = {};           // такт -> счётчик группы на момент нажатия
  function renderReaction() {
    const pos = ctx.machine.position();
    const key = pos.step + '.' + pos.phase;
    const wrap = h('div', { class: 'reactwrap' });
    // подпись роли при первом показе (И3-Т п.5, фидбек #34): кнопка объясняет, куда
    // уходит сигнал; после первого нажатия за занятие подпись больше не нужна
    if (!reacted.size && !(key in reactionNotes))
      wrap.append(kidText(ctx.solo ? 'Жми, когда получится' : 'Жми, когда получится — ведущий это видит', { small: true }));
    wrap.append(bigBtn(ui.reaction_btn || 'Получилось!', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = ui.sending || 'Отправляю…';
      // «Ведущий увидел 👍» — ТОЛЬКО после ack сервера (закалка 18.07, major «ложное
      // подтверждение»): до ответа — «Отправляю…», ошибка возвращает кнопку и честно
      // говорит, что не долетело
      try {
        await ctx.postSeat('/react', { step: pos.step });
        reacted.add(key);
        // микрофидбек (И3-Т п.5, фидбек #28): анимация + «Ведущий увидел 👍» + счётчик
        // группы из reactions_count (/sync) — «уже N!» на момент нажатия
        reactionNotes[key] = ((ctx.syncData && ctx.syncData.reactions_count) || 0) + 1;
        ctx.tele.push('reaction', { step: pos.step });
        refreshOverlays();
      } catch (e) {
        if (document.contains(btn)) {
          btn.disabled = false;
          btn.textContent = ui.reaction_btn || 'Получилось!';
        }
        showPill('Не долетело — попробуй ещё раз', 'warn');
      }
    }, { kind: 'primary', id: 'btn_react', disabled: reacted.has(key) }));
    if (reacted.has(key)) {
      const n = reactionNotes[key];
      // solo: ведущего нет — самоподтверждение вместо «ведущий увидел» (в живом ?ws=1
      // сигнал реально уходит ведущему, текст прежний)
      wrap.append(h('div', { class: 'reaction-note', 'data-kid': '1' },
        ctx.solo ? 'Получилось! 👍'
                 : 'Ведущий увидел 👍' + (n > 1 ? ' · в группе уже ' + n + '!' : '')));
    }
    return wrap;
  }

  /* ---------- чат ---------- */
  let chatOpen = false;
  function renderChat({ expanded = false } = {}) {
    if (expanded) chatOpen = true;
    const wrap = h('div', { class: 'chatwrap' });
    const toggle = h('button', { class: 'chaticon', title: 'Чат', onclick: () => { chatOpen = !chatOpen; refreshOverlays(); } }, '💬');
    wrap.append(toggle);
    if (chatOpen) wrap.append(buildChatPanel(ctx));
    return wrap;
  }

  function buildChatPanel(ctx) {
    const list = h('div', { class: 'chatlist' },
      ...ctx.chatLog.map(m => h('div', { class: 'chatmsg' + (String(m.seat) === String(ctx.seat) ? ' mine' : '') },
        h('span', { class: 'chatwho' }, 'место ' + m.seat + ': '), m.text)));
    // черновик переживает ререндер (закалка 18.07, major «чат стирает черновик»):
    // входящий chat_delta пересоздаёт панель — недописанный текст, фокус и состояние
    // отправки восстанавливаются из ctx.local, а не пропадают. Признак фокуса —
    // устойчивый флаг (activeElement в момент пересборки — гонка: второй подряд
    // ререндер видит фокус уже на body и терял бы его насовсем)
    if (document.activeElement && document.activeElement.id === 'chat_input')
      ctx.local.chatFocusWanted = true;
    const wantFocus = !!ctx.local.chatFocusWanted;
    const input = h('input', { class: 'chatinput', id: 'chat_input', maxlength: '200', placeholder: 'Напиши в чат…' });
    if (ctx.local.chatDraft) input.value = ctx.local.chatDraft;
    input.addEventListener('input', () => { ctx.local.chatDraft = input.value; });
    input.addEventListener('focus', () => { ctx.local.chatFocusWanted = true; });
    input.addEventListener('blur', () => {
      // отличаем «пользователь ушёл сам» от blur'а пересборки: Chrome диспатчит blur
      // ДО отсоединения узла (contains ещё true) — решаем отложенно, когда пересборка
      // уже удалила узел из DOM. Живой узел после blur = настоящий уход, флаг снимаем
      queueMicrotask(() => {
        if (document.contains(input) && document.activeElement !== input)
          ctx.local.chatFocusWanted = false;
      });
    });
    const send = bigBtn('Отправить', async () => {
      const text = input.value.trim();
      if (!text || ctx.local.chatSending) return;
      ctx.local.chatSending = true;
      send.disabled = true;
      const step = ctx.machine.position().step;
      try {
        await ctx.postSeat('/chat', { step, text });
        ctx.tele.push('chat_msg', { step, len: text.length });
        ctx.local.chatSending = false;
        ctx.local.chatDraft = '';
        if (document.contains(input)) input.value = '';
        if (!ctx.local['chat_sent_' + step]) {
          ctx.local['chat_sent_' + step] = true;
          ctx.render();          // в talk_chat после первого сообщения появляется «Дальше»
          return;
        }
      } catch (e) {
        ctx.local.chatSending = false;
        showPill(ui.offline_retry || 'Нет связи — повторю сам', 'warn');
      }
      if (document.contains(send)) send.disabled = false;
    }, { kind: 'secondary', id: 'btn_chat_send' });
    if (ctx.local.chatSending) send.disabled = true;
    const panel = h('div', { class: 'chatpanel' }, list, h('div', { class: 'row' }, input, send));
    setTimeout(() => { list.scrollTop = list.scrollHeight; }, 0);
    // фокус — микротаском, не setTimeout: панель уже вставлена (render синхронен до
    // конца), а таймеры фоновой вкладки троттлятся — фокус «возвращался» с опозданием
    queueMicrotask(() => {
      if (wantFocus && document.contains(input) && document.activeElement !== input) {
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
      }
    });
    return panel;
  }

  /* ---------- сборка полосы оверлеев по декларации такта ---------- */
  function refreshOverlays() {
    // экран входа в шаг (гейт/step_enter) — БЕЗ оверлеев (И3-Т п.5, фидбек #28):
    // машина ещё стоит на такте ПРОШЛОГО шага, его расписание сюда не относится —
    // «Получилось!» на гейте-чекине выглядела бессмыслицей
    if (ctx.entering) {
      bar.replaceChildren();
      bar.classList.add('empty');
      return;
    }
    const phase = ctx.machine.phase();
    const over = (phase && phase.overlays) || [];
    const parts = [];
    if (over.includes('buffer')) parts.push(renderBuffer());
    // реакция не безусловна: такт с отложенным результатом (пробы/прогноз) выставляет
    // reactionOk=false, пока результата нет — «Получилось!» появляется по факту
    if (over.includes('reaction') && ctx.local.reactionOk !== false) parts.push(renderReaction());
    if (over.includes('chat')) parts.push(renderChat());
    bar.replaceChildren(...parts);
    bar.classList.toggle('empty', parts.length === 0);
  }

  return { showPill, hidePill, openModal, closeModal, showOtherTab, showCatchup,
           refreshOverlays, buildChatPanel, assisted };
}
