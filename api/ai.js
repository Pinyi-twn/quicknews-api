// api/ai.js — 雙模式 API
//   GET  → 從 Notion 讀取 AI 分析（市場情緒、台股籌碼、美股籌碼）
//   POST → Claude AI 聊天（速懶報 AI 助理），帶 lookup_stock + web_search 工具
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// ── 閒聊早退（不打 Claude API、直接回罐頭，省 API 費）──
const SMALL_TALK_PATTERNS = [
  { test: /^(?:你好|哈囉|嗨|hi|hello)[\s!！。.?？]*$/i,
    reply: '你好 🦥⚡\n我是速懶報 AI 助理，專精台股與美股分析。\n試試輸入股票代碼（例：2330、AAPL）或代碼 + 問題吧。' },
  { test: /^(?:謝謝|感謝|多謝|thanks|thx|ty)[\s!！。.?？]*$/i,
    reply: '不客氣 🙌\n隨時歡迎再來問。' },
  { test: /^(?:測試|test)[\s!！。.?？]*$/i,
    reply: '測試成功 ✓\nAI 助理運作正常。' },
];
function detectSmallTalk(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  const last = messages[messages.length - 1];
  if (last?.role !== 'user') return null;
  const text = String(last.content || '').trim();
  if (text.length > 12) return null; // 太長不算閒聊
  for (const p of SMALL_TALK_PATTERNS) if (p.test.test(text)) return p.reply;
  return null;
}

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
    '查詢股票代號對應的真實公司名稱、市場、即時報價（用以確認代號正確）。' +
    '當用戶訊息包含 4-5 位數字代號（台股，如 2330、9958、00878）或英文字母代號（美股，如 AAPL、NVDA），' +
    '你必須呼叫此工具確認，絕對不可憑記憶推測公司名稱。' +
    '若工具回傳 error 代表代號可能是近期新掛牌（如 00981A 等 ETF），此時改用 web_search 補充。' +
    '回傳的 price/change 僅供你判斷代號是否查到，**禁止在最終回應裡寫出具體價格、漲跌幅、百分比**。',
  input_schema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: '股票代號（已正規化，例："2330"、"9958"、"00878"、"AAPL"、"NVDA"、"BRK.B"）',
      },
    },
    required: ['code'],
  },
};

// Anthropic server-side web search（calls happen inside Anthropic infra，本機不需處理 tool_result）
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 1,
  user_location: {
    type: 'approximate',
    city: 'Taipei',
    country: 'TW',
    timezone: 'Asia/Taipei',
  },
};

