// api/cron.js — 定時排程：新聞 + AI分析 + 數據監控 → 全部寫入 Notion
// Vercel Cron 每天執行4次（台灣時間 06:30 / 14:00 / 17:10 / 21:45）
//
// 三個 Notion 資料庫：
//   NOTION_DB_ID         → 速懶報新聞
//   NOTION_AI_DB_ID      → 速懶報 AI 分析
//   NOTION_MONITOR_DB_ID → 速懶報 數據監控

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

function notionHeaders(key) {
  return { 'Authorization': `Bearer ${key}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' };
}

function formatTW(date) {
  const tw = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const y = tw.getUTCFullYear(), M = String(tw.getUTCMonth()+1).padStart(2,'0'), d = String(tw.getUTCDate()).padStart(2,'0');
  const h = String(tw.getUTCHours()).padStart(2,'0'), m = String(tw.getUTCMinutes()).padStart(2,'0');
  return { date: `${y}.${M}.${d}`, full: `${y}.${M}.${d} ${h}:${m}` };
}

// ══════════════════════════════════════════════════════════
// PART 1: Yahoo Finance 數據抓取
// ══════════════════════════════════════════════════════════

const SYMBOLS = ['^VIX','^TWII','^IXIC','^GSPC','USDTWD=X','2330.TW','0050.TW','NVDA','AAPL','TSLA','META','SPY','QQQ','XLK','XLF','XLE','GC=F','CL=F'];

async function fetchYahooFinance() {
  const results = {};
  await Promise.all(SYMBOLS.map(async sym => {
    try {
      const r = await fetch(`${YF_BASE}${sym}?interval=1d&range=5d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const data = await r.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return;
      const price = meta.regularMarketPrice;
      const prev  = meta.chartPreviousClose || meta.previousClose;
      const ch    = prev ? ((price - prev) / prev * 100) : 0;
      results[sym] = {
        price, ch: +ch.toFixed(2), prev,
        trailingPE: meta.trailingPE || null,
        trailingEps: meta.trailingEps || meta.epsTrailingTwelveMonths || null,
        shortPercent: meta.shortPercentOfFloat || null,
      };
    } catch(e) { console.log(`YF: ${sym} 失敗`, e.message); }
  }));
  return results;
}

// ── 歷史收盤價（1年日線，用於情緒指標計算）─────────────────
async function fetchYahooHistory(symbol) {
  try {
    const r = await fetch(`${YF_BASE}${symbol}?interval=1d&range=1y`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await r.json();
    const arr = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    return (arr || []).filter(v => v != null);
  } catch(e) { console.log(`History ${symbol} 失敗:`, e.message); return []; }
}

// ── MoodRing 情緒分數（同前端算法，server 端計算後存 Notion）──
function moodRSI(closes, period=14) {
  if (closes.length < period+1) return 50;
  let avgGain=0, avgLoss=0;
  for (let i=1;i<=period;i++) { const d=closes[i]-closes[i-1]; if(d>0)avgGain+=d; else avgLoss-=d; }
  avgGain/=period; avgLoss/=period;
  for (let i=period+1;i<closes.length;i++) {
    const d=closes[i]-closes[i-1];
    avgGain=(avgGain*(period-1)+Math.max(d,0))/period;
    avgLoss=(avgLoss*(period-1)+Math.max(-d,0))/period;
  }
  return avgLoss===0?100:100-100/(1+avgGain/avgLoss);
}
function moodVsHigh(closes) {
  const max52=Math.max(...closes.slice(-252));
  return Math.max(0,Math.min(100,((closes[closes.length-1]/max52)*100-80)*5));
}
function moodMomentum(closes,period=20) {
  if (closes.length<period+1) return 50;
  const mom=((closes[closes.length-1]/closes[closes.length-1-period])-1)*100;
  return Math.max(0,Math.min(100,(mom+10)*5));
}
function computeSentiment(closes) {
  if (closes.length<30) return null;
  const rsi=moodRSI(closes), vsHigh=moodVsHigh(closes), momentum=moodMomentum(closes);
  const score=Math.round((rsi+vsHigh+momentum)/3);
  return { score, rsi:Math.round(rsi), vsHigh:Math.round(vsHigh), momentum:Math.round(momentum) };
}

// ── FRED 總經數據（DGS10 / T10Y2Y / FEDFUNDS / UNRATE / CPIAUCSL …）──
// units: 可選 'lin'（原始）或 'pc1'（年增率%），預設 'lin'
async function fetchFRED(seriesId, units = 'lin') {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return null;
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=3&units=${units}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    // 找最近一筆非空值（FRED 有時最新一筆為'.'）
    const obs = (data?.observations || []).find(o => o.value && o.value !== '.');
    return obs ? obs.value : null;
  } catch(e) { console.log(`FRED ${seriesId} failed:`, e.message); return null; }
}
async function fetchTWSEMargin() {
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;
    const row = data[0];
    const result = {};
    // 防禦性取值（欄位名因日期/版本可能不同）
    const get = (...keys) => { for (const k of keys) { if (row[k] !== undefined) return row[k]; } return null; };
    const marginBal  = get('融資餘額','融資金額','margin_balance');
    const marginRate = get('融資使用率','margin_ratio');
    const shortBal   = get('融券餘額','融券股數','short_balance');
    const shortRate  = get('融券使用率','short_ratio');
    if (marginBal)  result['融資餘額']   = String(marginBal).replace(/,/g,'');
    if (marginRate) result['融資使用率'] = String(marginRate).replace(/%/,'');
    if (shortBal)   result['融券餘額']   = String(shortBal).replace(/,/g,'');
    if (shortRate)  result['融券使用率'] = String(shortRate).replace(/%/,'');
    return Object.keys(result).length ? result : null;
  } catch(e) { console.log('TWSE margin failed:', e.message); return null; }
}

