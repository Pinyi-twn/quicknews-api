// api/news.js — 從 Notion 讀取新聞（含用戶手動編輯）
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300'); // 瀏覽器快取 5 分鐘
  if (req.method === 'OPTIONS') return res.status(200).end();

  const notionKey = process.env.NOTION_API_KEY;
  const dbId      = process.env.NOTION_DB_ID;

  if (!notionKey || !dbId) {
    return res.status(500).json({ error: 'Notion not configured', items: [] });
  }

  try {
    // 讀 Notion：只取 Active=true 的，按建立時間排序
    const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: { property: 'Active', checkbox: { equals: true } },
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        page_size: 8
      })
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'Notion query failed');

    const items = (data.results || []).map(page => {
      const p = page.properties;
      return {
        title: p.Title?.title?.[0]?.text?.content || '',
        body:  p.Body?.rich_text?.[0]?.text?.content || '',
        ai:    p.AI?.rich_text?.[0]?.text?.content || '',
        tag:   p.Tag?.select?.name || '財經',
        tc:    p.TC?.rich_text?.[0]?.text?.content || 'b-macro',
        url:   p.URL?.url || '',
        t:     p.Time?.rich_text?.[0]?.text?.content || '',
      };
    }).filter(n => n.title.length > 2);

    return res.status(200).json({
      items,
      count: items.length,
      source: 'notion',
      updatedAt: new Date().toISOString(),
    });
  } catch(e) {
    console.error('News error:', e.message);
    return res.status(500).json({ error: e.message, items: [] });
  }
}
