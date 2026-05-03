// api/yahoo-proxy.js — Yahoo Finance v8 chart API proxy
//
// 為什麼存在：
//   Android Capacitor WebView 的預設 scheme 是 https://localhost，
//   嚴格按 web standard 執行 CORS。Yahoo Finance v8 chart API 不回
//   Access-Control-Allow-Origin header，所以前端 fetch 直接會被 WebView
//   擋下。iOS WKWebView 用 capacitor:// scheme 跳過 CORS 檢查，沒這問題。
//
// 解法：Vercel server 端代為 fetch Yahoo（server-to-server，無 CORS 限制），
// 然後加上 CORS header 回傳給 client。
//
// 用法：/api/yahoo-proxy?symbol=^GSPC&interval=1d&range=1y
// 回傳：原樣轉發 Yahoo 的 JSON（chart.result[0] 結構，前端既有解析邏輯不用改）

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // 短期快取（5 分鐘）：歷史日線資料變化頻率低，避免重複打 Yahoo 被 rate limit
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const symbol = String(req.query?.symbol || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  // 白名單參數，避免 SSRF / 注入
  const interval = ['1d', '1wk', '1mo', '5m', '15m', '60m'].includes(req.query?.interval)
    ? req.query.interval
    : '1d';
  const range = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max', 'ytd'].includes(req.query?.range)
    ? req.query.range
    : '1y';

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });
    if (!r.ok) {
      return res.status(r.status).json({ error: `Yahoo HTTP ${r.status}`, symbol });
    }
    const data = await r.json();
    return res.status(200).json(data);
  } catch (e) {
    console.error('yahoo-proxy error:', symbol, e.message);
    return res.status(502).json({ error: e.message, symbol });
  }
}
