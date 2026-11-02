/* ============================================================
 * 随手记任务 · ai.js
 * AI 自动打标签：OpenAI 兼容 Chat Completions
 *  - 调用失败 / 超时 / 无 key → 立刻回落到本地关键词规则
 *  - 所有配置从 Storage 读，只做 POST，不做持久化
 * ============================================================ */

(function (global) {
  'use strict';

  /**
   * 对一条任务做判断，返回一个 Promise。
   * 无论联网成功与否，最终 resolve 一个 aiResult：
   *   { status: 'ok'|'rule'|'none'|'error', tags:[], priority, estMinutes, suggestion, error? }
   * 调用方必须自己写入 Storage。
   */
  async function judge(text) {
    const cfg = Storage.getConfig();
    const key = (cfg.apiKey || '').trim();
    const url = (cfg.baseURL || '').trim().replace(/\/$/, '');
    const model = (cfg.model || '').trim();

    if (!key || !url || !model) {
      const rb = ruleBased(text);
      rb.status = 'none';
      rb.note = 'AI 未启用';
      rb.scheduleSuggestion = suggestScheduleByRule(text, null, rb.priority);
      return rb;
    }

    try {
      const timeout = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 8000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const body = buildPayload(text, cfg);
      const resp = await fetch(url + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error('HTTP ' + resp.status + ' ' + errText.slice(0, 120));
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || '';
      const parsed = tryParseJSON(content) || {};

      const est = normalizeEstMinutes(parsed.estMinutes ?? parsed.est_minutes ?? parsed.minutes);
      const clean = {
        tags:       normalizeTags(parsed.tags),
        priority:   normalizePriority(parsed.priority),
        estMinutes: est,
        suggestion: String(parsed.suggestion || parsed.advice || '').slice(0, 240).trim(),
      };
      if (!clean.tags.length) clean.tags = ruleBased(text).tags;
      if (!clean.priority)    clean.priority = ruleBased(text).priority;

      // 排期建议：双重校验（字段合法 + 真的是未来可行空档），不合格就回落本地规则
      const sched = parsed.scheduleSuggestion || parsed.suggestion_schedule || parsed.schedule;
      clean.scheduleSuggestion = normalizeScheduleSuggestion(sched, est, clean.priority, text);

      return { status: 'ok', ...clean };
    } catch (e) {
      const rb = ruleBased(text);
      rb.status = 'error';
      rb.error  = (e && (e.name === 'AbortError' ? '请求超时' : (e.message || String(e)))) || '未知错误';
      rb.scheduleSuggestion = suggestScheduleByRule(text, null, rb.priority);
      return rb;
    }
  }

  // ---------- Payload 构造 ----------
  function buildPayload(text, cfg) {
    const bg = Storage.getUserBg().trim();
    const shots = Storage.getShots().slice(0, 5); // 前 5 条

    // 注入时间上下文（当前时间 + 今天剩余空档 + 明天空档，全部来自 schedule.js）
    let slotsHint = '';
    let nowHint = '';
    try {
      if (window.Schedule && window.Schedule.getUpcomingSlots) {
        const nowM = Schedule.nowMinutes();
        const nowLabel = Schedule.hhmm(nowM);
        const labelMap = { mon: '周一', tue: '周二', wed: '周三', thu: '周四', fri: '周五', sat: '周六', sun: '周日' };

        // 带 est=0 的完整候选（不过滤时长），让 AI 看到全部可行空档再自己判断
        const slots = Schedule.getUpcomingSlots({ maxDays: 2, maxPerDay: 6, snapMinutes: 30, fromNow: true, estMinutes: 0 });
        const todayKeyNow = Schedule.todayKey();

        // 分今天 / 明天
        const todaySlots = slots.filter(s => s.day === todayKeyNow);
        const tomorrowSlots = slots.filter(s => s.day !== todayKeyNow);

        const formatList = list => list.map((s, i) =>
          `  ${i+1}. ${labelMap[s.day]} ${s.start}（剩约 ${s.endMinutes} 分钟，块:"${s.label}"）`
        ).join('\n');

        nowHint = `\n当前时间：${nowLabel}（${labelMap[todayKeyNow]}）`;
        if (todaySlots.length) {
          slotsHint += `\n【今天剩余可行空档】（只能从中选一个开始时间）：\n${formatList(todaySlots)}`;
        } else {
          slotsHint += `\n【今天已无可行空档】（全部被占或已过去）`;
        }
        if (tomorrowSlots.length) {
          slotsHint += `\n【明天可行空档】（今天放不下时再考虑）：\n${formatList(tomorrowSlots)}`;
        }
      }
    } catch (e) { /* schedule.js 未就绪时静默 */ }

    const sysParts = [
      '你是一个简洁的任务标签 + 排期建议助手。',
      '请严格输出一个 JSON 对象（不要 Markdown 代码块、不要额外解释）：',
      '{"tags": ["标签1", "标签2"], "priority": "high|mid|low", "estMinutes": 数字, "suggestion": "一句话行动建议，≤40字", "scheduleSuggestion": {"day": "mon|tue|...", "start": "HH:MM", "minutes": 30|60|90|120, "reason": "一句话理由，≤25字"}}',
      '硬性约束：',
      '  - tags 2~4 个中文短语；priority high(紧急)/mid(一般)/low(有空再做)；estMinutes 拿不准给 30 或 45。',
      '  - scheduleSuggestion.day 和 start 必须从【今天剩余可行空档】或【明天可行空档】的列表中选一个明确的条目，不能自己编。',
      '  - scheduleSuggestion.minutes 取 30/60/90/120，必须 ≤ 所选空档的剩余分钟数；reason 要短。',
      '  - 如果列表里没有任何合适空档（比如任务明显不该在这些时间），scheduleSuggestion 可以是 null。',
    ];

    if (nowHint) sysParts.push(nowHint);
    if (bg) sysParts.push('用户背景：' + bg.slice(0, 3000));
    if (shots.length) {
      sysParts.push(
        '历史上用户曾手动修正过标签：\n' +
        shots.map((s, i) => `${i+1}. "${s.text}" → ${JSON.stringify(s.corrected)}`).join('\n')
      );
    }
    if (slotsHint) sysParts.push(slotsHint);

    return {
      model: cfg.model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: sysParts.join('\n') },
        { role: 'user',   content: text },
      ],
      response_format: { type: 'json_object' },
    };
  }

  // ---------- 本地关键词规则（兜底 & 无 key） ----------
  const RULES = [
    { kw: ['紧急','立刻','马上','尽快','asap','urgent'],           tags: ['紧急'], priority: 'high' },
    { kw: ['今天','今晚','下班前','午休'],                          tags: ['今日'], priority: 'high' },
    { kw: ['明天','明天要','明天记得'],                              tags: ['明日'], priority: 'mid' },
    { kw: ['周','月','季度','年底'],                                tags: ['规划'], priority: 'low' },
    { kw: ['代码','修复','bug','接口','重构','前端','后端','测试','部署'], tags: ['技术'], priority: 'mid' },
    { kw: ['写','文章','文档','笔记','总结','复盘','方案'],         tags: ['写作'], priority: 'mid' },
    { kw: ['会','会议','约','对接','沟通','电话','聊'],             tags: ['沟通'], priority: 'mid' },
    { kw: ['买','购物','下单','超市','快递','收','寄'],             tags: ['生活'], priority: 'low' },
    { kw: ['读','书','学习','看视频','课程','教程'],                tags: ['学习'], priority: 'low' },
    { kw: ['运动','跑','健身','瑜伽','打球'],                       tags: ['健康'], priority: 'mid' },
    { kw: ['邮件','回复','回信','email'],                           tags: ['邮件'], priority: 'mid' },
    { kw: ['账单','付款','缴费','发票','报销','钱'],                tags: ['财务'], priority: 'mid' },
    { kw: ['项目','上线','发布','规划','产品','prd'],               tags: ['项目'], priority: 'high' },
    { kw: ['家庭','孩子','家人','老婆','老公','爸妈'],              tags: ['家庭'], priority: 'mid' },
    { kw: ['忘','提醒','记得'],                                     tags: ['提醒'], priority: 'low' },
  ];

  function ruleBased(text) {
    const s = String(text || '').toLowerCase();
    const tags = new Set();
    let priority = 'mid';

    for (const r of RULES) {
      for (const k of r.kw) {
        if (s.includes(k.toLowerCase())) {
          r.tags.forEach(t => tags.add(t));
          if (rankOf(r.priority) > rankOf(priority)) priority = r.priority;
          break;
        }
      }
    }
    const arr = Array.from(tags).slice(0, 4);
    if (!arr.length) arr.push('待分类');
    return { tags: arr, priority, estMinutes: null, suggestion: '' };
  }
  function rankOf(p) { return { high:3, mid:2, low:1 }[p] || 2; }

  // ---------- 本地规则排期建议 ----------
  // 给一条任务的文本 + 估时 + 优先级，找合适的空档。
  // 逻辑：先从 text 里提取语义时间词（早饭/午饭/晚饭/睡前），有就取离该时间段最近的可行空档；
  // 没提取到就取"最早能放下的"可行空档。找不到可行空档就返回 null。
  // 返回 { day, start, minutes, reason, source:'rule' } 或 null。
  const TIME_WORD_MAP = [
    { kind: 'morning', kws: ['早饭','早餐','早上','早晨','上午','晨'] },
    { kind: 'noon',    kws: ['午饭','中饭','午餐','中午','午休'] },
    { kind: 'evening', kws: ['晚饭','晚餐','晚上','傍晚','晚','夜','宵夜'] },
    { kind: 'late',    kws: ['睡前','睡觉','上床','夜里','凌晨'] },
  ];
  function extractTimeHint(text) {
    const s = String(text || '').toLowerCase();
    for (const g of TIME_WORD_MAP) {
      for (const k of g.kws) { if (s.indexOf(k) >= 0) return g.kind; }
    }
    return null;
  }

  function suggestScheduleByRule(text, estMinutes, priority) {
    if (!window.Schedule) return null;
    const defaultEst = { high: 30, mid: 45, low: 60 }[priority || 'mid'] || 45;
    const mins = Math.max(estMinutes || defaultEst, 30);

    const hint = extractTimeHint(text);
    let slot;
    if (hint) {
      slot = Schedule.findSlotBySemanticTime(mins, hint);
    } else {
      slot = Schedule.findSlotForTask(mins);
    }
    if (!slot) return null;

    // 30 分钟吸附：把估时 round 到 30/60/90/120，且 ≤ 空档剩余
    const snapped = Math.round(mins / 30) * 30;
    const minutes = Math.min(Math.max(snapped, 30), 120, slot.endMinutes);

    let reason;
    if (hint === 'morning') reason = '任务语义偏早，安排到上午';
    else if (hint === 'noon')    reason = '临近午休，先放午饭附近';
    else if (hint === 'evening') reason = '吃晚饭相关，排到傍晚/晚上';
    else if (hint === 'late')    reason = '睡前相关，放到夜晚';
    else {
      const reasonByPriority = {
        high: '任务紧急，尽早开始',
        mid:  '有空再做，见缝插针',
        low:  '优先级低，先让给紧急',
      };
      reason = reasonByPriority[priority || 'mid'] || '本地规则建议';
    }

    return {
      day: slot.day,
      start: slot.start,
      minutes,
      reason: String(reason).slice(0, 25),
      source: 'rule',
      generatedAt: Date.now(),
    };
  }

  // ---------- AI 排期建议 规范化 ----------
  // 双重校验：
  //   1) 字段格式合法（day 在 WEEK、start 是 HH:MM、minutes 30 的倍数）
  //   2) 必须真的是未来时间 + 能完整放下 est（用 getUpcomingSlots({ fromNow:true, estMinutes }) 查找）
  // 任一校验不过 → 回落 suggestScheduleByRule。
  function normalizeScheduleSuggestion(raw, estMinutes, priority, fallbackText) {
    const WEEK = ['mon','tue','wed','thu','fri','sat','sun'];
    const nowMin = (window.Schedule && window.Schedule.nowMinutes) ? Schedule.nowMinutes() : new Date().getHours() * 60 + new Date().getMinutes();
    const BUF = (window.Schedule && window.Schedule.BUFFER) ? Schedule.BUFFER : 15;
    const fallback = () => suggestScheduleByRule(fallbackText, estMinutes, priority);

    if (!raw || typeof raw !== 'object') return fallback();

    // 1) day 合法
    if (!raw.day || WEEK.indexOf(raw.day) < 0) return fallback();

    // 2) start 必须是 HH:MM 格式
    if (!raw.start || !/^([01]?\d|2[0-3]):([0-5]\d)$/.test(raw.start)) return fallback();

    const startM = parse(raw.start);

    // 3) minutes：30 的倍数，30~120
    const minsRaw = Number(raw.minutes);
    let minutes;
    if (Number.isFinite(minsRaw) && minsRaw >= 30 && minsRaw <= 120) {
      minutes = Math.round(minsRaw / 30) * 30;
      if (minutes < 30) minutes = 30;
      if (minutes > 120) minutes = 120;
    } else {
      minutes = Math.min(120, Math.max(30, Math.round((estMinutes || 45) / 30) * 30));
    }

    // 4) 二次硬性校验：
    //    a. 若是今天：startM 必须 >= nowMin + BUFFER（未来且有缓冲）
    //    b. 该 slot 必须真的存在于 getUpcomingSlots({ fromNow:true, estMinutes }) 里
    //    c. 空档剩余 endMinutes 必须 >= minutes
    if (raw.day === (window.Schedule && Schedule.todayKey()) && startM < nowMin + BUF) {
      return fallback();   // AI 编了今天已过去或马上到的时段
    }
    try {
      const slots = window.Schedule.getUpcomingSlots({
        maxDays: 2, maxPerDay: 30, snapMinutes: 30, fromNow: true, estMinutes: minutes,
      });
      const hit = slots.find(s => s.day === raw.day && s.start === raw.start);
      if (!hit) return fallback();   // 不在真实的可行空档里
      if (hit.endMinutes < minutes) return fallback();   // 放不下 est
    } catch (e) {
      return fallback();
    }

    // 5) reason ≤ 25 字
    const reason = String(raw.reason || '').slice(0, 25);

    return { day: raw.day, start: raw.start, minutes, reason, source: 'ai', generatedAt: Date.now() };
  }

  // ---------- 结果规范化 ----------
  function normalizeTags(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(s => String(s).trim()).filter(Boolean).slice(0, 4);
  }
  function normalizePriority(p) {
    const s = String(p || '').toLowerCase();
    if (['high','h','高','紧急'].includes(s)) return 'high';
    if (['low','l','低','不急'].includes(s)) return 'low';
    return 'mid';
  }
  function normalizeEstMinutes(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && n < 10080) return Math.round(n); // 上限一周
    return null;
  }
  function tryParseJSON(s) {
    if (!s) return null;
    try { return JSON.parse(s); } catch (e) {
      // 尝试从 ```json ... ``` 里捞
      const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (m) try { return JSON.parse(m[1]); } catch (_) {}
      // 再找第一个 { 到最后一个 }
      const a = s.indexOf('{'), b = s.lastIndexOf('}');
      if (a >= 0 && b > a) try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {}
      return null;
    }
  }

  // ---------- 测试连通 ----------
  async function testConnection() {
    const res = await judge('测试连通一下');
    return res;
  }

  // ---------- 导出 ----------
  global.AI = { judge, testConnection, suggestScheduleByRule, normalizeScheduleSuggestion };
})(window);