function computeMonitorData(yf) {
  const vix  = yf['^VIX']?.price || 18;
  const twii = yf['^TWII'] || { price:0, ch:0 };
  const sp   = yf['^GSPC'] || { price:0, ch:0 };
  const ixic = yf['^IXIC'] || { price:0, ch:0 };
  const usd  = yf['USDTWD=X']?.price || 32;
  const nvda = yf['NVDA'] || { price:0, ch:0 };
  const aapl = yf['AAPL'] || { price:0, ch:0 };
  const tsla = yf['TSLA'] || { price:0, ch:0 };
  const meta = yf['META'] || { price:0, ch:0 };
  const tsmc = yf['2330.TW'] || { price:0, ch:0 };

  // 恐懼貪婪指數
  const twFG = Math.max(5, Math.min(95, Math.round(100 - ((vix - 10) / 25) * 80)));
  const usFG = Math.max(5, Math.min(95, Math.round(100 - ((vix - 10) / 28) * 80)));
  const fgLabel = v => v>=75?'極度貪婪':v>=60?'貪婪':v>=40?'中性':v>=25?'恐懼':'極度恐懼';

  // 多空比
  const twLong = Math.min(85, Math.max(30, Math.round(62 + twii.ch * 2)));
  const usLong = Math.min(85, Math.max(30, Math.round(55 + sp.ch * 3)));

  // 商品報價
  const gold = yf['GC=F']?.price;
  const oil  = yf['CL=F']?.price;

  // Short Interest（只用 Yahoo Finance 回傳的真實數字，無靜態 fallback）
  const getShortNum = sym => {
    const s = yf[sym]?.shortPercent;
    return s ? (s * 100).toFixed(1) : null;
  };

  const fmt = (p, ch) => `${p.toLocaleString()} (${ch>=0?'+':''}${ch}%)`;

  const items = [
    // 指數報價
    { title:'VIX 恐慌指數',  value: vix.toFixed(1) },
    { title:'加權指數 TWII', value: fmt(twii.price, twii.ch) },
    { title:'那斯達克 IXIC', value: fmt(ixic.price, ixic.ch) },
    { title:'S&P500 GSPC',  value: fmt(sp.price, sp.ch) },
    { title:'USD/TWD 匯率', value: usd.toFixed(2) },
    { title:'台積電 2330.TW', value: fmt(tsmc.price, tsmc.ch) },
    { title:'NVDA 輝達',    value: fmt(nvda.price, nvda.ch) },
    { title:'AAPL 蘋果',    value: fmt(aapl.price, aapl.ch) },
    { title:'TSLA 特斯拉',  value: fmt(tsla.price, tsla.ch) },
    // 多空比（從 TWII/GSPC 漲跌幅推算，數字格式）
    { title:'台股多頭%', value: String(twLong) },
    { title:'美股多頭%', value: String(usLong) },
  ];

  // 商品（有值才存）
  if (gold) items.push({ title:'黃金 GC=F', value: gold.toFixed(1) });
  if (oil)  items.push({ title:'原油 CL=F', value: oil.toFixed(2) });

  // Short Interest（只用 YF 真實數值，無靜態 fallback）
  for (const sym of ['NVDA','TSLA','SPY','AAPL','META']) {
    const v = getShortNum(sym);
    if (v) items.push({ title:`${sym} 短空%`, value: v });
  }

  return items;
}

