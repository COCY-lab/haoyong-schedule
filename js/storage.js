/* ============================================================
 * 随手记任务 · storage.js
 * 本地持久化（localStorage）+ JSON 导入导出 + 版本迁移
 * 纯函数 + 一个全局 Storage 对象暴露
 * ============================================================ */

(function (global) {
  'use strict';

  // —— 按模块分层命名，方便后续扩展 ——
  const KEY_TASKS     = 'ssj.v1.tasks';
  const KEY_SETTINGS  = 'ssj.v1.settings';    // AI 配置、主题等公共设置
  const KEY_PROFILE   = 'ssj.v1.profile';     // 用户背景、修正记录等个人资料
  const KEY_SCHEDULES = 'ssj.v1.schedules';   // 固定块模板 + 周排期快照（现在/周表模块）

  const KEY_VERSION = 'ssj.version';

  const CURRENT_VERSION = 1;
  const MAX_SHOTS = 20;                 // few-shot 上限
  const MAX_SHOT_TEXT_LEN = 300;        // 单条限制（避免 prompt 膨胀）

  // ---------- 底层存取 ----------
  function getJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      console.warn('[storage] JSON parse failed for', key, e);
      return fallback;
    }
  }
  function setJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); }
    catch (e) { console.error('[storage] setItem failed', key, e); }
  }

  // ---------- 初始化 & 迁移 ----------
  function init() {
    const ver = parseInt(localStorage.getItem(KEY_VERSION) || '0', 10);
    if (ver < CURRENT_VERSION) {
      // 预留迁移入口，v1 初次无需动作
      localStorage.setItem(KEY_VERSION, String(CURRENT_VERSION));
    }
    // 兼容老 key（之前版本用了分散的 key，合到新分层 key 里）
    migrateOldKeys();
    // 确保存在
    if (!Array.isArray(getTasks()))   setJSON(KEY_TASKS, []);
    if (!getSettings())               setJSON(KEY_SETTINGS, defaultSettings());
    if (!getProfile())                setJSON(KEY_PROFILE, defaultProfile());
    if (!getSchedules())              setJSON(KEY_SCHEDULES, defaultSchedules());
  }

  function migrateOldKeys() {
    const needMigrate =
      localStorage.getItem('ssj.config.v1') !== null ||
      localStorage.getItem('ssj.userBg.v1') !== null ||
      localStorage.getItem('ssj.shots.v1') !== null ||
      localStorage.getItem('ssj.theme.v1') !== null;
    if (!needMigrate) return;
    // 合并旧值
    const oldCfg = getJSON('ssj.config.v1', null);
    const oldBg  = localStorage.getItem('ssj.userBg.v1');
    const oldShots = getJSON('ssj.shots.v1', null);
    const oldTheme = localStorage.getItem('ssj.theme.v1');

    const s = Object.assign(defaultSettings(), oldCfg || {}, oldTheme ? { theme: oldTheme } : {});
    const p = Object.assign(defaultProfile(), oldBg !== null ? { userBg: oldBg } : {}, oldShots ? { shots: oldShots } : {});
    setJSON(KEY_SETTINGS, s);
    setJSON(KEY_PROFILE, p);

    // 清掉旧 key
    ['ssj.config.v1','ssj.userBg.v1','ssj.shots.v1','ssj.theme.v1'].forEach(k => localStorage.removeItem(k));
  }

  function defaultSettings() {
    return {
      // —— 公共设置（AI 配置是两个模块共用）——
      ai: {
        baseURL:   '',    // 默认留空，设置页给 DeepSeek / OpenAI 示例占位
        apiKey:    '',
        model:     '',
        timeoutMs: 8000,
      },
      theme: '',          // '' / 'dark'
      lastExportAt: 0,    // 上次导出 JSON 的时间戳（备份提醒用）
      // （预留）schedulesView: 'week',
    };
  }

  function defaultProfile() {
    return {
      userBg: '',         // 用户背景，AI 判断时作为 system prompt
      shots:  [],         // few-shot 修正记录（见 recordShot）
    };
  }

  // ---------- 任务 ----------
  function getTasks() { return getJSON(KEY_TASKS, []); }
  function saveTasks(list) { setJSON(KEY_TASKS, list); }

  function addTask(text, extra = {}) {
    const list = getTasks();
    const t = {
      id:        genId(),
      text:      String(text || '').trim(),
      createdAt: Date.now(),
      done:      false,
      doneAt:    null,
      ai:        null,        // { tags:[], priority, estMinutes, suggestion, status:'ok'|'rule'|'none'|'error' }
      slot:      null,        // 排期：{ day: 'mon', start: '09:00' }，null 表示未排期
      scheduleId: null,       // （预留）之后归属某个时间段的 id
      // （预留）source: 'quick' | 'schedule' —— 从哪来
      ...extra,
    };
    if (!t.text) return null;
    list.unshift(t);   // 新的顶在前
    saveTasks(list);
    return t;
  }

  function updateTask(id, patch) {
    const list = getTasks();
    const i = list.findIndex(t => t.id === id);
    if (i < 0) return null;
    list[i] = Object.assign({}, list[i], patch);
    saveTasks(list);
    return list[i];
  }

  function removeTask(id) {
    const list = getTasks().filter(t => t.id !== id);
    saveTasks(list);
  }

  function toggleDone(id) {
    const list = getTasks();
    const i = list.findIndex(t => t.id === id);
    if (i < 0) return null;
    list[i].done = !list[i].done;
    list[i].doneAt = list[i].done ? Date.now() : null;
    saveTasks(list);
    return list[i];
  }

  // ============================================================
  // settings 模块（公共设置：AI、主题、...）
  // ============================================================
  function getSettings() {
    const s = getJSON(KEY_SETTINGS, null);
    return s ? Object.assign(defaultSettings(), s, { ai: Object.assign(defaultSettings().ai, s.ai || {}) }) : defaultSettings();
  }
  function saveSettings(s) {
    const merged = Object.assign(defaultSettings(), getSettings(), s || {});
    if (s && s.ai) merged.ai = Object.assign(defaultSettings().ai, getSettings().ai, s.ai);
    setJSON(KEY_SETTINGS, merged);
  }

  // AI 配置（两个模块共用的公共配置）
  function getAIConfig() { return getSettings().ai || defaultSettings().ai; }
  function saveAIConfig(ai) {
    saveSettings({ ai: Object.assign(defaultSettings().ai, ai || {}) });
  }
  // —— 兼容层：app.js / ai.js 用 getConfig / saveConfig 即可 ——
  const getConfig  = getAIConfig;
  const saveConfig = saveAIConfig;

  // 主题
  function getTheme() { return getSettings().theme || ''; }
  function setTheme(t) { saveSettings({ theme: t || '' }); }

  // 上次导出时间（备份提醒）
  function getLastExportAt() { return Number(getSettings().lastExportAt) || 0; }
  function setLastExportAt(ts) { saveSettings({ lastExportAt: Number(ts) || Date.now() }); }

  // ============================================================
  // profile 模块（用户背景、修正记录）
  // ============================================================
  function getProfile() {
    const p = getJSON(KEY_PROFILE, null);
    return p ? Object.assign(defaultProfile(), p) : defaultProfile();
  }
  function saveProfile(p) {
    const merged = Object.assign(defaultProfile(), getProfile(), p || {});
    setJSON(KEY_PROFILE, merged);
  }

  function getUserBg() { return getProfile().userBg || ''; }
  function saveUserBg(text) {
    saveProfile({ userBg: String(text || '').slice(0, 4000) });
  }
  function clearUserBg() { saveProfile({ userBg: '' }); }

  function getShots()  { return (getProfile().shots || []).slice(0, MAX_SHOTS); }
  function saveShots(list) { saveProfile({ shots: (list || []).slice(0, MAX_SHOTS) }); }
  function clearShots() { saveProfile({ shots: [] }); }

  function recordShot(task) {
    if (!task || !task.ai || !task.ai.status || task.ai.status !== 'ok') return;
    if (!task.ai.userEdited) return;  // app.js 设的标记
    const shot = {
      text:      String(task.text).slice(0, 200),
      original:  {
        tags:     (task.ai.originalTags     || task.ai.tags || []).slice(0, 6),
        priority: task.ai.originalPriority  || task.ai.priority || 'mid',
      },
      corrected: {
        tags:     (task.ai.tags || []).slice(0, 6),
        priority: task.ai.priority || 'mid',
      },
      ts: Date.now(),
    };
    const serialized = JSON.stringify(shot);
    if (serialized.length > MAX_SHOT_TEXT_LEN * 3) return;

    const shots = getShots().filter(s => s.text !== shot.text);
    shots.unshift(shot);
    saveShots(shots);
  }

  // ============================================================
  // schedules 模块（周表）：固定块模板 + 周排期快照
  // ============================================================
  // 默认固定块模板：按工作日 / 周末分；块 kind: 'fixed'|'block'|'gap'
  // fixed 固定安排（不参与排期）；block 可安排整块；gap 空档（可临时放事）
  function defaultTemplate() {
    return [
      { id: 'f1', label: '起床 · 早餐',   kind: 'fixed', start: '07:00', end: '08:00', days: ['mon','tue','wed','thu','fri','sat','sun'] },
      { id: 'b1', label: '深度工作',      kind: 'block', start: '09:00', end: '12:00', days: ['mon','tue','wed','thu','fri'], note: '一天里最清醒的时段' },
      { id: 'f2', label: '午饭 · 散步',   kind: 'fixed', start: '12:00', end: '13:00', days: ['mon','tue','wed','thu','fri','sat','sun'] },
      { id: 'b2', label: '项目推进',      kind: 'block', start: '14:00', end: '18:00', days: ['mon','tue','wed','thu','fri'], note: '下午留给推进型工作' },
      { id: 'f3', label: '晚饭',          kind: 'fixed', start: '18:30', end: '19:30', days: ['mon','tue','wed','thu','fri','sat','sun'] },
      { id: 'b3', label: '自己的事',      kind: 'block', start: '13:30', end: '16:00', days: ['sat','sun'], note: '周末留给自己' },
      { id: 'f4', label: '阅读 · 收尾',   kind: 'fixed', start: '21:00', end: '22:30', days: ['mon','tue','wed','thu','fri','sat','sun'] },
    ];
  }

  function defaultSchedules() {
    return {
      template: defaultTemplate(),
      // 周排期快照：最近一次排期的 (day, start, taskId) 列表，用于"沿用上周"
      // 只记录未完成的排期，每条 { day, start, taskId }
      snapshot: [],
      // 周表当前选中的天
      weekDay: null,
      // 新周固定块清理提示：已提示到哪一周（YYYY-Www），null 表示从未提示
      lastPromptWeek: null,
    };
  }

  function getSchedules() {
    const s = getJSON(KEY_SCHEDULES, null) || {};
    // 关键：空数组也是用户的合法选择（主动删空），不能再回填默认模板。
    // 只有 KEY 不存在（首次使用，s.template === undefined）时才回落默认。
    const tpl = Array.isArray(s.template) ? s.template : defaultTemplate();
    return {
      template: tpl,
      snapshot: Array.isArray(s.snapshot) ? s.snapshot : [],
      weekDay: s.weekDay || null,
      lastPromptWeek: s.lastPromptWeek || null,
    };
  }
  function saveSchedules(s) {
    const cur = getSchedules();
    const merged = Object.assign({}, cur, s || {});
    // 防御：template 必须是数组
    if (!Array.isArray(merged.template)) merged.template = defaultTemplate();
    setJSON(KEY_SCHEDULES, merged);
  }

  function getTemplate() {
    const t = getSchedules().template;
    return Array.isArray(t) ? t : defaultTemplate();
  }
  function saveTemplate(tpl) {
    saveSchedules({ template: Array.isArray(tpl) ? tpl : defaultTemplate() });
  }

  function getSnapshot() { return getSchedules().snapshot || []; }
  function saveSnapshot(list) { saveSchedules({ snapshot: (list || []).slice() }); }

  /**
   * 记录一次排期到快照（用于沿用上周）。
   * 同 (day,start) 只保留最新一条。
   */
  function recordSnapshot(day, start, taskId) {
    const list = getSnapshot().filter(r => !(r.day === day && r.start === start));
    list.push({ day, start, taskId });
    saveSnapshot(list);
  }
  function removeFromSnapshot(day, start) {
    saveSnapshot(getSnapshot().filter(r => !(r.day === day && r.start === start)));
  }

  // ============================================================
  // 备份 / 恢复（按模块分层输出）
  // ============================================================
  function exportAll() {
    return {
      app: '好用的日程表',
      version: CURRENT_VERSION,
      exportedAt: Date.now(),
      modules: {
        tasks:     getTasks(),
        settings:  getSettings(),
        profile:   getProfile(),
        schedules: getSchedules(),
      },
    };
  }

  function importAll(payload, { merge = false } = {}) {
    if (!payload || typeof payload !== 'object') throw new Error('文件格式不对');

    // 兼容老格式 & 新格式
    let tasks, settings, profile, schedules;
    if (payload.modules) {
      tasks     = payload.modules.tasks;
      settings  = payload.modules.settings;
      profile   = payload.modules.profile;
      schedules = payload.modules.schedules;
    } else {
      // 老格式 fallback
      tasks    = payload.tasks;
      settings = payload.config ? { ai: payload.config } : null;
      profile  = { userBg: payload.userBg || '', shots: Array.isArray(payload.shots) ? payload.shots : [] };
    }

    if (!Array.isArray(tasks)) throw new Error('缺少 tasks 字段');

    if (!merge) {
      saveTasks(tasks);
    } else {
      const existIds = new Set(getTasks().map(t => t.id));
      const newOnes = tasks.filter(t => !existIds.has(t.id));
      saveTasks(newOnes.concat(getTasks()));
    }
    if (settings)  saveSettings(settings);
    if (profile)   saveProfile(profile);
    if (schedules) saveSchedules(schedules);

    return { imported: tasks.length };
  }

  // ---------- 工具 ----------
  function genId() {
    return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ---------- 导出 ----------
  global.Storage = {
    init,
    // tasks 模块
    getTasks, addTask, updateTask, removeTask, toggleDone,
    // settings 模块
    getSettings, saveSettings,
    getAIConfig, saveAIConfig,
    getConfig, saveConfig,   // 兼容层（= getAIConfig / saveAIConfig）
    getTheme, setTheme,
    getLastExportAt, setLastExportAt,
    // profile 模块
    getProfile, saveProfile,
    getUserBg, saveUserBg, clearUserBg,
    getShots, saveShots, clearShots, recordShot,
    // schedules 模块（周表）
    getSchedules, saveSchedules,
    getTemplate, saveTemplate,
    getSnapshot, saveSnapshot, recordSnapshot, removeFromSnapshot,
    // backup
    exportAll, importAll,
    // constants
    MAX_SHOTS,
  };
})(window);
