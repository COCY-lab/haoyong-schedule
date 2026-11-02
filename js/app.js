/* ============================================================
 * 随手记任务 · app.js
 * 主逻辑：tab 切换 / 现在页 / 周表 / 随手记 / 设置 / 备份提醒
 * ============================================================ */

(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let currentPage = 'now';
  let currentFilter = 'pending';
  let editingId = null;
  let pickCtx = null;          // { day, start, onDone }
  let tplEditingId = null;     // 固定块编辑中的 id
  let weekSelectedDay = null;  // 周表选中的天
  let backupDismissed = false; // 当次是否已关闭备份提醒
  let nowTimer = null;

  // ============================================================
  // 启动
  // ============================================================
  document.addEventListener('DOMContentLoaded', () => {
    Storage.init();
    initTheme();
    bindTabs();
    bindCapture();      // 随手记输入、tabs、列表操作
    bindWeek();         // 周表
    bindNowEvents();    // 现在页事件
    bindPick();         // 排期选择抽屉
    bindTpl();          // 固定块弹窗
    bindTaskDrawer();   // 任务详情抽屉
    bindEditModal();    // 编辑弹窗
    bindSettings();     // 设置页
    initInstall();      // 安装到手机入口

    // 默认到「现在」
    switchPage('now');

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW 注册失败：', err));
    }
  });

  // ============================================================
  // 主题
  // ============================================================
  function initTheme() {
    const saved = Storage.getTheme();
    if (saved) {
      document.documentElement.dataset.theme = saved;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.dataset.theme = 'dark';
      Storage.setTheme('dark');
    }
  }

  // ============================================================
  // Tab 切换
  // ============================================================
  function bindTabs() {
    $$('.tabbar .tab').forEach(tab => {
      tab.addEventListener('click', () => switchPage(tab.dataset.page));
    });
  }

  function switchPage(page) {
    currentPage = page;
    $$('.page').forEach(p => p.classList.toggle('page--active', p.id === 'page-' + page));
    $$('.tabbar .tab').forEach(t => t.classList.toggle('tab--active', t.dataset.page === page));
    if (page === 'now')     renderNow();
    if (page === 'capture') renderCapture();
    if (page === 'week')    renderWeek();
    if (page === 'settings') applySettingsToUI();
    window.scrollTo(0, 0);
  }

  // ============================================================
  // 随手记（Capture）
  // ============================================================
  function bindCapture() {
    const form = $('#quickForm'), input = $('#quickInput');
    form.addEventListener('submit', e => { e.preventDefault(); submitTask(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault(); submitTask();
      }
    });

    $$('#quickTabs .tab').forEach(t => {
      if (!t.dataset.filter) return;
      t.addEventListener('click', () => {
        $$('#quickTabs .tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        currentFilter = t.dataset.filter;
        renderCapture();
      });
    });

    $('#btnToggleTheme').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme || 'light';
      const next = cur === 'dark' ? 'light' : 'dark';
      if (next === 'light') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = next;
      Storage.setTheme(next === 'dark' ? 'dark' : '');
    });
  }

  function submitTask() {
    const input = $('#quickInput');
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    const task = Storage.addTask(text);
    input.value = '';
    input.focus();
    renderCapture();
    toastIn('已保存');
    judgeAsync(task.id);
  }

  async function judgeAsync(id) {
    Storage.updateTask(id, { ai: { status: 'pending', tags: [], priority: 'mid', estMinutes: null, suggestion: '' } });
    if (currentPage === 'capture') renderCapture();
    try {
      const result = await AI.judge(Storage.getTasks().find(t => t.id === id).text);
      const original = { tags: result.tags, priority: result.priority };
      Storage.updateTask(id, { ai: Object.assign({}, result, { originalTags: original.tags, originalPriority: original.priority, userEdited: false }) });
    } catch (e) {
      Storage.updateTask(id, { ai: { status: 'error', tags: [], priority: 'mid', estMinutes: null, suggestion: '', error: String(e && e.message || e) } });
    }
    if (currentPage === 'capture') renderCapture();
  }

  function renderCapture() {
    const all = Storage.getTasks();
    $('#countAll').textContent = all.length;
    $('#countPending').textContent = all.filter(t => !t.done).length;
    const visible = currentFilter === 'all' ? all : all.filter(t => !t.done);

    const listEl = $('#taskList');
    const emptyEl = $('#emptyState');
    listEl.innerHTML = '';
    if (!visible.length) {
      emptyEl.classList.remove('hidden');
      emptyEl.querySelector('.empty-text').textContent =
        currentFilter === 'pending' ? '还没有任务，上方输入框直接开始吧' : '全部清空了，干净～';
    } else {
      emptyEl.classList.add('hidden');
      const groups = groupByDate(visible);
      for (const g of groups) {
        const title = document.createElement('div');
        title.className = 'group-title';
        title.textContent = g.label;
        listEl.appendChild(title);
        for (const t of g.items) listEl.appendChild(renderTaskCard(t));
      }
    }
    updateAIStatusHint();
  }

  function groupByDate(list) {
    if (!list.length) return [];
    const now = new Date();
    const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yest0 = today0 - 86400000;
    const today = [], yesterday = [], earlier = [];
    for (const t of list) {
      const ct = t.createdAt || 0;
      if (ct >= today0) today.push(t);
      else if (ct >= yest0) yesterday.push(t);
      else earlier.push(t);
    }
    const g = [];
    if (today.length) g.push({ label: '今天', items: sortTopFirst(today) });
    if (yesterday.length) g.push({ label: '昨天', items: sortTopFirst(yesterday) });
    if (earlier.length) g.push({ label: '更早', items: sortTopFirst(earlier) });
    return g;
  }
  function sortTopFirst(a) { return [...a].sort((x, y) => y.createdAt - x.createdAt); }

  // 按 AI 优先级排序未排期候选（high→mid→low，再按最近排期建议的起始时间，最后按创建时间新→旧）
  function sortUnplacedCandidates(list) {
    const priRank = { high: 3, mid: 2, low: 1 };
    return [...list].sort((a, b) => {
      const aiA = a.ai || {}, aiB = b.ai || {};
      const pa = priRank[aiA.priority] || 2;
      const pb = priRank[aiB.priority] || 2;
      if (pa !== pb) return pb - pa;                              // 高优先级在前
      // 有排期建议的优先（按建议 day+start 排序）
      const sa = aiA.scheduleSuggestion, sb = aiB.scheduleSuggestion;
      if (sa && sb) {
        if (sa.day !== sb.day) return sa.day < sb.day ? -1 : 1;
        if (sa.start !== sb.start) return sa.start < sb.start ? -1 : 1;
      } else if (sa) return -1;
      else if (sb) return 1;
      return b.createdAt - a.createdAt;                           // 创建时间新→旧
    });
  }

  // 渲染"现在页空档候选"的 HTML 片段
  function nowCandidatesHTML(candidates, slotDay, slotStart, gapMinutes) {
    if (!candidates.length) return '';
    const items = candidates.slice(0, 3).map(t => {
      const ai = t.ai || {};
      const est = ai.estMinutes;
      const fits = est && est <= gapMinutes;
      const pc = ai.priority === 'high' ? '⚠ 高' : ai.priority === 'low' ? '⌁ 低' : '';
      const btnDay = slotDay ? slotDay : Schedule.tomorrowKey();
      const btnStart = slotStart || Schedule.tomorrowFirstStart();
      const extra = fits ? '' : '（超出空档）';
      return `<div class="candidate-row" data-id="${t.id}">
        <div class="candidate-row__body">
          <div class="candidate-row__text">${esc(t.text)}</div>
          <div class="candidate-row__meta">${est ? '约 ' + est + ' 分钟' : '未估时'}${pc ? ' · ' + pc : ''}${extra}</div>
        </div>
        <button class="candidate-row__btn" type="button" data-cand-slot data-cand-slot-day="${btnDay}" data-cand-slot-start="${btnStart}">放进这一段</button>
      </div>`;
    }).join('');
    const more = candidates.length > 3
      ? `<div class="muted" style="margin-top:6px">还有 ${candidates.length - 3} 件在待办里</div>`
      : '';
    return `<div class="now-gap-candidates">
      <div class="now-gap-candidates__title">待排候选</div>
      <div class="now-gap-candidates__list">${items}</div>
      ${more}
    </div>`;
  }

  function renderTaskCard(t) {
    const el = document.createElement('article');
    el.className = 'task-card' + (t.done ? ' done' : '');
    el.dataset.id = t.id;

    const ai = t.ai || { status: 'none', tags: [], priority: 'mid' };
    const hasAI = ai.status === 'ok' || ai.status === 'rule' || ai.status === 'error';
    const pc = ai.priority === 'high' ? 'priority-high' : ai.priority === 'low' ? 'priority-low' : 'priority-mid';
    const tagHTML = (ai.tags || []).map(tag => `<span class="tag ${pc}">${esc(tag)}</span>`).join('');
    const extraTags = [];
    if (ai.estMinutes) extraTags.push(`<span class="tag">约 ${ai.estMinutes} 分钟</span>`);
    if (ai.status === 'pending') extraTags.push(`<span class="tag ai-missing">AI 判断中…</span>`);
    else if (ai.status === 'none') extraTags.push(`<span class="tag ai-missing">AI 未启用</span>`);
    else if (ai.status === 'error') extraTags.push(`<span class="tag ai-missing">AI 失败 · 本地规则</span>`);
    const priorityTag = ai.priority ? `<span class="tag ${pc}">${priorityLabel(ai.priority)}</span>` : '';

    const slotInfo = t.slot
      ? `<span class="tag">▦ ${Schedule.WEEK_LABEL[t.slot.day] || t.slot.day} ${t.slot.start}</span>`
      : '';

    // 排期建议条（视觉上优先于标签；未排期、未完成、未忽略、未接受才显示）
    const sugg = ai.scheduleSuggestion;
    const showSugg = sugg && !t.slot && !t.done && !ai.scheduleIgnored && !ai.scheduleAccepted;
    let suggHTML = '';
    if (showSugg) {
      const labelMap = { mon:'周一', tue:'周二', wed:'周三', thu:'周四', fri:'周五', sat:'周六', sun:'周日' };
      const prefixDay = (sugg.day === Schedule.todayKey()) ? '今天' : labelMap[sugg.day] || sugg.day;
      const sourceTag = sugg.source === 'ai' ? 'AI 建议' : '本地规则';
      // 建议生成超过 30 分钟：渲染时提示可能已过期（接受时仍会二次校验）
      const staleMs = sugg.generatedAt ? (Date.now() - sugg.generatedAt) : Infinity;
      const staleTag = staleMs > 30 * 60 * 1000
        ? `<span class="card-suggestion__stale">· 建议可能已过期</span>` : '';
      suggHTML = `<div class="card-suggestion" data-id="${t.id}">
        <div class="card-suggestion__head">
          <span class="card-suggestion__dot"></span>
          <span class="card-suggestion__time">排到 ${prefixDay} ${sugg.start}</span>
          <span class="card-suggestion__src">· ${sourceTag}</span>${staleTag}
        </div>
        ${sugg.reason ? `<div class="card-suggestion__reason">${esc(sugg.reason)}</div>` : ''}
        <div class="card-suggestion__acts">
          <button class="card-suggestion__accept" data-sched-accept type="button">接受这个时间</button>
          <button class="card-suggestion__ignore" data-sched-ignore type="button">忽略</button>
        </div>
      </div>`;
    }

    el.innerHTML = `
      <div class="task-main">
        <label class="check-wrap">
          <input type="checkbox" ${t.done ? 'checked' : ''} />
          <span class="check-box"></span>
        </label>
        <div class="task-body">
          <div class="task-text">${esc(t.text)}</div>
          <div class="task-meta">
            <span>🕒 ${fmtTime(t.createdAt)}</span>
            ${t.done ? `<span>✓ 已完成</span>` : ''}
          </div>
          ${suggHTML}
          ${hasAI || slotInfo ? `<div class="tag-line">${priorityTag}${tagHTML}${slotInfo}${extraTags.join('')}</div>` : ''}
          ${ai.suggestion ? `<div class="suggestion">💡 ${esc(ai.suggestion)}</div>` : ''}
          ${ai.error ? `<div class="suggestion" style="border-left-color:var(--danger);color:var(--danger)">⚠ ${esc(ai.error)}</div>` : ''}
          <div class="task-actions">
            <button class="act-slot">${t.slot ? '改排期' : '排进周表'}</button>
            ${hasAI ? `<button class="act-fix">✎ 标签</button>` : ''}
            <button class="act-edit">📝 编辑</button>
            <button class="act-del">🗑 删除</button>
          </div>
        </div>
      </div>
    `;

    el.querySelector('input[type="checkbox"]').addEventListener('change', () => {
      Storage.toggleDone(t.id); renderCapture();
    });
    el.querySelector('.act-del').addEventListener('click', () => {
      if (confirm('确定删除这条任务？')) { Storage.removeTask(t.id); renderCapture(); toastIn('已删除'); }
    });
    el.querySelector('.act-edit').addEventListener('click', () => openEdit(t));
    el.querySelector('.act-slot').addEventListener('click', () => openTaskDrawer(t.id));
    const actFix = el.querySelector('.act-fix');
    if (actFix) actFix.addEventListener('click', () => openFixTags(t));

    return el;
  }

  function priorityLabel(p) { return p === 'high' ? '⚠ 高' : p === 'low' ? '⌁ 低' : '◐ 中'; }

  // ============================================================
  // 现在页
  // ============================================================
  function bindNowEvents() {
    // 现在页的点击事件（委托）放在 document 上

    // 新一周固定块清理提示条（首次跨周进入现在/周表页时出现，只提示不自动清理）
    const banner = document.createElement('div');
    banner.id = 'week-prompt';
    banner.className = 'week-prompt hidden';
    banner.innerHTML =
      '<span class="week-prompt__text">上周固定块还在，是否需要清空？</span>' +
      '<div class="week-prompt__acts">' +
        '<button class="btn btn--sm" id="week-prompt-clear" type="button">清空全部固定块</button>' +
        '<button class="btn btn--sm btn--ghost" id="week-prompt-ignore" type="button">忽略</button>' +
      '</div>';
    document.body.appendChild(banner);
    banner.querySelector('#week-prompt-clear').addEventListener('click', () => {
      Schedule.clearAllBlocks();
      Storage.saveSchedules({ lastPromptWeek: Schedule.currentWeekKey() });
      banner.classList.add('hidden');
      renderAll();
      toastIn('已清空全部固定块');
    });
    banner.querySelector('#week-prompt-ignore').addEventListener('click', () => {
      Storage.saveSchedules({ lastPromptWeek: Schedule.currentWeekKey() });
      banner.classList.add('hidden');
    });
  }

  // 新周提示判定：有固定块 + 本周还没提示过 → 显示；否则隐藏
  function checkWeekPrompt() {
    const banner = $('#week-prompt');
    if (!banner) return;
    const sch = Storage.getSchedules();
    const cur = Schedule.currentWeekKey();
    if (sch.template.length && sch.lastPromptWeek !== cur) {
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  document.addEventListener('click', (e) => {
    // 待补任务的"顺延"按钮
    const deferBtn = e.target.closest('[data-defer]');
    if (deferBtn) {
      const id = deferBtn.closest('[data-id]').dataset.id;
      const kind = deferBtn.dataset.defer;
      if (kind === 'tomorrow') {
        Schedule.placeTask(id, Schedule.tomorrowKey(), Schedule.tomorrowFirstStart());
        toastIn('已顺延到明天 ' + Schedule.tomorrowFirstStart());
      } else {
        Schedule.placeTask(id, Schedule.todayKey(), deferBtn.dataset.start);
        toastIn('已顺延到今天 ' + deferBtn.dataset.start);
      }
      renderNow();
      return;
    }
    // 现在页"放一件进来"按钮
    const addBtn = e.target.closest('[data-add-start]');
    if (addBtn) {
      openPickDrawer({
        day: Schedule.todayKey(),
        start: addBtn.dataset.addStart,
        onDone: renderNow,
      });
      return;
    }
    // 待补全部顺延到明天
    if (e.target.id === 'defer-all') {
      const day = Schedule.todayKey();
      const tom = Schedule.tomorrowFirstStart();
      let n = 0;
      Storage.getTasks().forEach(t => {
        if (!t.done && t.slot && t.slot.day === day) {
          Schedule.placeTask(t.id, Schedule.tomorrowKey(), tom);
          n++;
        }
      });
      toastIn(`已把 ${n} 件放到明天 ${tom}`);
      renderNow();
      return;
    }
    // 现在页任务勾选
    const check = e.target.closest('.now-task [data-act="toggle"], .overdue__item [data-act="toggle"]');
    if (check) {
      const card = check.closest('[data-id]');
      if (!card) return;
      Storage.toggleDone(card.dataset.id);
      renderNow();
      return;
    }
    // 现在页任务点开详情
    const openTask = e.target.closest('.now-task [data-act="open"], .overdue__item [data-act="open"]');
    if (openTask) {
      const card = openTask.closest('[data-id]');
      if (card) openTaskDrawer(card.dataset.id);
      return;
    }
    // 备份提醒条：点导出
    if (e.target.closest('[data-act="backup-export"]')) {
      doExport();
      backupDismissed = false;
      renderNow();
      return;
    }
    if (e.target.closest('[data-act="backup-dismiss"]')) {
      backupDismissed = true;
      renderNow();
      return;
    }
    // 设置页里的"去周表管理"
    if (e.target.dataset.goto === 'week') { switchPage('week'); return; }

    // === 任务详情抽屉里的按钮（事件委托统一处理，不用每次 open 重新绑） ===
    const tdAction = e.target.closest('[data-td-action]');
    if (tdAction) {
      const drawer = tdAction.closest('#taskDrawer');
      const tid = drawer ? drawer.dataset.taskId : null;
      if (!tid) return;
      const act = tdAction.dataset.tdAction;
      if (act === 'slot') {
        closeTaskDrawer();
        openPickDrawer({ day: Schedule.todayKey(), start: '09:00', onDone: renderAll });
      } else if (act === 'reslot') {
        const task = Storage.getTasks().find(x => x.id === tid);
        closeTaskDrawer();
        openPickDrawer({ day: task && task.slot ? task.slot.day : Schedule.todayKey(), start: task && task.slot ? task.slot.start : '09:00', onDone: renderAll });
      } else if (act === 'unslot') {
        Schedule.unplaceTask(tid);
        closeTaskDrawer();
        renderAll();
        toastIn('已取消排期');
      } else if (act === 'edit') {
        const task = Storage.getTasks().find(x => x.id === tid);
        closeTaskDrawer();
        if (task) openEdit(task);
      } else if (act === 'del') {
        if (confirm('确定删除这条任务？')) {
          Storage.removeTask(tid);
          closeTaskDrawer();
          renderAll();
          toastIn('已删除');
        }
      }
      return;
    }

    // 卡片上的排期建议 —— 接受
    const acceptBtn = e.target.closest('[data-sched-accept]');
    if (acceptBtn) {
      const card = acceptBtn.closest('[data-id]');
      if (!card) return;
      const task = Storage.getTasks().find(t => t.id === card.dataset.id);
      const sugg = task && task.ai && task.ai.scheduleSuggestion;
      if (!sugg) return;

      // ---- 二次校验：接受前该 slot 必须仍可用 ----
      const WEEK = ['mon','tue','wed','thu','fri','sat','sun'];
      const nowM = Schedule.nowMinutes();
      const buf = Schedule.BUFFER || 15;
      let failReason = null;
      // ① day/start 格式合法 + 若是今天则 start 必须晚于 now+buffer（严格未来时间）
      if (!sugg.day || WEEK.indexOf(sugg.day) < 0) failReason = '建议里的日期无效';
      else if (!sugg.start || !/^([01]?\d|2[0-3]):([0-5]\d)$/.test(sugg.start)) failReason = '建议里的时间无效';
      else if (sugg.day === Schedule.todayKey() && Schedule.parse(sugg.start) < nowM + buf) failReason = '该时段已过去或太贴近现在';
      // ② 该时段未被其他任务占用（排除自己）
      else {
        const occupied = Storage.getTasks().some(x =>
          x.id !== task.id && !x.done && x.slot && x.slot.day === sugg.day && x.slot.start === sugg.start
        );
        if (occupied) failReason = '该时段已被其他任务占用';
      }
      // ③ 该时段仍在当前可用空档内
      if (!failReason) {
        const est = Math.max(sugg.minutes || 30, 30);
        const avail = Schedule.getUpcomingSlots({ fromNow: true, estMinutes: est, maxDays: 2, maxPerDay: 30, snapMinutes: 30 });
        const hit = avail.find(s => s.day === sugg.day && s.start === sugg.start && s.endMinutes >= est);
        if (!hit) failReason = '该时段已不在可用空档内';
      }

      if (failReason) {
        // 校验失败：不写入，重新计算一条可用建议
        const fresh = (window.AI && AI.suggestScheduleByRule)
          ? AI.suggestScheduleByRule(task.text, (task.ai && task.ai.estMinutes) || null, (task.ai && task.ai.priority) || 'mid')
          : null;
        if (fresh) {
          Storage.updateTask(task.id, { ai: Object.assign({}, task.ai, { scheduleSuggestion: fresh, scheduleAccepted: false, scheduleIgnored: false }) });
          renderAll();
          toastIn(failReason + '，已为你重新计算 → ' + Schedule.WEEK_LABEL[fresh.day] + ' ' + fresh.start);
        } else {
          // 实在没有可用空档（连明天都没了）
          Storage.updateTask(task.id, { ai: Object.assign({}, task.ai, { scheduleSuggestion: null, scheduleAccepted: false }) });
          renderAll();
          toastIn(failReason + '，今明两天都没有可用空档了');
        }
        return;
      }

      // 校验通过：写入
      Schedule.placeTask(task.id, sugg.day, sugg.start);
      Storage.updateTask(task.id, { ai: Object.assign({}, task.ai, { scheduleAccepted: true, scheduleIgnored: false }) });
      renderAll();
      toastIn('已接受建议，排进 ' + Schedule.WEEK_LABEL[sugg.day] + ' ' + sugg.start);
      return;
    }
    // 卡片上的排期建议 —— 忽略
    const ignoreBtn = e.target.closest('[data-sched-ignore]');
    if (ignoreBtn) {
      const card = ignoreBtn.closest('[data-id]');
      if (!card) return;
      const task = Storage.getTasks().find(t => t.id === card.dataset.id);
      if (!task || !task.ai) return;
      Storage.updateTask(task.id, { ai: Object.assign({}, task.ai, { scheduleIgnored: true }) });
      if (currentPage === 'capture') renderCapture();
      return;
    }
    // 现在页候选 —— 放进这一段（当前空档）
    const slotBtn = e.target.closest('[data-cand-slot]');
    if (slotBtn) {
      const card = slotBtn.closest('[data-id]');
      if (!card) return;
      const day = slotBtn.dataset.candSlotDay;
      const start = slotBtn.dataset.candSlotStart;
      Schedule.placeTask(card.dataset.id, day, start);
      toastIn('已排到 ' + Schedule.WEEK_LABEL[day] + ' ' + start);
      renderNow();
      return;
    }
    // 现在页候选 —— 排到明天
    const tomBtn = e.target.closest('[data-cand-tomorrow]');
    if (tomBtn) {
      const card = tomBtn.closest('[data-id]');
      if (!card) return;
      Schedule.placeTask(card.dataset.id, Schedule.tomorrowKey(), Schedule.tomorrowFirstStart());
      toastIn('已排到明天 ' + Schedule.tomorrowFirstStart());
      renderNow();
      return;
    }
  });

  function renderNow() {
    checkWeekPrompt();
    const day = Schedule.todayKey();
    const blocks = Schedule.blocksFor(day);
    const mins = Schedule.nowMinutes();
    const cur = Schedule.blockAt(blocks, mins);
    const gap = Schedule.gapAt(blocks, mins);
    const nxt = blocks.find(b => Schedule.parse(b.start) > mins);

    $('#today-line').textContent = Schedule.dateText() + ' · ' + Schedule.WEEK_LABEL[day];

    // —— 备份提醒条 ——
    let backupBar = '';
    if (!backupDismissed) {
      const last = Storage.getLastExportAt();
      const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
      if (days === null || days >= 3) {
        const msg = days === null
          ? '还没导出过备份，建议导出一份 JSON 兜底'
          : `距上次备份已 ${days} 天，建议导出一份`;
        backupBar = `<div class="now" style="padding:10px 14px;font-size:13px;color:var(--text-muted);display:flex;align-items:center;gap:8px">
          <span style="flex:1">${msg}</span>
          <button class="btn btn--sm btn--primary" data-act="backup-export" style="padding:4px 10px;font-size:12px">去导出</button>
          <button class="btn btn--sm" data-act="backup-dismiss" style="padding:4px 8px;font-size:12px">知道了</button>
        </div>`;
      }
    }

    let nowCard = '';
    // 预先算候选：未排期、未完成的任务，按优先级 + 排期建议排
    const allUnplaced = sortUnplacedCandidates(Schedule.unplacedTasks());

    if (!cur && !gap) {
      const last = blocks[blocks.length - 1];
      if (last && mins >= Schedule.parse(last.end)) {
        const undone = Storage.getTasks().filter(t => !t.done && t.slot && t.slot.day === day);
        const gapMinutes = 1440 - mins;  // 今天剩下到 24:00
        const candidates = allUnplaced.filter(t => !t.slot);  // 已经是未排期
        const candsHTML = nowCandidatesHTML(candidates, Schedule.tomorrowKey(), Schedule.tomorrowFirstStart(), gapMinutes);
        // 没有候选时，给一个"明天第一个空档"的入口提示
        const tomEntry = !candidates.length ? '' : `<div class="now-tomorrow-entry">这些候选已经没有今天空档了，建议排到明天第一个空档 ${Schedule.tomorrowFirstStart()}（按钮会自动排明天）</div>`;
        nowCard = `<section class="now now--gap">
          <div class="now__eyebrow"><span class="now__dot"></span>此刻 · ${Schedule.hhmm(mins)} · 已收工</div>
          <h2 class="now__title">今天走完了</h2>
          <p class="now__range">最后一块 ${last.start} — ${last.end} 已结束。${undone.length ? `今天还有 ${undone.length} 件没做完。` : '今天的事情都收尾了。'}</p>
          ${undone.length ? '<div class="now__actions"><button type="button" class="btn btn--primary" id="defer-all">把没做完的放到明天</button></div>' : ''}
          ${candsHTML}
          ${tomEntry}
        </section>`;
      } else {
        const first = blocks[0];
        nowCard = `<section class="now now--gap">
          <div class="now__eyebrow"><span class="now__dot"></span>此刻 · ${Schedule.hhmm(mins)} · 还没开始</div>
          <h2 class="now__title">今天还没开始</h2>
          <p class="now__range">第一块 ${first.start} ${esc(first.label)}</p>
        </section>`;
      }
    } else if (cur) {
      const remain = Schedule.parse(cur.end) - mins;
      const progress = Math.min(100, Math.max(0, ((mins - Schedule.parse(cur.start)) / (Schedule.parse(cur.end) - Schedule.parse(cur.start))) * 100));
      const list = Storage.getTasks().filter(t =>
        !t.done && t.slot && t.slot.day === day &&
        Schedule.parse(t.slot.start) >= Schedule.parse(cur.start) && Schedule.parse(t.slot.start) < Schedule.parse(cur.end)
      );
      const isFixed = cur.kind === 'fixed';
      const gapMinutesHere = Schedule.parse(cur.end) - mins;
      const candidatesHere = allUnplaced.filter(t => !t.slot);
      const candsHTMLHere = !isFixed ? nowCandidatesHTML(candidatesHere, day, cur.start, gapMinutesHere) : '';
      nowCard = `<section class="now">
        <div class="now__head">
          <div class="grow">
            <div class="now__eyebrow"><span class="now__dot"></span>此刻 · ${Schedule.hhmm(mins)}</div>
            <h2 class="now__title">${esc(cur.label)}</h2>
            <div class="now__range">${cur.start} — ${cur.end} · 还剩 ${Schedule.fmtDur(remain)}</div>
          </div>
          <div class="now__remain">
            <div class="now__remain-num">${Math.round(progress)}%</div>
            <div class="now__remain-label">已走过</div>
          </div>
        </div>
        <div class="now__bar"><i style="width:${Math.round(progress)}%"></i></div>
        ${isFixed
          ? `<div class="now__empty">这是固定安排，不用往里塞事。${nxt ? '下一块 ' + nxt.start + ' ' + esc(nxt.label) : ''}</div>`
          : list.length
            ? `<div class="now__list">${list.slice(0, 3).map(nowTaskHTML).join('')}</div>
               ${list.length > 3 ? `<div class="muted" style="margin-top:8px">这块还有 ${list.length - 3} 件，排在后面</div>` : ''}
               ${candsHTMLHere}`
            : `<div class="now__empty">这一块暂时没有安排的事。</div>
               ${candsHTMLHere}
               <div class="now__actions"><button type="button" class="btn btn--sm" data-add-start="${cur.start}">从待办里挑一件</button></div>`}
        ${nxt ? `<div class="now__next">→ 下一块 <b>${nxt.start} ${esc(nxt.label)}</b></div>` : ''}
      </section>`;
    } else {
      // 空档
      const remain = Schedule.parse(gap.end) - mins;
      const gapTasks = Storage.getTasks().filter(t =>
        !t.done && t.slot && t.slot.day === day &&
        Schedule.parse(t.slot.start) >= Schedule.parse(gap.start) && Schedule.parse(t.slot.start) < Schedule.parse(gap.end)
      );
      const gapCandidates = allUnplaced.filter(t => !t.slot);
      const gapCandsHTML = nowCandidatesHTML(gapCandidates, day, gap.start, remain);
      nowCard = `<section class="now now--gap">
        <div class="now__eyebrow"><span class="now__dot"></span>此刻 · ${Schedule.hhmm(mins)} · 空档</div>
        <h2 class="now__title">这段时间空着</h2>
        <div class="now__range">${gap.start} — ${gap.end} · 还有 ${Schedule.fmtDur(remain)}</div>
        ${gapTasks.length ? `<div class="now__list">${gapTasks.map(nowTaskHTML).join('')}</div>` : ''}
        ${gapCandsHTML}
        ${!gapCandidates.length ? `<div class="now__actions">
          <button type="button" class="btn btn--primary" data-add-start="${gap.start}">从待办里挑一件</button>
        </div>` : ''}
        ${nxt ? `<div class="now__next">→ 下一块 <b>${nxt.start} ${esc(nxt.label)}</b></div>` : ''}
      </section>`;
    }

    $('#now-slot').innerHTML = backupBar + nowCard;

    // —— 待补 ——
    const overdue = Schedule.overdueTasks(day, mins);
    let overdueHTML = '';
    if (overdue.length) {
      const next = Schedule.nextFreeBlock(day, mins);
      overdueHTML = `<div class="section">
        <div class="section__head">
          <h2 class="section__title">待补</h2>
          <span class="section__meta">${overdue.length} 件错过了原来的时间</span>
        </div>
        ${overdue.map(t => {
          const est = (t.ai && t.ai.estMinutes) ? Schedule.fmtDur(t.ai.estMinutes) : '未估时';
          return `<div class="overdue__item" data-id="${t.id}">
            <button class="task__check" data-act="toggle" aria-label="标记完成">${t.done ? '✓' : ''}</button>
            <div class="overdue__body" data-act="open">
              <div class="overdue__text">${esc(t.text)}</div>
              <div class="overdue__meta">原定 ${t.slot.start} · 约 ${est}</div>
            </div>
            <div class="overdue__acts">
              ${next ? `<button type="button" class="btn btn--sm" data-defer="slot" data-start="${next.start}">顺延到 ${next.start}</button>` : ''}
              <button type="button" class="btn btn--sm" data-defer="tomorrow">明天</button>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    }
    $('#overdue-slot').innerHTML = overdueHTML;

    // —— 今天剩下的 ——
    const rows = blocks.filter(b => Schedule.parse(b.end) > mins);
    let aheadHTML = '';
    if (rows.length) {
      const doneToday = Storage.getTasks().filter(t => t.done && t.slot && t.slot.day === day).length;
      aheadHTML = `<div class="section">
        <div class="section__head">
          <h2 class="section__title">今天剩下的</h2>
          <span class="section__meta" style="cursor:pointer" data-goto="week">看周表 →</span>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px">
          ${rows.map(b => {
            const n = Storage.getTasks().filter(t =>
              !t.done && t.slot && t.slot.day === day &&
              Schedule.parse(t.slot.start) >= Schedule.parse(b.start) && Schedule.parse(t.slot.start) < Schedule.parse(b.end)
            ).length;
            const isGap = b.kind === 'gap';
            return `<div class="ahead__row" data-goto="week">
              <span class="ahead__time">${b.start}</span>
              <span class="ahead__label ${isGap ? 'ahead__label--gap' : ''}">${esc(b.label)}${b.kind === 'fixed' ? ' <span class="muted">固定</span>' : ''}</span>
              <span class="ahead__count">${n ? `<b>${n}</b> 件` : (isGap ? '空着' : '')}</span>
            </div>`;
          }).join('')}
        </div>
        <div class="muted" style="margin-top:8px">今天已完成 ${doneToday} 件</div>
      </div>`;
    }
    $('#ahead-slot').innerHTML = aheadHTML;
  }

  function nowTaskHTML(t) {
    const est = (t.ai && t.ai.estMinutes) ? Schedule.fmtDur(t.ai.estMinutes) : '未估时';
    return `<div class="now-task" data-id="${t.id}">
      <button class="task__check" data-act="toggle" aria-label="标记完成">${t.done ? '✓' : ''}</button>
      <div class="now-task__body" data-act="open">
        <div class="now-task__text">${esc(t.text)}</div>
        <div class="now-task__meta">${tagHTML(t.ai && t.ai.tags, 2)}<span class="dot">·</span><span>约 ${est}</span>${t.ai && t.ai.priority === 'high' ? '<span class="dot">·</span><span>优先</span>' : ''}</div>
      </div>
    </div>`;
  }

  // 每分钟刷新现在页（如果在现在页）
  setInterval(() => { if (currentPage === 'now') renderNow(); }, 60000);

  // ============================================================
  // 周表
  // ============================================================
  function bindWeek() {
    $('#reuse-btn').addEventListener('click', () => {
      const n = Schedule.reuseLastWeek();
      toastIn(n > 0 ? `沿用上周：放进 ${n} 件` : '没有可沿用的排期');
      renderWeek();
    });
    $('#day-strip').addEventListener('click', e => {
      const btn = e.target.closest('[data-day]');
      if (btn) { weekSelectedDay = btn.dataset.day; renderWeek(); }
    });
    $('#timeline').addEventListener('click', e => {
      const check = e.target.closest('.mini-check');
      if (check) {
        const card = check.closest('[data-id]');
        if (card) { Storage.toggleDone(card.dataset.id); renderWeek(); }
        return;
      }
      const open = e.target.closest('.tl__task-text');
      if (open) {
        const card = open.closest('[data-id]');
        if (card) openTaskDrawer(card.dataset.id);
        return;
      }
      const add = e.target.closest('.tl__add');
      if (add) {
        openPickDrawer({ day: weekSelectedDay, start: add.dataset.start, onDone: renderWeek });
        return;
      }
    });
    $('#tpl-add').addEventListener('click', () => openTplModal());
    $('#tpl-clear-all').addEventListener('click', () => {
      if (!Storage.getTemplate().length) { toastIn('已经是空的了'); return; }
      if (!confirm('确定清空全部固定块？此操作只删固定块，不会删除任何待办任务。')) return;
      Schedule.clearAllBlocks();
      Storage.saveSchedules({ lastPromptWeek: Schedule.currentWeekKey() });
      renderWeek();
      toastIn('已清空全部固定块');
    });
    $('#tpl-list').addEventListener('click', e => {
      const item = e.target.closest('.tpl-item');
      if (item) openTplModal(item.dataset.id);
    });
  }

  function renderWeek() {
    checkWeekPrompt();
    const days = Schedule.weekDates();
    if (!weekSelectedDay) weekSelectedDay = Storage.getSchedules().weekDay || Schedule.todayKey();
    if (!days.some(d => d.key === weekSelectedDay)) weekSelectedDay = Schedule.todayKey();

    $('#day-strip').innerHTML = days.map(d => `
      <button class="day-pill ${d.key === weekSelectedDay ? 'day-pill--on' : ''} ${d.key === Schedule.todayKey() ? 'day-pill--today' : ''}" data-day="${d.key}">
        <span class="day-pill__w">周${d.short}</span>
        <span class="day-pill__d">${d.date.getMonth() + 1}/${d.date.getDate()}</span>
      </button>`).join('');

    const current = days.find(d => d.key === weekSelectedDay);
    $('#week-date').textContent = Schedule.dateText(current.date) + ' · ' + current.label;

    const blocks = Schedule.blocksFor(weekSelectedDay);
    const placed = Storage.getTasks().filter(t => t.slot && t.slot.day === weekSelectedDay);
    const gaps = Schedule.gapsFor(blocks);
    $('#week-meta').textContent = `已放进 ${placed.length} 件 · ${gaps.length} 个空档`;

    $('#timeline').innerHTML = blocks.map(b => {
      const list = Schedule.tasksIn(weekSelectedDay, b.start, b.end);
      const isGap = b.kind === 'gap';
      const cls = isGap ? 'tl tl--gap' : (b.kind === 'fixed' ? 'tl tl--fixed' : 'tl');
      const headRight = b.kind === 'fixed' ? '<span class="tl__weekday-hint">固定</span>'
        : (isGap ? `<span class="tl__weekday-hint">${Schedule.fmtDur(Schedule.parse(b.end) - Schedule.parse(b.start))}</span>`
          : '<span class="tl__weekday-hint">可安排</span>');
      let note = '';
      if (b.kind === 'fixed') note = '<div class="tl__note">固定安排 · 不参与排期</div>';
      else if (b.note) note = `<div class="tl__note">${esc(b.note)}</div>`;
      else if (isGap && !list.length) note = '<div class="tl__note">这段时间空着，可以放一件事进来</div>';
      const addBtn = b.kind === 'fixed' ? '' : `<button class="tl__add" data-start="${b.start}">+ 放一件事</button>`;

      return `<div class="${cls}">
        <div class="tl__gutter">${b.start}<br>${b.end}</div>
        <div class="tl__body">
          <div class="tl__head">
            <div class="tl__title">${esc(b.label)}</div>
            ${headRight}
          </div>
          ${note}
          ${list.length ? `<div class="tl__tasks">${list.map(t => {
            const est = (t.ai && t.ai.estMinutes) ? Schedule.fmtDur(t.ai.estMinutes) : '';
            return `<div class="tl__task" data-id="${t.id}">
              <button class="mini-check" aria-label="标记完成">${t.done ? '✓' : ''}</button>
              <span class="tl__task-text ${t.done ? 'is-done' : ''}">${esc(t.text)}</span>
              ${est ? `<span class="tl__task-est">${est}</span>` : ''}
            </div>`;
          }).join('')}</div>` : ''}
          ${addBtn}
        </div>
      </div>`;
    }).join('');

    renderTplList();
  }

  function renderTplList() {
    const tpl = Storage.getTemplate();
    $('#tpl-list').innerHTML = tpl.map(b => `
      <div class="tpl-item" data-id="${b.id}">
        <span class="tpl-item__kind">${b.kind === 'fixed' ? '固定' : '可安排'}</span>
        <span class="tpl-item__label">${esc(b.label)}</span>
        <span class="tpl-item__time">${b.start}—${b.end} · ${b.days.map(d => Schedule.WEEK_SHORT[d]).join('')}</span>
      </div>`).join('');
  }

  // ============================================================
  // 固定块模板弹窗
  // ============================================================
  function bindTpl() {
    $$('#tplModal [data-close-tpl]').forEach(b => b.addEventListener('click', closeTplModal));
    $('#tplSave').addEventListener('click', saveTpl);
    $('#tplDelete').addEventListener('click', () => {
      if (!tplEditingId) return;
      if (!confirm('确定删除这个固定块？')) return;
      Schedule.removeBlock(tplEditingId);
      closeTplModal();
      renderWeek();
      toastIn('已删除');
    });
  }

  function openTplModal(id) {
    tplEditingId = id || null;
    const modal = $('#tplModal');
    if (id) {
      const b = Storage.getTemplate().find(x => x.id === id);
      $('#tplTitle').textContent = '编辑固定块';
      $('#tplLabel').value = b.label;
      $('#tplKind').value = b.kind;
      $('#tplStart').value = b.start;
      $('#tplEnd').value = b.end;
      $('#tplNote').value = b.note || '';
      $$('#tplDays input').forEach(cb => { cb.checked = b.days.indexOf(cb.value) > -1; });
      $('#tplDelete').classList.remove('hidden');
    } else {
      $('#tplTitle').textContent = '新增固定块';
      $('#tplLabel').value = '';
      $('#tplKind').value = 'block';
      $('#tplStart').value = '09:00';
      $('#tplEnd').value = '10:00';
      $('#tplNote').value = '';
      $$('#tplDays input').forEach((cb, i) => { cb.checked = i < 5; });
      $('#tplDelete').classList.add('hidden');
    }
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }
  function closeTplModal() {
    $('#tplModal').classList.add('hidden');
    $('#tplModal').setAttribute('aria-hidden', 'true');
    tplEditingId = null;
  }
  function saveTpl() {
    const days = $$('#tplDays input').filter(cb => cb.checked).map(cb => cb.value);
    if (!days.length) { toastIn('至少选一天'); return; }
    const label = $('#tplLabel').value.trim();
    if (!label) { toastIn('名称不能为空'); return; }
    const patch = {
      label,
      kind: $('#tplKind').value,
      start: $('#tplStart').value,
      end: $('#tplEnd').value,
      days,
      note: $('#tplNote').value.trim(),
    };
    if (tplEditingId) Schedule.updateBlock(tplEditingId, patch);
    else Schedule.addBlock(patch);
    closeTplModal();
    renderWeek();
    toastIn('已保存');
  }

  // ============================================================
  // 排期选择抽屉
  // ============================================================
  function bindPick() {
    $$('#pickDrawer [data-close-pick]').forEach(b => b.addEventListener('click', closePickDrawer));
  }

  function openPickDrawer(ctx) {
    pickCtx = ctx;
    $('#pickTitle').textContent = `放进 ${Schedule.WEEK_LABEL[ctx.day]} ${ctx.start}`;
    const pool = Schedule.unplacedTasks();
    const list = $('#pickList');
    if (!pool.length) {
      list.innerHTML = '';
      $('#pickEmpty').classList.remove('hidden');
    } else {
      $('#pickEmpty').classList.add('hidden');
      list.innerHTML = pool.map(t => {
        const est = (t.ai && t.ai.estMinutes) ? Schedule.fmtDur(t.ai.estMinutes) : '';
        return `<div class="pick-item" data-id="${t.id}">
          <span class="pick-item__text">${esc(t.text)}</span>
          ${est ? `<span class="pick-item__est">${est}</span>` : ''}
        </div>`;
      }).join('');
      list.onclick = (e) => {
        const item = e.target.closest('.pick-item');
        if (!item) return;
        Schedule.placeTask(item.dataset.id, ctx.day, ctx.start);
        closePickDrawer();
        toastIn('已排进 ' + Schedule.WEEK_LABEL[ctx.day] + ' ' + ctx.start);
        if (typeof ctx.onDone === 'function') ctx.onDone();
      };
    }
    $('#pickDrawer').classList.remove('hidden');
  }
  function closePickDrawer() {
    $('#pickDrawer').classList.add('hidden');
    pickCtx = null;
  }

  // ============================================================
  // 任务详情抽屉（含排期入口）
  // ============================================================
  function bindTaskDrawer() {
    $$('#taskDrawer [data-close-task]').forEach(b => b.addEventListener('click', closeTaskDrawer));
  }

  function openTaskDrawer(id) {
    const t = Storage.getTasks().find(x => x.id === id);
    if (!t) return;
    const body = $('#taskDrawerBody');
    const est = (t.ai && t.ai.estMinutes) ? Schedule.fmtDur(t.ai.estMinutes) : '未估时';
    const tags = (t.ai && t.ai.tags) || [];
    const slot = t.slot ? `<div class="td-slot">▦ ${Schedule.WEEK_LABEL[t.slot.day]} ${t.slot.start}</div>` : '<div class="td-slot" style="color:var(--text-faint)">未排进周表</div>';

    body.innerHTML = `
      <div class="td-hero">${esc(t.text)}</div>
      <div class="td-meta">创建于 ${fmtTime(t.createdAt)} · 约 ${est}${tags.length ? ' · ' + tags.join(' / ') : ''}</div>
      ${slot}
      <div class="row-btns">
        ${t.slot
          ? `<button class="btn" data-td-action="reslot">改时间</button><button class="btn btn-danger-ghost" data-td-action="unslot">取消排期</button>`
          : `<button class="btn btn--primary" data-td-action="slot">排进周表</button>`}
        <button class="btn" data-td-action="edit">编辑内容</button>
        <button class="btn btn-danger-ghost" data-td-action="del">删除</button>
      </div>
    `;
    $('#taskDrawer').dataset.taskId = t.id;   // 把任务 id 存到抽屉根节点，事件委托时取用
    $('#taskDrawer').classList.remove('hidden');
    $('#taskDrawer').setAttribute('aria-hidden', 'false');
  }
  function closeTaskDrawer() {
    $('#taskDrawer').classList.add('hidden');
    $('#taskDrawer').setAttribute('aria-hidden', 'true');
  }

  // ============================================================
  // 编辑弹窗
  // ============================================================
  function bindEditModal() {
    $$('#editModal [data-close-edit]').forEach(b => b.addEventListener('click', closeEdit));
    $('#btnEditSave').addEventListener('click', () => {
      const text = $('#editText').value.trim();
      if (!editingId || !text) return closeEdit();
      Storage.updateTask(editingId, { text });
      closeEdit();
      renderAll();
      toastIn('已更新');
    });
  }
  function openEdit(t) {
    editingId = t.id;
    $('#editText').value = t.text;
    $('#editModal').classList.remove('hidden');
    $('#editModal').setAttribute('aria-hidden', 'false');
    setTimeout(() => { $('#editText').focus(); $('#editText').select(); }, 50);
  }
  function closeEdit() {
    editingId = null;
    $('#editModal').classList.add('hidden');
    $('#editModal').setAttribute('aria-hidden', 'true');
  }

  // ============================================================
  // 手动修正 AI 标签
  // ============================================================
  function openFixTags(t) {
    const cur = t.ai || { tags: [], priority: 'mid' };
    const result = prompt(
      '手动修正标签（逗号分隔）\n\n当前：' + (cur.tags || []).join(', ') +
      '\n优先级：' + (cur.priority || 'mid') +
      '\n\n格式: 标签1, 标签2, 优先级=mid'
    );
    if (result === null) return;
    const parts = result.split(/[,，、\n]/).map(p => p.trim()).filter(Boolean);
    const tags = []; let priority;
    for (const p of parts) {
      const m = p.match(/^优先级\s*[=:：]\s*(high|mid|low|高|中|低)$/i);
      if (m) priority = ({'高':'high','中':'mid','低':'low'}[m[1]] || m[1].toLowerCase());
      else tags.push(p);
    }
    if (!tags.length && !priority) { toastIn('格式没识别'); return; }
    const patch = Object.assign({}, cur);
    if (tags.length) patch.tags = tags.slice(0, 6);
    if (priority) patch.priority = priority;
    patch.userEdited = true;
    Storage.updateTask(t.id, { ai: patch });
    const updated = Storage.getTasks().find(x => x.id === t.id);
    Storage.recordShot(updated);
    renderAll();
    toastIn('已修正');
  }

  // ============================================================
  // 设置页
  // ============================================================
  function bindSettings() {
    $('#btnSaveAI').addEventListener('click', () => {
      Storage.saveConfig({
        baseURL: $('#cfgBaseURL').value.trim(),
        apiKey:  $('#cfgAPIKey').value.trim(),
        model:   $('#cfgModel').value.trim(),
      });
      toastIn('AI 配置已保存');
    });
    $('#btnTestAI').addEventListener('click', async () => {
      const box = $('#aiTestResult');
      box.className = 'ai-test-result'; box.textContent = '正在请求…'; box.style.display = 'block';
      Storage.saveConfig({
        baseURL: $('#cfgBaseURL').value.trim(),
        apiKey:  $('#cfgAPIKey').value.trim(),
        model:   $('#cfgModel').value.trim(),
      });
      try {
        const r = await AI.testConnection();
        if (r.status === 'ok') { box.className = 'ai-test-result ok'; box.textContent = `✓ 连通成功！标签：${(r.tags || []).join(' / ')}`; }
        else if (r.status === 'error') { box.className = 'ai-test-result err'; box.textContent = '✗ 调用失败：' + (r.error || '未知错误'); }
        else { box.className = 'ai-test-result err'; box.textContent = '✗ 未启用：请先填 Key / Base URL / 模型'; }
      } catch (e) { box.className = 'ai-test-result err'; box.textContent = '✗ 异常：' + (e && e.message || String(e)); }
    });
    $('#btnSaveBg').addEventListener('click', () => { Storage.saveUserBg($('#cfgUserBg').value); toastIn('背景已保存'); });
    $('#btnClearBg').addEventListener('click', () => {
      if (!confirm('确定清空「我的背景」？')) return;
      Storage.clearUserBg(); $('#cfgUserBg').value = ''; toastIn('背景已清空');
    });
    $('#btnClearShots').addEventListener('click', () => {
      if (!confirm('确定清空所有标签修正记录？')) return;
      Storage.clearShots(); $('#shotCount').textContent = '(0 条)'; toastIn('修正记录已清空');
    });
    $('#btnExport').addEventListener('click', doExport);
    $('#btnImport').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const payload = JSON.parse(String(reader.result));
          const merge = confirm('导入方式：\n【取消】= 覆盖\n【确定】= 合并') ? true : false;
          Storage.importAll(payload, { merge });
          applySettingsToUI();
          renderAll();
          toastIn('导入完成');
        } catch (err) { toastIn('导入失败：' + (err && err.message || String(err))); }
        finally { e.target.value = ''; }
      };
      reader.readAsText(f);
    });
  }

  function applySettingsToUI() {
    const cfg = Storage.getConfig();
    $('#cfgBaseURL').value = cfg.baseURL || '';
    $('#cfgAPIKey').value  = cfg.apiKey  || '';
    $('#cfgModel').value   = cfg.model   || '';
    $('#cfgUserBg').value  = Storage.getUserBg();
    $('#shotCount').textContent = `(${Storage.getShots().length} 条)`;
  }

  function doExport() {
    const data = Storage.exportAll();
    Storage.setLastExportAt(Date.now());
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const pad = n => n < 10 ? '0' + n : '' + n;
    a.href = url;
    a.download = `ryb-backup-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
    toastIn('已导出 JSON');
  }

  // ============================================================
  // 安装到手机（PWA install）
  // 能力检测优先：beforeinstallprompt 是否捕获 + display-mode standalone
  // UA 仅用于 iOS 的文案分支
  // ============================================================

  let installPrompt = null;          // 捕获到的 beforeinstallprompt 事件
  let installSupported = false;      // 浏览器是否给过安装事件（事件被用掉后仍记得）
  let installAccepted = false;       // 本次会话内用户已确认安装
  let installBannerDismissed = false;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    installSupported = true;
    syncInstallUI();
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installAccepted = true;
    syncInstallUI();
    toastIn('已安装到桌面');
  });

  function initInstall() {
    const btn = $('#btnInstall');
    const bannerMain = $('#install-banner-main');
    const bannerClose = $('#install-banner-close');
    if (btn) btn.addEventListener('click', startInstall);
    if (bannerMain) bannerMain.addEventListener('click', startInstall);
    if (bannerClose) bannerClose.addEventListener('click', () => {
      installBannerDismissed = true;
      syncInstallUI();
    });

    // 弹窗内所有 [data-close-install]（含动态插入的按钮）统一关闭
    const modal = $('#installModal');
    if (modal) modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-close-install]')) closeInstallModal();
    });

    // display-mode 切换（例如从桌面图标打开）时同步入口
    if (window.matchMedia) {
      const mq = window.matchMedia('(display-mode: standalone)');
      const onChange = () => syncInstallUI();
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    syncInstallUI();
  }

  function isStandaloneMode() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) { /* ignore */ }
    return !!(window.navigator && window.navigator.standalone === true);
  }

  function isIOSDevice() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/i.test(ua)) return true;
    // iPadOS 13+ 桌面版 UA：靠触点数识别
    return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
  }

  function syncInstallUI() {
    const installed = isStandaloneMode() || installAccepted;
    const card = $('#install-card');
    const banner = $('#install-banner');
    if (card) card.classList.toggle('hidden', installed);
    if (banner) banner.classList.toggle('hidden', installed || installBannerDismissed);

    const hint = $('#install-card-hint');
    if (hint && !installed) {
      if (installPrompt) hint.textContent = '浏览器已就绪，点下面的按钮即可安装。';
      else if (isIOSDevice()) hint.textContent = '在 Safari 里点底部分享 → 添加到主屏幕。';
      else hint.textContent = '装到桌面后像 App 一样全屏打开，断网也能用。数据仍然只存在本机。';
    }
  }

  async function startInstall() {
    if (isStandaloneMode() || installAccepted) { syncInstallUI(); return; }

    // 1) 浏览器已给出安装能力：走原生 prompt
    if (installPrompt) {
      const evt = installPrompt;
      installPrompt = null;
      try {
        await evt.prompt();
        const choice = await evt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          installAccepted = true;
          syncInstallUI();
        } else {
          toastIn('已取消安装');
        }
      } catch (err) {
        if (installSupported) showInstallRetry();
        else showInstallFallback();
      }
      return;
    }

    // 2) iOS：无 beforeinstallprompt，给 Safari 图文步骤
    if (isIOSDevice()) { showIOSInstallGuide(); return; }

    // 3) 浏览器给过事件但一次安装提示已被用掉：提示刷新重试
    if (installSupported) { showInstallRetry(); return; }

    // 4) 其余：既无安装事件、也非 iOS
    showInstallFallback();
  }

  function showInstallRetry() {
    $('#installModalTitle').textContent = '安装未完成';
    $('#installModalBody').innerHTML = `
      <p class="install-lead">浏览器的一次安装提示已经用掉了。可以刷新页面后重新点「安装到手机」，或从浏览器地址栏 / 菜单里的安装入口再装一次。</p>
      <div class="row-btns">
        <button class="btn-primary btn-small" type="button" data-close-install>知道了</button>
      </div>
    `;
    openInstallModal();
  }

  function showIOSInstallGuide() {
    $('#installModalTitle').textContent = '安装到手机';
    $('#installModalBody').innerHTML = `
      <p class="install-lead">必须用 <strong>Safari</strong> 打开本页才能装到桌面。微信、夸克等 App 的内置浏览器不行。</p>
      <div class="ios-guide" aria-hidden="true">
        <div class="ios-guide__step">
          <div class="ios-guide__art"><span class="ios-share-icon"></span></div>
          <div class="ios-guide__cap">① 点<strong>分享</strong></div>
        </div>
        <div class="ios-guide__arrow">→</div>
        <div class="ios-guide__step">
          <div class="ios-guide__art"><span class="ios-add-icon"></span></div>
          <div class="ios-guide__cap">② 选<strong>添加到主屏幕</strong></div>
        </div>
      </div>
      <ol class="install-steps">
        <li>确认当前是 Safari（地址栏在顶部）；如果是微信 / QQ / 夸克，请点右上角「…」选「在 Safari 中打开」。</li>
        <li>点 Safari 底部的「分享」图标 <span class="ios-inline-share" aria-hidden="true"></span>。</li>
        <li>在菜单里找到并点「添加到主屏幕」，再点右上角「添加」。</li>
        <li>回到手机桌面，用新出现的图标打开，就是全屏 App。</li>
      </ol>
      <div class="row-btns">
        <button class="btn-primary btn-small" type="button" data-close-install>知道了</button>
      </div>
    `;
    openInstallModal();
  }

  function showInstallFallback() {
    const url = location.href.split('#')[0];
    $('#installModalTitle').textContent = '无法直接安装';
    $('#installModalBody').innerHTML = `
      <p class="install-lead">当前浏览器不支持安装，请用 <strong>Chrome / Edge / Safari</strong> 打开。</p>
      <p class="install-note">微信、QQ、夸克等 App 的内置浏览器通常会拦截安装。复制下面的网址，到系统浏览器粘贴打开即可。</p>
      <div class="install-url">
        <input type="text" id="installUrlText" readonly value="${esc(url)}" aria-label="可复制的网址" />
        <button type="button" id="btnCopyInstallUrl" class="btn-primary btn-small">复制网址</button>
      </div>
      <div class="row-btns">
        <button class="btn-ghost btn-small" type="button" data-close-install>关闭</button>
      </div>
    `;
    const input = $('#installUrlText');
    input.addEventListener('click', () => input.select());
    $('#btnCopyInstallUrl').addEventListener('click', () => copyText(url, $('#btnCopyInstallUrl')));
    openInstallModal();
  }

  function copyText(text, btn) {
    const done = () => {
      if (btn) {
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制网址'; }, 1600);
      }
      toastIn('网址已复制');
    };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (ok) done(); else toastIn('请长按网址手动复制');
      } catch (e) { toastIn('请长按网址手动复制'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function openInstallModal() {
    const m = $('#installModal');
    m.classList.remove('hidden');
    m.setAttribute('aria-hidden', 'false');
  }

  function closeInstallModal() {
    const m = $('#installModal');
    m.classList.add('hidden');
    m.setAttribute('aria-hidden', 'true');
  }

  // ============================================================
  // 工具
  // ============================================================
  function renderAll() {
    if (currentPage === 'now') renderNow();
    else if (currentPage === 'capture') renderCapture();
    else if (currentPage === 'week') renderWeek();
  }

  function updateAIStatusHint() {
    const key = (Storage.getConfig().apiKey || '').trim();
    $('#aiStatus').textContent = key ? 'AI 已启用 · 保存后自动打标签' : 'AI 未启用（无 Key）· 可在设置里开启';
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => n < 10 ? '0' + n : '' + n;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function tagHTML(tags, max) { return (tags || []).slice(0, max || 4).map(t => `<span class="tag">${esc(t)}</span>`).join(''); }

  let toastTimer = null;
  function toastIn(msg) {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 1800);
  }
})();
