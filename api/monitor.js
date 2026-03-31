export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');

  const notionKey = process.env.NOTION_API_KEY;
  const monDbId   = process.env.NOTION_MONITOR_DB_ID;

  if (!notionKey || !monDbId) {
    return res.status(200).json({ data: {} });
  }

  try {
    const r = await fetch('https://api.notion.com/v1/databases/' + monDbId + '/query', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + notionKey,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ page_size: 100 }),
    });
    const json = await r.json();
    const data = {};
    for (const page of json.results || []) {
      const title = page.properties?.Title?.title?.[0]?.text?.content || '';
      const value = page.properties?.Value?.rich_text?.[0]?.text?.content || '';
      if (title) data[title] = value;
    }
    return res.status(200).json({ data });
  } catch (e) {
    return res.status(200).json({ data: {}, error: e.message });
  }
}
