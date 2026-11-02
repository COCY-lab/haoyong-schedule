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
      return { status: 'none', ...ruleBased(text), note: 'AI 未启用（缺少 Key / Base URL / 模型）' };
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

      const clean = {
        tags:       normalizeTags(parsed.tags),
        priority:   normalizePriority(parsed.priority),
        estMinutes: normalizeEstMinutes(parsed.estMinutes ?? parsed.est_minutes ?? parsed.minutes),
        suggestion: String(parsed.suggestion || parsed.advice || '').slice(0, 240).trim(),
      };
      if (!clean.tags.length) clean.tags = ruleBased(text).tags;
      if (!clean.priority)    clean.priority = ruleBased(text).priority;

      return { status: 'ok', ...clean };
    } catch (e) {
      const rb = ruleBased(text);
      rb.status = 'error';
      rb.error  = (e && (e.name === 'AbortError' ? '请求超时' : (e.message || String(e)))) || '未知错误';
      return rb;
    }
  }

  // ---------- Payload 构造 ----------
  function buildPayload(text, cfg) {
    const bg = Storage.getUserBg().trim();
    const shots = Storage.getShots().slice(0, 5); // 前 5 条

    const sysParts = [
      '你是一个简洁的任务标签助手，会给用户随手记下的一句话任务打标签。',
      '请严格输出一个 JSON 对象，字段如下（不要 Markdown 代码块、不要额外解释）：',
      '{"tags": ["标签1", "标签2"], "priority": "high|mid|low", "estMinutes": 数字, "suggestion": "一句话行动建议，≤40字"}',
      '约束：tags 2~4 个，用中文短语，可覆盖领域 / 类型 / 场景；priority 判断为 high（紧急或影响大）/ mid（一般）/ low（有空再做）；estMinutes 是你预估的分钟数，实在拿不准给 15。',
    ];

    if (bg) {
      sysParts.push('用户背景：' + bg.slice(0, 3000));
    }
    if (shots.length) {
      sysParts.push(
        '历史上用户曾手动修正过标签，这是参考（请谨慎，仅作参考）：\n' +
        shots.map((s, i) =>
          `${i+1}. 任务:"${s.text}"  原AI:${JSON.stringify(s.original)}  用户改成:${JSON.stringify(s.corrected)}`
        ).join('\n')
      );
    }

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
  global.AI = { judge, testConnection };
})(window);
