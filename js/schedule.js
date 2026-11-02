/* ============================================================
 * 随手记任务 · schedule.js
 * 周表 / 现在页 模块：时间模型 + 固定块 + 排期 + 沿用上周
 * 真实时钟，无演示控件
 * ============================================================ */

(function (global) {
  'use strict';

  const WEEK = ['mon','tue','wed','thu','fri','sat','sun'];
  const WEEK_LABEL = { mon:'周一', tue:'周二', wed:'周三', thu:'周四', fri:'周五', sat:'周六', sun:'周日' };
  const WEEK_SHORT = { mon:'一', tue:'二', wed:'三', thu:'四', fri:'五', sat:'六', sun:'日' };

  // ---------- 时间工具 ----------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function parse(t) {
    const p = String(t || '0:00').split(':');
    return Number(p[0]) * 60 + Number(p[1] || 0);
  }
  function hhmm(mins) {
    const m = ((mins % 1440) + 1440) % 1440;
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }
  function fmtDur(min) {
    const m = Number(min) || 0;
    if (m < 60) return m + ' 分钟';
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? h + ' 小时 ' + r + ' 分' : h + ' 小时';
  }
  function nowMinutes() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  // ---------- 日期 ----------
  function dayKeyOf(date) {
    const d = date || new Date();
    return WEEK[(d.getDay() + 6) % 7];
  }
  function todayKey() { return dayKeyOf(new Date()); }
  function tomorrowKey() {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return dayKeyOf(d);
  }
  function weekDates() {
    const base = new Date(); base.setHours(0,0,0,0);
    const idx = (new Date().getDay() + 6) % 7;
    const monday = new Date(base);
    monday.setDate(base.getDate() - idx);
    return WEEK.map((k, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return { key: k, date: d, label: WEEK_LABEL[k], short: WEEK_SHORT[k] };
    });
  }
  function dateText(d) {
    const x = d || new Date();
    return (x.getMonth() + 1) + '月' + x.getDate() + '日';
  }

  // ---------- 固定块模板 -> 某天的块列表 ----------
  // 从模板中筛出该天适用的块，按 start 排序；自动在块之间插入空档（gap）。
  function blocksFor(dayKey) {
    const tpl = Storage.getTemplate();
    const active = tpl
      .filter(b => b.days && b.days.indexOf(dayKey) > -1)
      .map(b => Object.assign({}, b))
      .sort((a, b) => parse(a.start) - parse(b.start));

    // 去重 + 合并重叠（fixed 块优先级最高，先到的 fixed 永远完整保留）
    // 策略：
    //   prev fixed + cur 任意 → cur.start = prevE（cur 被推后；cur 自己的 kind 不变）
    //   prev 普通 + cur fixed → prev.end = curS（prev 被截到 cur.start 前）
    //   prev 普通 + cur 普通 → prev.end = curS（后块截断前块，原逻辑）
    // 注意：这里只调整 start/end，不删除块；start >= end 的空块会被后续 gap 插入逻辑忽略。
    for (let i = 1; i < active.length; i++) {
      const prev = active[i - 1];
      const cur  = active[i];
      const prevE = parse(prev.end);
      const curS  = parse(cur.start);
      if (curS >= prevE) continue;       // 不重叠
      // 重叠处理
      if (prev.kind === 'fixed') {
        // 先到的 fixed 完整保留 → cur 被推后到 prev.end 之后
        cur.start = hhmm(prevE);
      } else if (cur.kind === 'fixed') {
        // 后到的 fixed 不可被截断 → prev 被截到 cur.start 之前
        prev.end = cur.start;
      } else {
        // 两个普通块 → 后块截断前块（原逻辑）
        prev.end = cur.start;
      }
    }

    // 在块之间插入空档
    const out = [];
    let cursor = 0;   // 00:00
    for (const b of active) {
      const s = parse(b.start), e = parse(b.end);
      if (s >= e) continue;   // 空块（start 被推到 >= end）跳过
      if (s > cursor) {
        out.push({ kind: 'gap', label: '空档', start: hhmm(cursor), end: b.start });
      }
      out.push(b);
      cursor = Math.max(cursor, e);
    }
    if (cursor < 1440) {
      out.push({ kind: 'gap', label: '空档', start: hhmm(cursor), end: '23:59' });
    }
    return out;
  }

  function gapsFor(blocks) { return blocks.filter(b => b.kind === 'gap'); }
  function blockAt(blocks, mins) {
    return blocks.find(b => b.kind !== 'gap' && mins >= parse(b.start) && mins < parse(b.end)) || null;
  }
  function gapAt(blocks, mins) {
    return gapsFor(blocks).find(g => mins >= parse(g.start) && mins < parse(g.end)) || null;
  }

  // ---------- 任务排期操作 ----------
  function placeTask(taskId, day, start) {
    const task = Storage.getTasks().find(t => t.id === taskId);
    if (!task) return false;
    Storage.updateTask(taskId, { slot: { day, start } });
    Storage.recordSnapshot(day, start, taskId);
    return true;
  }
  function unplaceTask(taskId) {
    const task = Storage.getTasks().find(t => t.id === taskId);
    if (!task || !task.slot) return false;
    Storage.removeFromSnapshot(task.slot.day, task.slot.start);
    Storage.updateTask(taskId, { slot: null });
    return true;
  }
  function tasksIn(day, start, end) {
    return Storage.getTasks().filter(t => {
      if (!t.slot || t.slot.day !== day) return false;
      const m = parse(t.slot.start);
      return m >= parse(start) && m < parse(end);
    });
  }
  function unplacedTasks() {
    return Storage.getTasks().filter(t => !t.slot && !t.done);
  }

  // ---------- 待补（今天已过时段未完成） ----------
  function overdueTasks(day, mins) {
    return Storage.getTasks().filter(t => {
      if (t.done || !t.slot || t.slot.day !== day) return false;
      const m = parse(t.slot.start);
      return m < mins;
    });
  }

  // 找到今天接下来第一个可安排时段（非 fixed）
  function nextFreeBlock(day, afterMins) {
    const blocks = blocksFor(day);
    return blocks.find(b => b.kind !== 'fixed' && parse(b.start) > afterMins) || null;
  }

  // 明天第一个可安排时段的 start
  function tomorrowFirstStart() {
    const blocks = blocksFor(tomorrowKey());
    const b = blocks.find(x => x.kind !== 'fixed') || blocks[0];
    return b ? b.start : '09:00';
  }

  // ---------- 沿用上周 ----------
  // 从 snapshot 把 (day,start,taskId) 重新应用到当前还未排期的未完成任务上
  function reuseLastWeek() {
    const snap = Storage.getSnapshot();
    const tasksById = {};
    Storage.getTasks().forEach(t => { tasksById[t.id] = t; });

    let applied = 0;
    const usedSlots = new Set();
    for (const r of snap) {
      const t = tasksById[r.taskId];
      if (!t || t.done || t.slot) continue;                 // 任务不存在 / 已完成 / 已排期
      if (usedSlots.has(r.day + '|' + r.start)) continue;    // 同时段只放一件
      // 该时段在当前模板里必须是可安排的
      const block = blocksFor(r.day).find(b =>
        b.kind !== 'fixed' &&
        parse(r.start) >= parse(b.start) && parse(r.start) < parse(b.end)
      );
      if (!block) continue;
      placeTask(r.taskId, r.day, r.start);
      usedSlots.add(r.day + '|' + r.start);
      applied++;
    }
    return applied;
  }

  // ---------- 固定块模板 CRUD ----------
  function addBlock(b) {
    const tpl = Storage.getTemplate().slice();
    const nb = Object.assign({
      id: 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
      label: '新块', kind: 'block', start: '09:00', end: '10:00',
      days: ['mon','tue','wed','thu','fri'], note: '',
    }, b || {});
    tpl.push(nb);
    Storage.saveTemplate(tpl);
    return nb;
  }
  function updateBlock(id, patch) {
    const tpl = Storage.getTemplate().slice();
    const i = tpl.findIndex(b => b.id === id);
    if (i < 0) return null;
    tpl[i] = Object.assign({}, tpl[i], patch);
    Storage.saveTemplate(tpl);
    return tpl[i];
  }
  function removeBlock(id) {
    Storage.saveTemplate(Storage.getTemplate().filter(b => b.id !== id));
  }
  // 一键清空所有固定块（仅作用于模板，不触碰待办任务）
  function clearAllBlocks() {
    Storage.saveTemplate([]);
  }
  // 当前周键 YYYY-Www（ISO 周，以周一为界）
  function currentWeekKey() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const dow = (d.getDay() + 6) % 7;         // 周一=0
    d.setDate(d.getDate() - dow);             // 本周一
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    return d.getFullYear() + '-W' + (week < 10 ? '0' + week : '' + week);
  }

  /**
   * 获取未来可用空档列表（今天剩余 + 明天前几个）。
   *
   * 硬性规则（全部在这里层执行，下游直接信任）：
   *   1. 起点必须 >= 当前时间 + BUFFER（15 分钟缓冲），任何已过去时段一律不进。
   *   2. 每个 slot 的剩余时长必须 >= estMinutes（传入时）；放不下就跳过，不截断。
   *   3. 只返回 kind !== 'fixed' 的块；已排满的开始点自动跳过。
   *   4. 如果今天没有任何可行空档，则返回空数组给今天；若明天也没有则整体返回 [].
   *
   * 返回 [{ day, start, endMinutes, endMinsAbs, label }]，按时间升序。
   * endMinsAbs = parse(start) + endMinutes（绝对分钟，供下游二次校验）。
   */
  const BUFFER = 15;   // 未来时间缓冲（分钟），避免"卡着这一分钟"
  function getUpcomingSlots({ maxDays = 2, maxPerDay = 3, fromNow = true, snapMinutes = 30, estMinutes = 0 } = {}) {
    const mins0 = nowMinutes();
    const anchor = fromNow ? mins0 + BUFFER : 0;   // 锚点：未来要加缓冲
    const out = [];
    const seen = new Set();

    // 先处理今天，若无可行空档再看明天
    const wantedDays = [todayKey(), tomorrowKey()];
    for (const day of wantedDays) {
      if (wantedDays.indexOf(day) >= maxDays) break;
      const blocks = blocksFor(day);
      let dayHadAny = false;
      for (const b of blocks) {
        if (b.kind === 'fixed') continue;
        let startM = parse(b.start);
        const endM = parse(b.end);
        // 30 分钟吸附起点（向上取整）
        startM = Math.ceil(startM / snapMinutes) * snapMinutes;
        // 若是今天 + 未来模式，且吸附起点仍早于锚点，则抬到锚点（再吸附）
        if (fromNow && day === todayKey() && startM < anchor) {
          startM = Math.ceil(anchor / snapMinutes) * snapMinutes;
        }
        if (startM >= endM) continue;
        // estMinutes 过滤：剩余时长不够整个 est 就跳过整个块（不从块中间取截断 slot）
        const blockRemain = endM - startM;
        if (estMinutes && blockRemain < estMinutes) continue;

        for (let s = startM; s < endM; s += snapMinutes) {
          const remain = endM - s;
          if (estMinutes && remain < estMinutes) continue;  // 剩余放不下 → 跳过这个 slot
          const key = day + '|' + hhmm(s);
          if (seen.has(key)) continue;
          // 同时段已有任务则跳过
          const occupied = Storage.getTasks().some(t =>
            t.slot && t.slot.day === day && t.slot.start === hhmm(s)
          );
          if (occupied) continue;
          seen.add(key);
          dayHadAny = true;
          out.push({
            day,
            start: hhmm(s),
            endMinutes: remain,
            endMinsAbs: s + remain,
            label: b.label,
          });
          if (out.length >= maxDays * maxPerDay) return out;
        }
        if (out.length >= maxDays * maxPerDay) return out;
      }
      // 今天没任何可行空档 → 继续看明天（就是 wantedDays 顺序天然做到了）
    }
    return out;
  }

  /**
   * 给一个任务找合适的空档（本地规则 · 不看语义时间词的纯粹版）。
   * 能完整放下 estMinutes 的最早可行空档；找不到就返回 null（不截断、不硬塞）。
   */
  function findSlotForTask(estMinutes) {
    const target = Math.max(estMinutes || 30, 30);
    const slots = getUpcomingSlots({ maxDays: 2, maxPerDay: 20, snapMinutes: 30, estMinutes: target });
    if (!slots.length) return null;
    // 已经在 getUpcomingSlots 里筛过 endMinutes >= target；这里直接取第一个
    return slots[0];
  }

  /**
   * 从候选空档里，选一个与「语义时间目标」最近、且能放下 est 的 slot。
   * 语义目标：早(8-11)、中(11:30-13:30)、晚(18-23)、睡前(21:30+)、全天。
   * 用于本地规则兜底（吃晚饭 → 找傍晚/晚上最近的空档）。
   */
  function findSlotBySemanticTime(estMinutes, hintKind) {
    const target = Math.max(estMinutes || 30, 30);
    // hintKind: 'morning' | 'noon' | 'evening' | 'late' | null
    // 先用带 est 的 getUpcomingSlots 拿到"完整能放下 est"的候选
    const slots = getUpcomingSlots({ maxDays: 2, maxPerDay: 30, snapMinutes: 30, estMinutes: target });
    if (!slots.length) return null;

    if (!hintKind) return slots[0];   // 没语义就取最早

    // 给每个 slot 算一个"到语义目标的分钟距离"（以 parse(start) 作为 slot 代表）
    const anchors = {
      morning: [parse('09:00'), parse('12:00')],      // 上午段中间
      noon:    [parse('12:00'), parse('13:00')],      // 午休附近
      evening: [parse('18:30'), parse('20:00')],      // 晚饭 / 晚上
      late:    [parse('21:30'), parse('22:30')],      // 睡前
    };
    const anchor = anchors[hintKind] || [parse('12:00'), parse('14:00')];
    const anchorMid = Math.round((anchor[0] + anchor[1]) / 2);

    // 当天：直接算 |parse(slot.start) - anchorMid|
    // 明天：anchor 加 1440（把它当作"明天同一时刻"来比）
    const todayKeyNow = todayKey();
    const ranked = slots.map(s => {
      const sM = parse(s.start);
      const offset = s.day === todayKeyNow ? 0 : 1440;
      return { slot: s, diff: Math.abs((sM + offset) - anchorMid) };
    }).sort((a, b) => a.diff - b.diff);

    return ranked[0] && ranked[0].slot ? ranked[0].slot : null;
  }

  // ---------- 导出到 window ----------
  global.Schedule = {
    // 常量
    BUFFER,
    // 时间
    WEEK, WEEK_LABEL, WEEK_SHORT,
    pad, parse, hhmm, fmtDur, nowMinutes,
    dayKeyOf, todayKey, tomorrowKey, weekDates, dateText,
    // 块
    blocksFor, gapsFor, blockAt, gapAt,
    // 排期
    placeTask, unplaceTask, tasksIn, unplacedTasks,
    // 待补
    overdueTasks, nextFreeBlock, tomorrowFirstStart,
    // 沿用上周
    reuseLastWeek,
    // 模板
    addBlock, updateBlock, removeBlock, clearAllBlocks, currentWeekKey,
    // 排期建议辅助
    getUpcomingSlots, findSlotForTask, findSlotBySemanticTime,
  };
})(window);
