// api/ai.js — 雙模式 API
//   GET  → 從 Notion 讀取 AI 分析（市場情緒、台股籌碼、美股籌碼）
//   POST → Claude AI 聊天（速懶報 AI 助理），帶 lookup_stock tool 防止股票代號幻覺
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// ── 股票查詢工具（避免 AI 對 4 位代號幻覺）────────────────
//   台股優先：TWSE 上市 → TPEx 上櫃
//   美股：Yahoo Finance v8 chart meta（拿 longName）
async function lookupStock(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { error: 'empty code' };

  // ── 台股：4-5 位純數字（含 ETF 如 0050、00878）──────────
  if (/^\d{4,5}$/.test(code)) {
    const tryEndpoint = async (channel) => {
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${channel}_${code}.tw&json=1&delay=0`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return null;
      const data = await r.json();
      const q = data.msgArray?.[0];
      if (!q || !q.n) return null;
      const last = parseFloat(q.z !== '-' ? q.z : q.y);
      const prev = parseFloat(q.y);
      const change = prev > 0 ? parseFloat(((last - prev) / prev * 100).toFixed(2)) : 0;
      return {
        code,
        name: q.n,
        market: channel === 'tse' ? 'TWSE 上市' : 'TPEx 上櫃',
        price: last > 0 ? last : null,
        change,
      };
    };
    try {
      const listed = await tryEndpoint('tse');
      if (listed) return listed;
      const otc = await tryEndpoint('otc');
      if (otc) return otc;
      return { code, error: '此台股代號在 TWSE/TPEx 都查不到，請與用戶確認代號是否正確' };
    } catch (e) {
      return { code, error: `TWSE 查詢失敗：${e.message}` };
    }
  }

  // ── 美股：1-5 位英文字母（含 . - 等市場後綴，如 BRK.A）───
  if (/^[A-Z]{1,5}([.\-][A-Z]{1,3})?$/.test(code)) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?interval=1d&range=2d`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          'Accept': 'application/json',
        },
      });
      if (!r.ok) return { code, error: `Yahoo HTTP ${r.status}` };
      const data = await r.json();
      const meta = data.chart?.result?.[0]?.meta;
      if (!meta) return { code, error: '美股代號查無資料，請與用戶確認' };
      const price = meta.regularMarketPrice ?? null;
      const prev = meta.previousClose || meta.chartPreviousClose || price;
      const change = (price && prev) ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0;
      return {
        code,
        name: meta.longName || meta.shortName || code,
        market: meta.exchangeName || meta.fullExchangeName || 'US',
        price,
        change,
      };
    } catch (e) {
      return { code, error: `Yahoo 查詢失敗：${e.message}` };
    }
  }

  return { code, error: '代號格式不認識（台股應為 4-5 位數字、美股應為 1-5 位字母）' };
}

// ── Tool 定義 ───────────────────────────────────────────
const STOCK_LOOKUP_TOOL = {
  name: 'lookup_stock',
  description:
    '查詢股票代號對應的真實公司名稱、市場、即時報價。' +
    '當用戶訊息包含 4 位數字代號（台股，如 2330、9958）或英文字母代號（美股，如 AAPL、NVDA），' +
    '你必須呼叫此工具確認，絕對不可憑記憶推測公司名稱。' +
    '若工具回傳 error，請告訴用戶你查不到該代號，不要猜。',
  input_schema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: '股票代號。台股範例："2330"、"9958"、"00878"；美股範例："AAPL"、"NVDA"、"BRK.B"。',
      },
    },
    required: ['code'],
  },
};