// ── System prompt（提取成常數，搭配 prompt caching 共用同一份）──
const SYSTEM_PROMPT = `你是精通台灣與全球市場的資深財經分析師與文字精煉大師。你的任務是針對用戶查詢的個股，提供一目了然、高資訊密度的數據解析與操作邏輯。

# Core Rule: 簡潔至上
- 拒絕任何客套話、前言或結語（例如不說「好的，為您分析...」、「以上提供您參考」）。
- 禁止任何工具使用的過程描述或交接語句（例：「辨識失敗，補充搜尋資訊...」「以下根據 web 搜尋結果整理...」「我先查一下...」「資料如下:」）。工具呼叫是內部過程、用戶不該看到，直接給最終分析。
- 一律使用繁體中文，多用「數據與專門術語」，少用形容詞。
- 簡潔、只講重點；每段不堆砌冗詞、不重複論點。**不設定硬性字數上限**：完整性優先於壓縮，禁止為了縮短篇幅而砍段落或截尾。
- 禁止提及個股「當前股價」「今日漲跌幅」「近期百分比變動」等即時數據（這些資訊在 App 其他畫面已呈現）。
- 回應必須完整：5 段（總結 + 基本面 + 籌碼面 + 技術面 + 操作建議）+ 免責聲明都要出齊，每段都要有結尾標點。

## 回覆格式（嚴格遵守）
1. 第一行：一句話總結目前該股的狀態與關鍵觀察點（30 字內）
2. 【基本面】1-2 行，只講當下最關鍵的因素（最新營收／獲利表現或重大財報利多／利空）
3. 【籌碼面】1-2 行，聚焦法人動向與融資券變化（三大法人、主力大戶或融資券的近期關鍵動向）
4. 【技術面】1-2 行，目前價位相對關鍵均線、量能狀態（均線位階、指標如 KD/MACD 狀態或 K 線型態）
5. 【操作建議】多方確認條件 + 空方風險價位，各一行
- **支撐／壓力**：支撐位 [價格] ／ 壓力位 [價格]
- **操作策略**：[例如：若站穩 XX 價位可留意分批機會 ／ 跌破 XX 價位需注意風險控制]

## 規則
- 使用繁體中文、台股慣用術語（外資、投信、季線、乖離）
- 禁止使用「建議買進／賣出」「目標價」等字眼，改用條件式描述（例：「若站穩 XX 元且量增，多方結構轉強」）
- 工具使用順序與限制：
  1. 用戶第一次提到代碼時呼叫 lookup_stock 確認公司名稱、市場類別
  2. 僅在 lookup_stock 回 error 或代碼為近期新掛牌（如 00981A 等 ETF）時，才呼叫 web_search 補充
  3. 對話中已查過的代碼，後續跟進題（如「那賣壓在哪」「進場點建議」）禁止再呼叫任何工具，直接用先前資料回答
  4. lookup_stock 回傳的 price/change 僅供你判斷代碼是否查到，禁止在最終回應裡寫出任何具體價格、漲跌幅、百分比數字
- 優先使用對話中已提供的數據（含【當前市場快照】）；僅在資料不足時才搜尋，避免不必要的搜尋
- 數據不足以做出具體判斷時，以「目前可取得的資訊不足給出明確判斷，建議待資訊充足時我再下評論給您」作為該段或該題結尾，禁止編造任何數字或結論
- 「簡潔至上」規則不適用於結尾免責聲明：結尾固定加註「以上為 AI 資訊整理，投資人應自行判斷。」`;

// ── Claude chat with tool_use loop ──────────────────────
async function chatWithTools({ messages, marketContext, anthropicKey }) {
  // marketContext 每次都不同 → 不能放進 cached system，改塞到最後一則 user message 前
  // （保持 system 完全靜態以利 prompt caching 命中率）
  const ctxStr = marketContext
    ? `【當前市場快照】\n${Object.entries(marketContext).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n`
    : '';

  const conv = messages.slice(-10).map((m) => ({ ...m }));
  if (ctxStr && conv.length > 0) {
    const lastIdx = conv.length - 1;
    if (conv[lastIdx].role === 'user' && typeof conv[lastIdx].content === 'string') {
      conv[lastIdx] = { ...conv[lastIdx], content: `${ctxStr}${conv[lastIdx].content}` };
    }
  }

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
        max_tokens: 1500, // 啟用 web_search 後中間 token 開銷大，給足空間避免最終 5 段被截斷；output 按實際 token 計費，cap 只防失控
        // Prompt caching：system 改 array form + cache_control，命中時 input 費降 90%
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [STOCK_LOOKUP_TOOL, WEB_SEARCH_TOOL],
        messages: conv,
      }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`Claude API ${r.status}: ${errText.slice(0, 200)}`);
    }
    const data = await r.json();
    const blocks = data.content || [];

    // 只處理我們自家的 tool_use（lookup_stock）；web_search 是 server-side、Anthropic 內部處理
    const toolUses = blocks.filter((b) => b.type === 'tool_use');

    // 沒有 tool_use → 完成，組合所有 text block 回傳
    // （啟用 web_search 後 content 可能包含 server_tool_use/web_search_tool_result 跟多段 text 交錯，
    //  不能再用 .find(text) 只取第一段，要全部 text 合併。）
    if (toolUses.length === 0) {
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
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

      // 模式一：聊天（含 lookup_stock + web_search 工具）
      if (mode === 'chat' && messages) {
        // 閒聊早退：你好／謝謝／測試等不打 Claude API，省費用
        const canned = detectSmallTalk(messages);
        if (canned) return res.status(200).json({ reply: canned });

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
