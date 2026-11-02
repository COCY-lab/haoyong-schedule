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

    // 去重 + 合并重叠（简单策略：后块的 start 若早于前块 end，截断前块 end）
    for (let i = 1; i < active.length; i++) {
      const prev = active[i - 1];
      if (parse(active[i].start) < parse(prev.end)) {
        prev.end = active[i].start;
      }
    }

    // 在块之间插入空档
    const out = [];
    let cursor = 0;   // 00:00
    for (const b of active) {
      const s = parse(b.start), e = parse(b.end);
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

  // ---------- 导出到 window ----------
  global.Schedule = {
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
    addBlock, updateBlock, removeBlock, resetTemplate,
  };
})(window);