// ── Claude chat with tool_use loop ──────────────────────
async function chatWithTools({ messages, marketContext, anthropicKey }) {
  const ctxStr = marketContext
    ? `\n\n【當前市場快照】\n${Object.entries(marketContext).map(([k, v]) => `${k}: ${v}`).join('\n')}`
    : '';

  const system =
    '你是速懶報 Quicknews AI 助理 🦥⚡，專精台股與美股分析。' +
    '用繁體中文簡潔回答，100 字以內。善用 emoji。回答時請參考即時市場數據。\n\n' +
    '【代號查詢規則】當用戶訊息提到任何股票代號（4 位數字 = 台股；英文字母 = 美股），' +
    '你必須呼叫 lookup_stock 工具確認對應公司，不要憑記憶猜測。' +
    '若工具回傳 error，告訴用戶「這個代號我查不到，請確認」而不是亂答。' +
    ctxStr;

  // 對話訊息以陣列形式累積（含 assistant tool_use 跟 user tool_result）
  const conv = messages.slice(-10).map((m) => ({ ...m }));
  const MAX_ROUNDS = 4;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system,
        tools: [STOCK_LOOKUP_TOOL],
        messages: conv,
      }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`Claude API ${r.status}: ${errText.slice(0, 200)}`);
    }
    const data = await r.json();
    const blocks = data.content || [];

    const toolUses = blocks.filter((b) => b.type === 'tool_use');

    // 沒有 tool_use → 完成，回傳文字
    if (toolUses.length === 0) {
      const text = blocks.find((b) => b.type === 'text')?.text || '';
      return text || '抱歉，請稍後再試。';
    }

    // 有 tool_use → 把整個 assistant content 塞回 conv
    conv.push({ role: 'assistant', content: blocks });

    // 並行執行所有 tool calls
    const toolResults = await Promise.all(
      toolUses.map(async (tu) => {
        let result;
        if (tu.name === 'lookup_stock') {
          result = await lookupStock(tu.input?.code);
        } else {
          result = { error: `Unknown tool: ${tu.name}` };
        }
        return {
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        };
      })
    );

    conv.push({ role: 'user', content: toolResults });
  }

  // 超過最大輪數仍沒完成（罕見）
  return '抱歉，查詢花太久時間，請稍後再試。';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── POST: Claude AI 聊天 ──────────────────────────────
  if (req.method === 'POST') {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ reply: 'AI 未設定' });

    try {
      const { mode, messages, headlines, count } = req.body || {};

      // 模式一：聊天（含 lookup_stock tool）
      if (mode === 'chat' && messages) {
        const reply = await chatWithTools({
          messages,
          marketContext: req.body?.marketContext,
          anthropicKey,
        });
        return res.status(200).json({ reply });
      }

      // 模式二：新聞 AI 解讀（舊版相容，現已由 cron 處理）
      if (headlines) {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1200,
            system: '你是速懶報 AI 分析師。對每則新聞用繁體中文提供一句30字以內投資解讀。只回覆JSON陣列：[{"ai":"解讀"}]，不含其他文字。',
            messages: [{ role: 'user', content: `請對以下${count || 5}則新聞提供AI解讀：\n${headlines}` }],
          }),
        });
        const data = await r.json();
        const text = data.content?.[0]?.text || '[]';
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        return res.status(200).json({ aiTexts: parsed.map((i) => i.ai || '') });
      }

      return res.status(400).json({ reply: '請提供 messages 或 headlines' });
    } catch (e) {
      console.error('AI chat error:', e.message);
      return res.status(500).json({ reply: '伺服器錯誤，請稍後再試。' });
    }
  }

  // ── GET: 從 Notion 讀取 AI 分析 ──────────────────────
  res.setHeader('Cache-Control', 'public, max-age=300');

  const notionKey = process.env.NOTION_API_KEY;
  const aiDbId    = process.env.NOTION_AI_DB_ID;

  if (!notionKey || !aiDbId) {
    return res.status(500).json({ error: 'NOTION_AI_DB_ID not configured', analyses: {} });
  }

  try {
    const typeFilter = req.query?.type;

    const filter = typeFilter
      ? { and: [
          { property: 'Active', checkbox: { equals: true } },
          { property: 'Type', select: { equals: typeFilter } },
        ]}
      : { property: 'Active', checkbox: { equals: true } };

    const r = await fetch(`${NOTION_API}/databases/${aiDbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
        page_size: 20
      })
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'Notion query failed');

    const analyses = {};
    const items = [];

    for (const page of (data.results || [])) {
      const p = page.properties;
      const item = {
        title:     p.Title?.title?.[0]?.text?.content || '',
        type:      p.Type?.select?.name || '',
        content:   p.Content?.rich_text?.[0]?.text?.content || '',
        updatedAt: p.UpdatedAt?.rich_text?.[0]?.text?.content || '',
        pinned:    p.Pinned?.checkbox || false,
      };
      items.push(item);
      if (item.type && !analyses[item.type]) {
        analyses[item.type] = {
          title: item.title,
          content: item.content,
          updatedAt: item.updatedAt,
        };
      }
    }

    return res.status(200).json({ analyses, items, count: items.length, source: 'notion' });
  } catch (e) {
    console.error('AI Notion error:', e.message);
    return res.status(500).json({ error: e.message, analyses: {} });
  }
}