// ── TWSE 大盤成交統計（上漲/下跌家數、成交量等市場廣度）──────
// 嘗試順序：
//   1. TWSE OpenAPI MI_INDEX（大盤各指數統計，含漲跌家數）
//   2. TWSE 主網站 rwd MI_TWII（每日成交量統計，含漲跌家數）
//   3. TWSE 主網站 rwd MI_INDEX（備援）
async function fetchTWSEMarketBreadth() {
  // 方法1：TWSE OpenAPI MI_INDEX — 大盤各指數行情，含漲跌家數
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) throw new Error('empty');
    console.log('TWSE MI_INDEX[0] keys:', Object.keys(data[0]), 'row:', JSON.stringify(data[0]));
    const result = {};
    for (const row of data) {
      const allKeys = Object.keys(row);
      const getVal = (...keys) => {
        for (const k of keys) {
          // exact match first
          if (row[k] !== undefined && row[k] !== '') return String(row[k]).replace(/,/g,'');
          // partial key match
          const found = allKeys.find(ak => ak.includes(k));
          if (found && row[found] !== undefined && row[found] !== '') return String(row[found]).replace(/,/g,'');
        }
        return null;
      };
      const rising  = getVal('上漲','漲家','Risen','漲家數');
      const falling = getVal('下跌','跌家','Fallen','跌家數');
      const limitUp = getVal('漲停','LimitUp');
      const limitDn = getVal('跌停','LimitDown');
      // Only pick row that actually has breadth data (not all rows will)
      if (rising && !result['台股上漲家數'])  result['台股上漲家數'] = rising;
      if (falling && !result['台股下跌家數']) result['台股下跌家數'] = falling;
      if (limitUp && !result['台股漲停家數']) result['台股漲停家數'] = limitUp;
      if (limitDn && !result['台股跌停家數']) result['台股跌停家數'] = limitDn;
    }
    if (result['台股上漲家數'] || result['台股下跌家數']) {
      console.log('TWSE MI_INDEX breadth result:', result);
      return result;
    }
    throw new Error('no breadth fields found in MI_INDEX');
  } catch(e) { console.log('TWSE OpenAPI MI_INDEX failed:', e.message); }

  // 方法2：TWSE 主網站 MI_TWII（大盤日成交統計，有上漲/下跌家數）
  try {
    const r = await fetch('https://www.twse.com.tw/rwd/zh/afterTrading/MI_TWII?response=json', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    console.log('TWSE MI_TWII stat:', json.stat, 'fields:', json.fields, 'data[0]:', json.data?.[0]);
    // Accept both 'OK' and other non-error states; just need fields+data
    const row = json.data?.[0];
    const fields = json.fields || [];
    if (!row || !fields.length) throw new Error(`no data (stat=${json.stat})`);
    const idx = k => fields.findIndex(f => f.includes(k));
    const get = (...kws) => {
      for (const kw of kws) {
        const i = idx(kw);
        if (i >= 0 && row[i] != null && row[i] !== '') return String(row[i]).replace(/,/g, '');
      }
      return null;
    };
    const result = {};
    const rising  = get('上漲','漲家');
    const falling = get('下跌','跌家');
    const limitUp = get('漲停');
    const limitDn = get('跌停');
    const turnover = get('成交金額','成交值');
    if (rising)  result['台股上漲家數'] = rising;
    if (falling) result['台股下跌家數'] = falling;
    if (limitUp) result['台股漲停家數'] = limitUp;
    if (limitDn) result['台股跌停家數'] = limitDn;
    if (turnover) result['台股成交金額'] = turnover;
    if (result['台股上漲家數'] || result['台股下跌家數']) {
      console.log('TWSE MI_TWII result:', result);
      return result;
    }
    throw new Error('no matching fields in MI_TWII');
  } catch(e) { console.log('TWSE MI_TWII failed:', e.message); }

  return null;
}

// ── TWSE 全市場殖利率（BWIBBU_ALL → 抓加權平均殖利率）─────────
async function fetchTWSEMarketDividend() {
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;
    console.log('TWSE BWIBBU_ALL keys:', Object.keys(data[0]), 'row0:', JSON.stringify(data[0]));
    // 計算全市場殖利率加權平均（取樣前200筆可交易股票）
    const yields = data.slice(0, 200).map(row => {
      const v = parseFloat(
        row['殖利率(%)'] || row['殖利率'] || row['DividendYield'] || row['Yield'] || '0'
      );
      return isNaN(v) ? 0 : v;
    }).filter(v => v > 0);
    if (!yields.length) return null;
    const avg = (yields.reduce((a, b) => a + b, 0) / yields.length).toFixed(2);
    // 同時取台積電實際 P/E
    // Find TSMC row by stock code 2330
    const tsmcRow = data.find(row => {
      const vals = Object.values(row).map(v => String(v));
      return vals.includes('2330') || vals.some(v => v === '2330');
    }) || data.find(row =>
      Object.values(row).some(v => String(v).includes('2330'))
    );
    if (tsmcRow) console.log('TSMC row keys:', Object.keys(tsmcRow), 'values:', JSON.stringify(tsmcRow));
    // P/E field may be '本益比(倍)', '本益比', 'PERatio', 'PE', etc.
    const getPE = row => {
      if (!row) return null;
      const keys = Object.keys(row);
      const peKey = keys.find(k => k.includes('本益比') || k.includes('PE') || k === 'PERatio');
      if (peKey) return parseFloat(String(row[peKey]).replace(/,/g,'')) || null;
      return null;
    };
    const tsmcPE = getPE(tsmcRow);
    return {
      yield: avg + '%',
      tsmcPE: tsmcPE ? tsmcPE.toFixed(1) + 'x' : null,
    };
  } catch(e) { console.log('TWSE BWIBBU_ALL failed:', e.message); return null; }
}

// ── TWSE 三大法人買賣超 ─────────────────────────────────────
async function fetchTWSEInstitutional() {
  // 嘗試方法1：TWSE OpenAPI
  const r1 = await tryTWSEOpenAPI();
  if (r1) return r1;
  // 嘗試方法2：TWSE 主網站 JSON API
  return await tryTWSEMainSite();
}

async function tryTWSEOpenAPI() {
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/BFIAUU', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;
    console.log('TWSE OpenAPI[0]:', JSON.stringify(data[0]));
    return parseTWSERows(data);
  } catch(e) { console.log('TWSE OpenAPI failed:', e.message); return null; }
}

