// api/quote.js — 股價 proxy（Vercel server 端，無 CORS 限制）
// 呼叫方式：/api/quote?symbols=2330.TW,NVDA,^TWII,^GSPC,^IXIC,^VIX,USDTWD=X

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });

  const symbolList = symbols.split(',').map(s => s.trim()).filter(Boolean);
  const result = {};

  await Promise.all(symbolList.map(async (symbol) => {
    try {
      // 台股用 TWSE mis API（更穩定）
      if (symbol.endsWith('.TW')) {
        const code = symbol.replace('.TW', '');
        const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${code}.tw&json=1&delay=0`;
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const data = await r.json();
        const q = data.msgArray?.[0];
        if (q) {
          const price = parseFloat(q.z !== '-' ? q.z : q.y);
          const prev  = parseFloat(q.y);
          if (price > 0) {
            result[symbol] = {
              price,
              change: prev > 0 ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0,
              name: q.n || code,
            };
          }
        }
        return;
      }

      // 美股 / 指數 用 Yahoo Finance v8
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          'Accept': 'application/json',
        }
      });
      const data = await r.json();
      const meta = data.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        const price = meta.regularMarketPrice;
        const prev  = meta.previousClose || meta.chartPreviousClose || price;
        result[symbol] = {
          price,
          change: parseFloat(((price - prev) / prev * 100).toFixed(2)),
        };
      }
    } catch (e) {
      // 該 symbol 失敗，跳過
    }
  }));

  return res.status(200).json({
    data: result,
    updatedAt: new Date().toISOString(),
    count: Object.keys(result).length,
  });
}
