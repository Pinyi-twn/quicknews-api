// api/news.js — 新聞 proxy（Vercel server 端，無 CORS 限制）

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const RSS_URL = 'https://news.google.com/rss/search?q=%E5%8F%B0%E7%A9%8D%E9%9B%BB+OR+%E5%8F%B0%E8%82%A1+OR+%E8%81%AF%E7%99%BC%E7%A7%91+OR+%E7%BE%8E%E8%82%A1+OR+Fed&hl=zh-TW&gl=TW&ceid=TW:zh-Hant';

  // 清除所有 HTML 標籤和 entities
  function cleanHtml(str) {
    return (str || '')
      .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
      .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '')  // 移除 <a> 連結及內容
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;.*?&gt;/g, '')                  // 移除 &lt;a href...&gt;
      .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
      .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
      .replace(/\s+/g,' ').trim();
  }

  function tagNews(title) {
    if (/台積電|半導體|晶片|CoWoS|輝達|NVDA|AI伺服器/i.test(title)) return {tag:'半導體', tc:'b-semi'};
    if (/Fed|聯準會|利率|通膨|降息|升息|美元/i.test(title))           return {tag:'總經',   tc:'b-macro'};
    if (/法說|財報|EPS|獲利|營收/i.test(title))                        return {tag:'財報',   tc:'b-report'};
    if (/美股|S&P|那斯達克|TSLA|AAPL|Meta|Google/i.test(title))       return {tag:'美股',   tc:'b-us'};
    return {tag:'財經', tc:'b-macro'};
  }

  try {
    const r = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    if (!r.ok) throw new Error(`RSS ${r.status}`);
    const xml = await r.text();

    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null && items.length < 8) {
      const block = m[1];

      // 標題：去掉 " - 來源" 後綴
      const rawTitle = cleanHtml(
        (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s) ||
         block.match(/<title>(.*?)<\/title>/s))?.[1] || ''
      );
      const title = rawTitle.replace(/ - [^-]+$/, '').trim();
      if (!title || title.length < 4) continue;

      // 內文：取 description 但去掉所有 HTML
      const rawDesc = cleanHtml(
        (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
         block.match(/<description>([\s\S]*?)<\/description>/))?.[1] || ''
      );
      const body = rawDesc.slice(0, 120) + (rawDesc.length > 120 ? '…' : '');

      // 連結
      const link = (block.match(/<link>(.*?)<\/link>/))?.[1]?.trim() || '';

      // 時間
      const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim() || '';
      const pub = pubDate ? new Date(pubDate) : new Date();
      const t = isNaN(pub.getTime()) ? '' :
        `${String(pub.getHours()).padStart(2,'0')}:${String(pub.getMinutes()).padStart(2,'0')}`;

      const {tag, tc} = tagNews(title);
      items.push({ tag, tc, title, body, url: link, t, pubDate, ai: '' });
    }

    return res.status(200).json({
      items,
      updatedAt: new Date().toISOString(),
      count: items.length,
    });
  } catch(e) {
    return res.status(500).json({ error: e.message, items: [] });
  }
}