async function tryTWSEMainSite() {
  try {
    const r = await fetch('https://www.twse.com.tw/rwd/zh/fund/BFI82U?response=json&type=day', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    if (json.stat !== 'OK' || !Array.isArray(json.data) || !json.data.length) return null;
    console.log('TWSE main site fields:', json.fields, 'row0:', json.data[0]);
    // 格式：{ fields:['機構別','買進金額','賣出金額','買賣差額'], data:[['外資...',buy,sell,diff],...] }
    const fields = json.fields || [];
    const diffIdx = fields.findIndex(f => f.includes('差額') || f.includes('Diff'));
    const nameIdx = 0;
    if (diffIdx === -1) throw new Error('Diff field not found');
    const toYi = row => {
      const raw = row[diffIdx];
      const n = parseFloat(String(raw).replace(/,/g, ''));
      if (isNaN(n)) return null;
      let yi = n / 100000;
      if (Math.abs(yi) > 5000) yi = n / 100000000;
      return +yi.toFixed(2);
    };
    const fmt = row => { const v = toYi(row); return v === null ? null : (v>=0?'+':'')+v.toFixed(1)+'億'; };
    const find = (...kws) => json.data.find(row => kws.some(kw => String(row[nameIdx]).includes(kw)));
    const result = {};
    const fF = fmt(find('外資及陸資','外資')), fT = fmt(find('投信')), fD = fmt(find('自營商')), fTot = fmt(find('三大法人','合計'));
    if (fF)   result['外資買賣超']   = fF;
    if (fT)   result['投信買賣超']   = fT;
    if (fD)   result['自營商買賣超'] = fD;
    if (fTot) result['三大法人合計'] = fTot;
    console.log('TWSE main site result:', result);
    return Object.keys(result).length ? result : null;
  } catch(e) { console.log('TWSE main site failed:', e.message); return null; }
}

function parseTWSERows(data) {
  const find = (...kws) => data.find(row =>
    Object.values(row).some(v => typeof v === 'string' && kws.some(kw => v.includes(kw)))
  );
  const toYi = row => {
    if (!row) return null;
    for (const k of ['Diff','diff','買賣差額(千元)','買賣差額','netBuySell','Net','差額']) {
      if (row[k] !== undefined) {
        const n = parseFloat(String(row[k]).replace(/,/g,''));
         if (isNaN(n)) return null;
        // 自動偵測單位：若除以 100000 結果 > 5000億，代表原始值為元，改除以 1 億
        let yi = n / 100000;
        if (Math.abs(yi) > 5000) yi = n / 100000000;
        return +yi.toFixed(2);
    }
    }
    const buyRaw  = row.Buy ?? row.BuyAmt ?? row['買進金額(千元)'] ?? row['買進金額'];
    const sellRaw = row.Sell ?? row.SellAmt ?? row['賣出金額(千元)'] ?? row['賣出金額'];
    if (buyRaw != null && sellRaw != null) {
      const b = parseFloat(String(buyRaw).replace(/,/g,'')), s = parseFloat(String(sellRaw).replace(/,/g,''));
      if (!isNaN(b) && !isNaN(s)) return +((b-s)/100000).toFixed(2);
    }
    return null;
  };
  const fmt = row => { const v = toYi(row); return v===null?null:(v>=0?'+':'')+v.toFixed(1)+'億'; };
  const result = {};
  const fF = fmt(find('外資及陸資','外資','FINI')), fT = fmt(find('投信')), fD = fmt(find('自營商')), fTot = fmt(find('三大法人','合計'));
  if (fF)   result['外資買賣超']   = fF;
  if (fT)   result['投信買賣超']   = fT;
  if (fD)   result['自營商買賣超'] = fD;
  if (fTot) result['三大法人合計'] = fTot;
  console.log('TWSE OpenAPI result:', result);
  return Object.keys(result).length ? result : null;
}

// ── TWSE 個股外資買賣超 ─────────────────────────────────────
async function fetchTWSEStockChips() {
  const TW_STOCKS = ['2330','2454','2317','0050','2382','2303'];
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/TWT84U', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;

    const result = {};
    for (const code of TW_STOCKS) {
      const row = data.find(r =>
        (r['證券代號'] || r['code'] || r['stockCode'] || '') === code
      );
      if (!row) continue;
      // 買超張數 / 賣超張數（可能欄位名不同）
      const buy  = parseFloat(String(row['買進股數'] || row['buy'] || row['買進張數'] || '0').replace(/,/g,''));
      const sell = parseFloat(String(row['賣出股數'] || row['sell'] || row['賣出張數'] || '0').replace(/,/g,''));
      const diff = buy - sell;
      const diffYi = (diff / 1000).toFixed(0); // 股 → 張 → 約億...實際單位依資料
      result[`${code} 買賣超`] = (diff >= 0 ? '+' : '') + diffYi + '張';
      // 多頭% = 基礎值 + 外資方向偏移（diff > 0 表示外資淨買）
      const longBase = diff > 0 ? Math.min(80, 55 + Math.round(Math.abs(diff)/500)) : Math.max(25, 45 - Math.round(Math.abs(diff)/500));
      result[`${code} 多頭%`] = String(longBase);
    }
    return Object.keys(result).length ? result : null;
  } catch(e) {
    console.log('TWSE stock chips failed:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════
// PART 2: 新聞 + AI（與之前相同）
// ══════════════════════════════════════════════════════════

async function fetchLatestNews() {
  const RSS_URL = 'https://news.google.com/rss/search?q=%E5%8F%B0%E7%A9%8D%E9%9B%BB+OR+%E5%8F%B0%E8%82%A1+OR+%E8%81%AF%E7%99%BC%E7%A7%91+OR+%E7%BE%8E%E8%82%A1+OR+Fed&hl=zh-TW&gl=TW&ceid=TW:zh-Hant';
  const r = await fetch(RSS_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const xml = await r.text();
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < 8) {
    const b = m[1];
    const clean = s => (s||'').replace(/<!\\[CDATA\\[(.*?)\\]\\]>/gs,'$1').replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi,'').replace(/<[^>]+>/g,'').replace(/&lt;.*?&gt;/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
    const title = clean((b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)||b.match(/<title>(.*?)<\/title>/))?.[1]||'').replace(/ - [^-]+$/,'').trim();
    const desc  = clean((b.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)||b.match(/<description>([\s\S]*?)<\/description>/))?.[1]||'').slice(0,120);
    const link  = (b.match(/<link>(.*?)<\/link>/))?.[1]?.trim()||'';
    const pub   = (b.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim()||'';
    if (!title || title.length < 5) continue;
    const d = pub ? new Date(pub) : new Date();
    const t = isNaN(d) ? formatTW(new Date()).date : formatTW(d).date;
    let tag='財經', tc='b-macro';
    if (/台積電|半導體|晶片|CoWoS|輝達|NVDA|AI/i.test(title))    { tag='半導體'; tc='b-semi'; }
    else if (/Fed|聯準會|利率|通膨|降息|升息|美元/i.test(title))   { tag='總經';   tc='b-macro'; }
    else if (/法說|財報|EPS|獲利|營收/i.test(title))               { tag='財報';   tc='b-report'; }
    else if (/美股|S&P|那斯達克|TSLA|AAPL|Meta/i.test(title))     { tag='美股';   tc='b-us'; }
    items.push({ title, body:desc, tag, tc, url:link, t, pubDate:pub });
  }
  return items;
}

async function callClaude(system, userMsg, apiKey, maxTokens=1200) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:maxTokens, system, messages:[{role:'user',content:userMsg}] })
  });
  const data = await r.json();
  return data.content?.[0]?.text || '';
}

