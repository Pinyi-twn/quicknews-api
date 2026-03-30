// api/ai.js — 雙模式 API
//   GET  → 從 Notion 讀取 AI 分析（市場情緒、台股籌碼、美股籌碼）
//   POST → Claude AI 聊天（速懶報 AI 助理）
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

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

      // 模式一：聊天
      if (mode === 'chat' && messages) {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            system: '你是速懶報 Quicknews AI 助理 🦥⚡，專精台股與美股分析。用繁體中文簡潔回答，100字以內。善用 emoji。',
            messages: messages.slice(-10),
          })
        });
        const data = await r.json();
        const reply = data.content?.[0]?.text || '抱歉，請稍後再試。';
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
            messages: [{ role: 'user', content: `請對以下${count||5}則新聞提供AI解讀：\n${headlines}` }]
          })
        });
        const data = await r.json();
        const text = data.content?.[0]?.text || '[]';
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        return res.status(200).json({ aiTexts: parsed.map(i => i.ai || '') });
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
      // 結果已按 last_edited_time 降冪排序，只保留最新一筆（first-seen-wins）
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
