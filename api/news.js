// api/news.js — 新聞 proxy（Vercel server 端，無 CORS 限制）
// 呼叫方式：/api/news

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const RSS_URL = 'https://news.google.com/rss/search?q=%E5%8F%B0%E7%A9%8D%E9%9B%BB+OR+%E5%8F%B0%E8%82%A1+OR+%E8%81%AF%E7%99%BC%E7%A7%91+OR+%E7%BE%8E%E8%82%A1+OR+Fed&hl=zh-TW&gl=TW&ceid=TW:zh-Hant';

  try {
    const r = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) throw new Error(`RSS fetch failed: ${r.status}`);
    const xml = await r.text();

    // 解析 RSS XML
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null && items.length < 8) {
      const block = m[1];
      const title   = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)   || block.match(/<title>(.*?)<\/title>/))?.[1]?.replace(/ - [^-]+$/, '').trim() || '';
      const link    = (block.match(/<link>(.*?)<\/link>/))?.[1]?.trim() || '';
      const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim() || '';
      const desc    = (block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || block.match(/<description>(.*?)<\/description>/))?.[1]?.replace(/<[^>]+>/g,'').slice(0,120).trim() || '';

      if (!title) continue;

      // 自動分類
      let tag = '財經', tc = 'b-macro';
      if (/台積電|半導體|晶片|CoWoS|輝達|NVDA|AI/i.test(title))       { tag = '半導體'; tc = 'b-semi'; }
      else if (/Fed|聯準會|利率|通膨|降息|升息|美元/i.test(title))      { tag = '總經';   tc = 'b-macro'; }
      else if (/法說|財報|EPS|獲利|營收/i.test(title))                  { tag = '財報';   tc = 'b-report'; }
      else if (/美股|S&P|那斯達克|TSLA|AAPL|Meta/i.test(title))        { tag = '美股';   tc = 'b-us'; }

      const pub = pubDate ? new Date(pubDate) : new Date();
      const t   = isNaN(pub) ? '' : `${String(pub.getHours()).padStart(2,'0')}:${String(pub.getMinutes()).padStart(2,'0')}`;

      items.push({ tag, tc, title, body: desc + '…', url: link, t, pubDate });
    }

    return res.status(200).json({
      items,
      updatedAt: new Date().toISOString(),
      count: items.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, items: [] });
  }
}