async function runNewsAI(items, apiKey) {
  if (!items.length) return [];
  const headlines = items.map((n,i)=>`${i+1}. [${n.tag}] ${n.title}：${n.body}`).join('\n');
  const text = await callClaude('你是速懶報 AI 分析師。對每則新聞用繁體中文提供一句30字以內投資解讀。只回覆JSON陣列：[{"ai":"解讀"}]，不含其他文字。', `請對以下${items.length}則新聞提供AI解讀：\n${headlines}`, apiKey);
  const parsed = JSON.parse(text.replace(/```json|```/g,'').trim());
  return parsed.map(i=>i.ai||'');
}

async function runMarketAI(items, apiKey) {
  // ── 依標籤將新聞分為台股、美股兩組，確保 AI 分析內容有所區別 ──
  const TW_PATTERN = /台積電|台股|外資|法人|投信|自營|加權|聯發科|鴻海|廣達|聯電|玉山|兆豐|台幣/i;
  const US_PATTERN = /美股|Fed|聯準會|S&P|那斯達克|NVDA|輝達|AAPL|TSLA|Meta|降息|升息|利率|通膨|美元|道瓊|標普/i;

  const twItems = items.filter(n =>
    ['半導體','財報'].includes(n.tag) ||
    (n.tag === '財經' && TW_PATTERN.test(n.title)) ||
    TW_PATTERN.test(n.title)
  );
  const usItems = items.filter(n =>
    n.tag === '美股' || n.tag === '總經' ||
    US_PATTERN.test(n.title)
  );

  // 若某側篩選後不足 2 則，fallback 全部（至少能有內容）
  const mkLines = arr => arr.map((n,i)=>`${i+1}. [${n.tag}] ${n.title}：${n.body}`).join('\n');
  const twHeadlines = mkLines(twItems.length >= 2 ? twItems : items);
  const usHeadlines = mkLines(usItems.length >= 2 ? usItems : items);

  const [twChip, usChip, twSent, usSent] = await Promise.all([
    callClaude(
      '你是台股籌碼整合分析師。用繁體中文，根據今日新聞對台股進行全面籌碼分析，涵蓋：①三大法人（外資、投信、自營商）動向 ②融資餘額與融券變化 ③整體多空比例與主力籌碼方向。150字以內。只回覆分析文字。',
      `今日台股新聞：\n${twHeadlines}`, apiKey, 500
    ),
    callClaude(
      '你是美股籌碼整合分析師。用繁體中文，根據今日新聞對美股進行全面籌碼分析，涵蓋：①機構資金流向（買超/賣超趨勢）②重要個股空頭部位變化 ③整體多空比例與市場情緒方向。150字以內。只回覆分析文字。',
      `今日美股新聞：\n${usHeadlines}`, apiKey, 500
    ),
    callClaude(
      '你是台股市場情緒分析師。用繁體中文，根據今日新聞判斷台股情緒（恐慌/偏空/中性/偏多/樂觀），含外資動向、大盤趨勢。80字以內。格式：「情緒：XX｜理由」。',
      `今日台股新聞：\n${twHeadlines}`, apiKey, 300
    ),
    callClaude(
      '你是美股市場情緒分析師。用繁體中文，根據今日新聞判斷美股情緒（恐慌/偏空/中性/偏多/樂觀），含VIX、Fed政策、地緣政治。80字以內。格式：「情緒：XX｜理由」。',
      `今日美股新聞：\n${usHeadlines}`, apiKey, 300
    ),
  ]);
  return { twChip, usChip, twSent, usSent };
}

// ══════════════════════════════════════════════════════════
// PART 3: Notion 讀寫
// ══════════════════════════════════════════════════════════

async function fetchExistingEntries(dbId, notionKey) {
  const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, { method:'POST', headers:notionHeaders(notionKey), body:JSON.stringify({ filter:{property:'Active',checkbox:{equals:true}}, page_size:100 }) });
  const data = await r.json(); const pages = data.results||[];
  const titleSet = new Set(); for (const p of pages) { const t=p.properties?.Title?.title?.[0]?.text?.content||''; if(t) titleSet.add(t); }
  return { titleSet, pages };
}

