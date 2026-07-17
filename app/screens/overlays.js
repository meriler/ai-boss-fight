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
  function openModal(...children) {
    modal.replaceChildren(h('div', { class: 'modalcard' }, ...children));
    modal.classList.add('on');
    document.getElementById('screen').setAttribute('inert', '');
    bar.setAttribute('inert', '');
  }
  function closeModal() {
    modal.classList.remove('on');
    modal.replaceChildren();
    document.getElementById('screen').removeAttribute('inert');
    bar.removeAttribute('inert');
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
      bigBtn('Понятно, вперёд!', () => { closeModal(); onGo && onGo(); }));
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
    box.append(
      kidText('Какая это картинка? Предскажи ответ коробки', { small: true }),
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
                verdictCard('Коробка: ' + (cl ? cl.label : v.label), v.conf),
                kidText(v.label === c.id ? 'Ты угадал!' : 'А коробка думает иначе!', { small: true }));
            }
            const slot = box.querySelector('.row');
            slot.replaceChildren(out || kidText('Прогноз записан!', { small: true }),
              bigBtn('Дальше', () => refreshOverlays(), { kind: 'secondary' }));
          }, { kind: 'secondary' }))));
    return box;
  }

  /* ---------- кнопка-реакция ---------- */
  function renderReaction() {
    const pos = ctx.machine.position();
    const key = pos.step + '.' + pos.phase;
    return bigBtn(ui.reaction_btn || 'Получилось!', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      reacted.add(key);
      ctx.tele.push('reaction', { step: pos.step });
      try { await ctx.postSeat('/react', { step: pos.step }); } catch (e) { /* офлайн — не страшно */ }
    }, { kind: 'primary', disabled: reacted.has(key) });
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
    const input = h('input', { class: 'chatinput', id: 'chat_input', maxlength: '200', placeholder: 'Напиши в чат…' });
    const send = bigBtn('Отправить', async () => {
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      const step = ctx.machine.position().step;
      try {
        await ctx.postSeat('/chat', { step, text });
        ctx.tele.push('chat_msg', { step, len: text.length });
        input.value = '';
        if (!ctx.local['chat_sent_' + step]) {
          ctx.local['chat_sent_' + step] = true;
          ctx.render();          // в talk_chat после первого сообщения появляется «Дальше»
          return;
        }
      } catch (e) { showPill(ui.offline_retry || 'Нет связи — повторю сам', 'warn'); }
      send.disabled = false;
    }, { kind: 'secondary', id: 'btn_chat_send' });
    const panel = h('div', { class: 'chatpanel' }, list, h('div', { class: 'row' }, input, send));
    setTimeout(() => { list.scrollTop = list.scrollHeight; }, 0);
    return panel;
  }

  /* ---------- сборка полосы оверлеев по декларации такта ---------- */
  function refreshOverlays() {
    const phase = ctx.machine.phase();
    const over = (phase && phase.overlays) || [];
    const parts = [];
    if (over.includes('buffer')) parts.push(renderBuffer());
    if (over.includes('reaction')) parts.push(renderReaction());
    if (over.includes('chat')) parts.push(renderChat());
    bar.replaceChildren(...parts);
    bar.classList.toggle('empty', parts.length === 0);
  }

  return { showPill, hidePill, openModal, closeModal, showOtherTab, showCatchup,
           refreshOverlays, buildChatPanel, assisted };
}
