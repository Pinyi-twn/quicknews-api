// api/price-update.js — 輕量股價更新（僅抓 Yahoo Finance → 寫 Notion Monitor）
// 用於盤中高頻 Vercel Cron，不執行 AI/新聞/TWSE，執行時間 < 5 秒

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

const PRICE_SYMBOLS = [
  '^VIX','^TWII','^IXIC','^GSPC','USDTWD=X',
  '2330.TW','2454.TW','2317.TW','2382.TW','2303.TW','2881.TW',
  'NVDA','AAPL','TSLA',
];

const SYMBOL_TO_TITLE = {
  '^VIX':      'VIX 恐慌指數',
  '^TWII':     '加權指數 TWII',
  '^IXIC':     '那斯達克 IXIC',
  '^GSPC':     'S&P500 GSPC',
  'USDTWD=X':  'USD/TWD 匯率',
  '2330.TW':   '台積電 2330.TW',
  '2454.TW':   '聯發科 2454.TW',
  '2317.TW':   '鴻海 2317.TW',
  '2382.TW':   '廣達 2382.TW',
  '2303.TW':   '聯電 2303.TW',
  '2881.TW':   '富邦金 2881.TW',
  'NVDA':      'NVDA 輝達',
  'AAPL':      'AAPL 蘋果',
  'TSLA':      'TSLA 特斯拉',
};

function notionHeaders(key) {
  return { 'Authorization': `Bearer ${key}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' };
}

function fmt(price, ch) {
  if (!price || price === 0) return null;
  return `${price.toLocaleString()} (${ch >= 0 ? '+' : ''}${ch}%)`;
}

async function fetchPrices() {
  const results = {};
  await Promise.all(PRICE_SYMBOLS.map(async sym => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`${YF_BASE}${encodeURIComponent(sym)}?interval=1d&range=2d`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      });
      clearTimeout(t);
      if (!r.ok) return;
      const data = await r.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) return;
      const price = meta.regularMarketPrice;
      const prev  = meta.chartPreviousClose || meta.previousClose || price;
      const ch    = +((price - prev) / prev * 100).toFixed(2);
      results[sym] = { price, ch };
    } catch(e) { /* skip */ }
  }));
  return results;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    if (authHeader) return res.status(401).json({ error: 'Unauthorized' });
  }

  const notionKey = process.env.NOTION_API_KEY;
  const monDbId   = process.env.NOTION_MONITOR_DB_ID;
  if (!notionKey || !monDbId) {
    return res.status(200).json({ skipped: true, reason: 'no notion config' });
  }

  try {
    const [prices, pagesRes] = await Promise.all([
      fetchPrices(),
      fetch(`${NOTION_API}/databases/${monDbId}/query`, {
        method: 'POST',
        headers: notionHeaders(notionKey),
        body: JSON.stringify({ page_size: 100 }),
      }),
    ]);

    const pagesData = await pagesRes.json();
    const pages = pagesData.results || [];
    const pageMap = {};
    for (const p of pages) {
      const title = p.properties?.Title?.title?.[0]?.text?.content || '';
      if (title) pageMap[title] = p.id;
    }

    const now = new Date(Date.now() + 8 * 3600000);
    const nowStr = `${now.getUTCFullYear()}.${String(now.getUTCMonth()+1).padStart(2,'0')}.${String(now.getUTCDate()).padStart(2,'0')} ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`;

    let updated = 0;
    await Promise.all(Object.entries(prices).map(async ([sym, d]) => {
      const title = SYMBOL_TO_TITLE[sym];
      if (!title) return;
      const value = (sym === 'USDTWD=X' || sym === '^VIX')
        ? d.price.toFixed(sym === 'USDTWD=X' ? 2 : 1)
        : fmt(d.price, d.ch);
      if (!value) return;

      const props = {
        'Value':     { rich_text: [{ text: { content: value } }] },
        'UpdatedAt': { rich_text: [{ text: { content: nowStr } }] },
      };

      if (pageMap[title]) {
        await fetch(`${NOTION_API}/pages/${pageMap[title]}`, {
          method: 'PATCH', headers: notionHeaders(notionKey),
          body: JSON.stringify({ properties: props }),
        });
      } else {
        await fetch(`${NOTION_API}/pages`, {
          method: 'POST', headers: notionHeaders(notionKey),
          body: JSON.stringify({
            parent: { database_id: monDbId },
            properties: { 'Title': { title: [{ text: { content: title } }] }, ...props },
          }),
        });
      }
      updated++;
    }));

    return res.status(200).json({ success: true, symbols: Object.keys(prices).length, updated, updatedAt: nowStr });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