async function fetchExistingAnalyses(aiDbId, notionKey) {
  const r = await fetch(`${NOTION_API}/databases/${aiDbId}/query`, { method:'POST', headers:notionHeaders(notionKey), body:JSON.stringify({ filter:{property:'Active',checkbox:{equals:true}}, page_size:100 }) });
  const data = await r.json(); return data.results||[];
}

async function fetchMonitorPages(monDbId, notionKey) {
  const r = await fetch(`${NOTION_API}/databases/${monDbId}/query`, { method:'POST', headers:notionHeaders(notionKey), body:JSON.stringify({ page_size:100 }) });
  const data = await r.json(); return data.results||[];
}

function isManuallyEdited(page) {
  const lastEdited = new Date(page.last_edited_time);
  const s = page.properties?.UpdatedAt?.rich_text?.[0]?.text?.content||'';
  if (!s) return true;
  const parts = s.match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})/);
  if (!parts) return true;
  const cronTime = new Date(Date.UTC(parseInt(parts[1]),parseInt(parts[2])-1,parseInt(parts[3]),parseInt(parts[4])-8,parseInt(parts[5])));
  return isNaN(cronTime) || (lastEdited - cronTime) > 2*60*1000;
}

async function archiveStaleEntries(pages, freshTitleSet, notionKey) {
  let archived=0; const kept={pinned:0,fresh:0,edited:0};
  for (const page of pages) {
    const title=page.properties?.Title?.title?.[0]?.text?.content||'';
    const pinned=page.properties?.Pinned?.checkbox===true;
    if (pinned) { kept.pinned++; continue; }
    if (freshTitleSet.has(title)) { kept.fresh++; continue; }
    if (isManuallyEdited(page)) { kept.edited++; continue; }
    await fetch(`${NOTION_API}/pages/${page.id}`,{method:'PATCH',headers:notionHeaders(notionKey),body:JSON.stringify({archived:true})});
    archived++;
  }
  return { archived, kept };
}

async function writeNewNews(items, dbId, notionKey) {
  const now = formatTW(new Date()).full;
  // 由舊到新循序寫入（RSS index 0 = 最新），讓最新文章擁有最晚的 Notion created_time
  // 如此 Notion 依 created_time 降冪排序後，最新新聞自然在最上方
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    await fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers: notionHeaders(notionKey),
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties: {
          'Title':     { title:     [{ text: { content: item.title } }] },
          'Body':      { rich_text: [{ text: { content: item.body || '' } }] },
          'AI':        { rich_text: [{ text: { content: item.ai || '' } }] },
          'Tag':       { select:    { name: item.tag } },
          'TC':        { rich_text: [{ text: { content: item.tc } }] },
          'URL':       { url: item.url || null },
          'Time':      { rich_text: [{ text: { content: item.t } }] },
          'Active':    { checkbox: true },
          'Pinned':    { checkbox: false },
          'Source':    { rich_text: [{ text: { content: `新聞：Google News RSS｜AI：Claude Haiku｜${now}` } }] },
          'UpdatedAt': { rich_text: [{ text: { content: now } }] },
        }
      })
    });
  }
}

async function upsertAnalysis(title, type, content, source, existingPages, aiDbId, notionKey) {
  const now = formatTW(new Date()).full;
  const existing = existingPages.find(p=>(p.properties?.Title?.title?.[0]?.text?.content||'')===title);
  if (existing) {
    if (existing.properties?.Pinned?.checkbox===true || isManuallyEdited(existing)) return 'skipped';
    await fetch(`${NOTION_API}/pages/${existing.id}`,{method:'PATCH',headers:notionHeaders(notionKey),body:JSON.stringify({properties:{'Content':{rich_text:[{text:{content}}]},'Source':{rich_text:[{text:{content:source}}]},'UpdatedAt':{rich_text:[{text:{content:now}}]}}})});
    return 'updated';
  }
  await fetch(`${NOTION_API}/pages`,{method:'POST',headers:notionHeaders(notionKey),body:JSON.stringify({parent:{database_id:aiDbId},properties:{'Title':{title:[{text:{content:title}}]},'Type':{select:{name:type}},'Content':{rich_text:[{text:{content}}]},'Source':{rich_text:[{text:{content:source}}]},'Active':{checkbox:true},'Pinned':{checkbox:false},'UpdatedAt':{rich_text:[{text:{content:now}}]}}})});
  return 'created';
}

// ── 更新數據監控 ────────────────────────────────────────
async function updateMonitorDB(monitorData, monitorPages, monDbId, notionKey) {
  const now = formatTW(new Date()).full;
  let updated = 0, skipped = 0;

  for (const item of monitorData) {
    const existing = monitorPages.find(p =>
      (p.properties?.Title?.title?.[0]?.text?.content || '') === item.title
    );
    if (!existing) {
      // 自動建立缺少的列（新功能鍵首次執行時）
      await fetch(`${NOTION_API}/pages`, {
        method: 'POST',
        headers: notionHeaders(notionKey),
        body: JSON.stringify({
          parent: { database_id: monDbId },
          properties: {
            'Title':     { title: [{ text: { content: item.title } }] },
            'Value':     { rich_text: [{ text: { content: item.value } }] },
            'UpdatedAt': { rich_text: [{ text: { content: now } }] },
          }
        })
      });
      updated++;
      continue;
    }

    await fetch(`${NOTION_API}/pages/${existing.id}`, {
      method: 'PATCH',
      headers: notionHeaders(notionKey),
      body: JSON.stringify({
        properties: {
          'Value':     { rich_text: [{ text: { content: item.value } }] },
          'UpdatedAt': { rich_text: [{ text: { content: now } }] },
        }
      })
    });
    updated++;
  }
  return { updated, skipped };
}

