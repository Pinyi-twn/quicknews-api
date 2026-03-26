// api/ai.js — 從 Notion 讀取 AI 分析（市場情緒、台股籌碼、美股籌碼等）
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const notionKey = process.env.NOTION_API_KEY;
  const aiDbId    = process.env.NOTION_AI_DB_ID;

  if (!notionKey || !aiDbId) {
    return res.status(500).json({ error: 'NOTION_AI_DB_ID not configured', analyses: {} });
  }

  try {
    // 可選：?type=台股籌碼 只取特定類型
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

    // 整理成 { type: { title, content, updatedAt } } 的格式
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

      // 以 type 為 key，方便前端直接取用
      if (item.type) {
        analyses[item.type] = {
          title: item.title,
          content: item.content,
          updatedAt: item.updatedAt,
        };
      }
    }

    return res.status(200).json({
      analyses,
      items,
      count: items.length,
      source: 'notion',
    });
  } catch (e) {
    console.error('AI error:', e.message);
    return res.status(500).json({ error: e.message, analyses: {} });
  }
}