// ══════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    if (authHeader) return res.status(401).json({ error: 'Unauthorized' });
  }

  const notionKey    = process.env.NOTION_API_KEY;
  const dbId         = process.env.NOTION_DB_ID;
  const aiDbId       = process.env.NOTION_AI_DB_ID;
  const monDbId      = process.env.NOTION_MONITOR_DB_ID;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!notionKey || !dbId) {
    return res.status(500).json({ error: 'NOTION_API_KEY or NOTION_DB_ID not set' });
  }

  try {
    console.log('Cron: 開始...');

    // ① 同時抓：RSS + Notion + Yahoo Finance + TWSE + 歷史價格 + FRED
    const [rssItems, { titleSet: existingTitles, pages: existingPages }, existingAnalyses, monitorPages, yfData, twseInst, twseChips, twseMargin, twseBreadth, twseDividend, twHistory, usHistory, fredDGS10, fredT10Y2Y, fredFEDFUNDS, fredUNRATE, fredCPI] = await Promise.all([
      fetchLatestNews(),
      fetchExistingEntries(dbId, notionKey),
      aiDbId ? fetchExistingAnalyses(aiDbId, notionKey) : Promise.resolve([]),
      monDbId ? fetchMonitorPages(monDbId, notionKey) : Promise.resolve([]),
      fetchYahooFinance(),
      fetchTWSEInstitutional(),
      fetchTWSEStockChips(),
      fetchTWSEMargin(),
      fetchTWSEMarketBreadth(),
      fetchTWSEMarketDividend(),
      fetchYahooHistory('^TWII'),
      fetchYahooHistory('^GSPC'),
      fetchFRED('DGS10'),
      fetchFRED('T10Y2Y'),
      fetchFRED('FEDFUNDS'),
      fetchFRED('UNRATE'),
      fetchFRED('CPIAUCSL', 'pc1'),
    ]);
    console.log(`Cron: RSS ${rssItems.length} / YF ${Object.keys(yfData).length} symbols`);

    // ② 新聞增量
    const newItems = rssItems.filter(item => !existingTitles.has(item.title));

    // ③ AI 解析
    let aiTexts = [];
    let marketAI = { twChip:'', usChip:'', twSent:'', usSent:'', twMargin:'', twLS:'' };
    if (anthropicKey) {
      const tasks = [];
      if (newItems.length > 0) tasks.push(runNewsAI(newItems, anthropicKey).then(r=>{aiTexts=r;}));
      if (aiDbId && rssItems.length > 0) tasks.push(runMarketAI(rssItems, anthropicKey).then(r=>{marketAI=r;}));
      try { await Promise.all(tasks); } catch(e) { console.error('AI失敗',e.message); }
    }
    const enriched = newItems.map((item,i) => ({...item, ai:aiTexts[i]||''}));

    // ④ 封存過時新聞
    const freshTitleSet = new Set(rssItems.map(i=>i.title));
    const { archived: archivedCount, kept: keptDetail } = await archiveStaleEntries(existingPages, freshTitleSet, notionKey);

    // ⑤ 寫入新新聞
    if (enriched.length > 0) await writeNewNews(enriched, dbId, notionKey);

    // ⑥ 寫入 AI 分析
    const aiResults = {};
    const now = formatTW(new Date()).full;
    if (aiDbId) {
      const analyses = [
        { title:'台股籌碼解讀', type:'台股籌碼', content:marketAI.twChip, source:`Claude Haiku｜Google News ${rssItems.length}則（三大法人+融資融券+多空整合）｜${now}` },
        { title:'美股籌碼解讀', type:'美股籌碼', content:marketAI.usChip, source:`Claude Haiku｜Google News ${rssItems.length}則（機構資金+空頭+多空整合）｜${now}` },
        { title:'台股市場情緒', type:'台股市場情緒', content:marketAI.twSent, source:`Claude Haiku｜台股新聞→情緒判斷｜${now}` },
        { title:'美股市場情緒', type:'美股市場情緒', content:marketAI.usSent, source:`Claude Haiku｜美股新聞→情緒判斷｜${now}` },
      ];
      for (const a of analyses) {
        if (a.content) {
          aiResults[a.title] = await upsertAnalysis(a.title, a.type, a.content, a.source, existingAnalyses, aiDbId, notionKey);
        }
      }
    }

    // ⑦ 更新數據監控（Yahoo Finance + TWSE）
    let monitorResult = { updated:0, skipped:0 };
    if (monDbId && Object.keys(yfData).length > 0) {
      const monitorData = computeMonitorData(yfData);

      // 合併 TWSE 三大法人資料
      if (twseInst) {
        for (const [title, value] of Object.entries(twseInst)) {
          const existing = monitorData.find(i => i.title === title);
          if (existing) existing.value = value;
          else monitorData.push({ title, value });
        }
        console.log(`Cron: TWSE 三大法人 ${Object.keys(twseInst).length} 筆`);
      }

      // 合併 TWSE 個股籌碼
      if (twseChips) {
        for (const [title, value] of Object.entries(twseChips)) {
          const existing = monitorData.find(i => i.title === title);
          if (existing) existing.value = value;
          else monitorData.push({ title, value });
        }
        console.log(`Cron: TWSE 個股籌碼 ${Object.keys(twseChips).length} 筆`);
      }
      // 滾動更新外資近10日買賣超（獨立於 twseChips，只需 twseInst 成功即可）
      if (twseInst?.['外資買賣超']) {
        const todayNum = parseFloat(twseInst['外資買賣超'].replace(/[^0-9.-]/g, ''));
        if (!isNaN(todayNum)) {
          const flowRow = monitorPages.find(p =>
            (p.properties?.Title?.title?.[0]?.text?.content || '') === '外資近10日買賣超'
          );
          const oldVal = flowRow?.properties?.Value?.rich_text?.[0]?.text?.content || '';
          const vals = oldVal.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
          vals.push(todayNum);
          const last10 = vals.slice(-10).join(',');
          const flowItem = monitorData.find(i => i.title === '外資近10日買賣超');
          if (flowItem) flowItem.value = last10;
          else monitorData.push({ title:'外資近10日買賣超', value: last10 });
        }
      }
      // 合併 TWSE 融資融券
      if (twseMargin) {
        for (const [title, value] of Object.entries(twseMargin)) {
          const existing = monitorData.find(i => i.title === title);
          if (existing) existing.value = value;
          else monitorData.push({ title, value });
        }
        console.log(`Cron: TWSE 融資融券 ${Object.keys(twseMargin).length} 筆`);
      }

      // 合併 TWSE 大盤市場廣度（上漲/下跌家數、成交金額）
      if (twseBreadth) {
        for (const [title, value] of Object.entries(twseBreadth)) {
          const existing = monitorData.find(i => i.title === title);
          if (existing) existing.value = value;
          else monitorData.push({ title, value });
        }
        console.log(`Cron: TWSE 市場廣度 ${Object.keys(twseBreadth).length} 筆`);
      }

      // 合併 TWSE 殖利率（BWIBBU_ALL）
      if (twseDividend) {
        if (twseDividend.yield) {
          const ex = monitorData.find(i => i.title === '台股平均殖利率');
          if (ex) ex.value = twseDividend.yield; else monitorData.push({ title:'台股平均殖利率', value: twseDividend.yield });
        }
        if (twseDividend.tsmcPE) {
          const ex = monitorData.find(i => i.title === '台積電 P/E');
          if (ex) ex.value = twseDividend.tsmcPE; else monitorData.push({ title:'台積電 P/E', value: twseDividend.tsmcPE });
        }
        console.log(`Cron: TWSE 殖利率=${twseDividend.yield} 台積電PE=${twseDividend.tsmcPE}`);
      }

      // 合併情緒指標（MoodRing 算法，1年日線計算）
      const twSent = computeSentiment(twHistory);
      const usSent = computeSentiment(usHistory);
      if (twSent) {
        [
          { title:'台股情緒分數', value: String(twSent.score) },
          { title:'台股RSI14',    value: String(twSent.rsi) },
          { title:'台股52週高點', value: String(twSent.vsHigh) },
          { title:'台股20日動量', value: String(twSent.momentum) },
        ].forEach(item => {
          const ex = monitorData.find(i => i.title === item.title);
          if (ex) ex.value = item.value; else monitorData.push(item);
        });
        console.log(`Cron: 台股情緒分數=${twSent.score} RSI=${twSent.rsi}`);
      }
      if (usSent) {
        [
          { title:'美股情緒分數', value: String(usSent.score) },
          { title:'美股RSI14',    value: String(usSent.rsi) },
          { title:'美股52週高點', value: String(usSent.vsHigh) },
          { title:'美股20日動量', value: String(usSent.momentum) },
        ].forEach(item => {
          const ex = monitorData.find(i => i.title === item.title);
          if (ex) ex.value = item.value; else monitorData.push(item);
        });
        console.log(`Cron: 美股情緒分數=${usSent.score} RSI=${usSent.rsi}`);
      }

      // 合併 FRED 總經數據
      const fredItems = [
        fredDGS10    ? { title:'10Y美債殖利率', value: parseFloat(fredDGS10).toFixed(2) + '%' }    : null,
        fredT10Y2Y   ? { title:'殖利率利差',    value: parseFloat(fredT10Y2Y).toFixed(2) + '%' }   : null,
        fredFEDFUNDS ? { title:'聯邦利率',      value: parseFloat(fredFEDFUNDS).toFixed(2) + '%' } : null,
        fredUNRATE   ? { title:'美國失業率',     value: parseFloat(fredUNRATE).toFixed(1) + '%' }   : null,
        fredCPI      ? { title:'美國CPI年增率',  value: parseFloat(fredCPI).toFixed(1) + '%' }      : null,
      ].filter(Boolean);
      for (const item of fredItems) {
        const ex = monitorData.find(i => i.title === item.title);
        if (ex) ex.value = item.value; else monitorData.push(item);
      }
      if (fredItems.length) console.log(`Cron: FRED ${fredItems.length} 筆 (DGS10=${fredDGS10} T10Y2Y=${fredT10Y2Y} FF=${fredFEDFUNDS} UNRATE=${fredUNRATE} CPI=${fredCPI})`);

      monitorResult = await updateMonitorDB(monitorData, monitorPages, monDbId, notionKey);
      console.log(`Cron: 數據監控更新 ${monitorResult.updated} 筆`);
    }

    return res.status(200).json({
      success: true,
      rss: rssItems.length,
      newCount: enriched.length,
      aiCount: aiTexts.length,
      archived: archivedCount,
      kept: keptDetail,
      aiAnalyses: aiResults,
      monitor: monitorResult,
      yahooFinance: Object.keys(yfData).length,
      updatedAt: now,
    });
  } catch(e) {
    console.error('Cron error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
