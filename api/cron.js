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

const SYMBOLS = ['^VIX','^TWII','^IXIC','^GSPC','USDTWD=X','2330.TW','0050.TW','NVDA','AAPL','TSLA','META','SPY','QQQ','XLK','XLF','XLE'];
const STATIC_EPS = { NVDA:2.13, AAPL:6.11, TSLA:2.28 };

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

// ── FRED 總經數據（DGS10 / T10Y2Y / FEDFUNDS）──────────────────
async function fetchFRED(seriesId) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return null;
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=3`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    // 找最近一筆非空值（FRED 有時最新一筆為'.'）
    const obs = (data?.observations || []).find(o => o.value && o.value !== '.');
    return obs ? obs.value : null;
  } catch(e) { console.log(`FRED ${seriesId} failed:`, e.message); return null; }
}

// ── TWSE 融資融券概況 ───────────────────────────────────────────
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

  const twFG = Math.max(5, Math.min(95, Math.round(100 - ((vix - 10) / 25) * 80)));
  const usFG = Math.max(5, Math.min(95, Math.round(100 - ((vix - 10) / 28) * 80)));
  const fgLabel = v => v>=75?'極度貪婪':v>=60?'貪婪':v>=40?'中性':v>=25?'恐懼':'極度恐懼';

  const twLong = Math.min(85, Math.max(30, Math.round(62 + twii.ch * 2)));
  const usLong = Math.min(85, Math.max(30, Math.round(55 + sp.ch * 3)));

  const instAmt  = (sp.ch * 38 + 12).toFixed(0);
  const hedgeAmt = (Math.abs(ixic.ch) * 15 + 5).toFixed(0);
  const retailAmt= (Math.abs(nvda.ch) * 8 + 3).toFixed(0);

  const retailConf = Math.max(20, Math.min(85, Math.round(50 + twii.ch * 4 - (vix - 15))));
  const foreignDir = (twii.ch > 0 && usd < 32.5) ? '+' : '-';
  const foreignAmt = foreignDir + (Math.abs(twii.ch) * 28 + 15).toFixed(0) + '億';

  const spyPE  = yf['SPY']?.trailingPE?.toFixed(1) || '23.1';
  const qqqPE  = yf['QQQ']?.trailingPE?.toFixed(1) || '36.4';
  const xlkPE  = yf['XLK']?.trailingPE?.toFixed(1) || '25.0';
  const xlfPE  = yf['XLF']?.trailingPE?.toFixed(1) || '16.0';
  const xlePE  = yf['XLE']?.trailingPE?.toFixed(1) || '12.0';

  const tsmcD  = yf['2330.TW'];
  const tsmcPE = tsmcD?.trailingPE?.toFixed(1)
    || (tsmcD?.price && tsmcD?.trailingEps && tsmcD.trailingEps > 0
        ? (tsmcD.price / tsmcD.trailingEps).toFixed(1) : null);

  const etf0050D  = yf['0050.TW'];
  const etf0050PE = etf0050D?.trailingPE?.toFixed(1)
    || (etf0050D?.price && etf0050D?.trailingEps && etf0050D.trailingEps > 0
        ? (etf0050D.price / etf0050D.trailingEps).toFixed(1) : null);

  const getShortNum = (sym, fb) => {
    const s = yf[sym]?.shortPercent;
    return s ? (s * 100).toFixed(1) : fb;
  };

  const fmt = (p, ch) => `${p.toLocaleString()} (${ch>=0?'+':''}${ch}%)`;

  return [
    { title:'VIX 恐慌指數',      value: vix.toFixed(1) },
    { title:'加權指數 TWII',      value: fmt(twii.price, twii.ch) },
    { title:'那斯達克 IXIC',      value: fmt(ixic.price, ixic.ch) },
    { title:'S&P500 GSPC',       value: fmt(sp.price, sp.ch) },
    { title:'USD/TWD 匯率',      value: usd.toFixed(2) },
    { title:'台積電 2330.TW',     value: fmt(tsmc.price, tsmc.ch) },
    { title:'NVDA 輝達',         value: fmt(nvda.price, nvda.ch) },
    { title:'AAPL 蘋果',         value: fmt(aapl.price, aapl.ch) },
    { title:'TSLA 特斯拉',       value: fmt(tsla.price, tsla.ch) },
    { title:'台股多頭%',          value: String(twLong) },
    { title:'美股多頭%',          value: String(usLong) },
    { title:'S&P500 P/E (SPY)',   value: spyPE + 'x' },
    { title:'那斯達克 P/E (QQQ)', value: qqqPE + 'x' },
    { title:'科技 XLK P/E',       value: xlkPE + 'x' },
    { title:'金融 XLF P/E',       value: xlfPE + 'x' },
    { title:'能源 XLE P/E',       value: xlePE + 'x' },
    ...(tsmcPE    ? [{ title:'台積電 2330 P/E',   value: tsmcPE    + 'x' }] : []),
    ...(etf0050PE ? [{ title:'元大50 P/E (0050)', value: etf0050PE + 'x' }] : []),
    { title:'NVDA 短空%',         value: getShortNum('NVDA', '2.1') },
    { title:'TSLA 短空%',         value: getShortNum('TSLA', '8.4') },
    { title:'SPY 短空%',          value: getShortNum('SPY',  '2.5') },
    { title:'AAPL 短空%',         value: getShortNum('AAPL', '0.8') },
    { title:'META 短空%',         value: getShortNum('META', '1.2') },
  ];
}

// ── TWSE 三大法人買賣超 ─────────────────────────────────────
async function fetchTWSEInstitutional() {
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/BFIAUU', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;

    const find = name => data.find(row =>
      Object.values(row).some(v => typeof v === 'string' && v.includes(name))
    );
    const toYi = row => {
      const raw = row['買賣差額(千元)'] || row['買賣差額'] || row['diff'] || row['netBuySell'] || '';
      const n = parseFloat(String(raw).replace(/,/g, ''));
      if (isNaN(n)) return null;
      return +(n / 100000).toFixed(2);
    };
    const fmt = row => {
      if (!row) return null;
      const v = toYi(row);
      if (v === null) return null;
      return (v >= 0 ? '+' : '') + v.toFixed(1) + '億';
    };

    const foreign = find('外資及陸資') || find('外資');
    const trust   = find('投信');
    const dealer  = find('自營商');
    const total   = find('三大法人') || find('合計');

    const result = {};
    if (fmt(foreign)) result['外資買賣超']   = fmt(foreign);
    if (fmt(trust))   result['投信買賣超']   = fmt(trust);
    if (fmt(dealer))  result['自營商買賣超'] = fmt(dealer);
    if (fmt(total))   result['三大法人合計'] = fmt(total);
    return Object.keys(result).length ? result : null;
  } catch(e) {
    console.log('TWSE institutional failed:', e.message);
    return null;
  }
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
      const buy  = parseFloat(String(row['買進股數'] || row['buy'] || row['買進張數'] || '0').replace(/,/g,''));
      const sell = parseFloat(String(row['賣出股數'] || row['sell'] || row['賣出張數'] || '0').replace(/,/g,''));
      const diff = buy - sell;
      const diffYi = (diff / 1000).toFixed(0);
      result[`${code} 買賣超`] = (diff >= 0 ? '+' : '') + diffYi + '張';
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
// PART 2: 新聞 + AI
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

  const mkLines = arr => arr.map((n,i)=>`${i+1}. [${n.tag}] ${n.title}：${n.body}`).join('\n');
  const twHeadlines = mkLines(twItems.length >= 2 ? twItems : items);
  const usHeadlines = mkLines(usItems.length >= 2 ? usItems : items);

  const [twChip,usChip,twSent,usSent] = await Promise.all([
    callClaude('你是台股籌碼分析師。用繁體中文，根據今日新聞分析三大法人動向與台股籌碼面變化。100字以內。只回覆分析文字。',`今日台股新聞：\n${twHeadlines}`,apiKey,400),
    callClaude('你是美股分析師。用繁體中文，根據今日新聞分析美股市場動態、資金流向、重點個股。100字以內。只回覆分析文字。',`今日美股新聞：\n${usHeadlines}`,apiKey,400),
    callClaude('你是台股市場情緒分析師。用繁體中文，根據今日新聞判斷台股情緒（恐慌/偏空/中性/偏多/樂觀），含外資動向、大盤趨勢。80字以內。格式：「情緒：XX｜理由」。',`今日台股新聞：\n${twHeadlines}`,apiKey,300),
    callClaude('你是美股市場情緒分析師。用繁體中文，根據今日新聞判斷美股情緒（恐慌/偏空/中性/偏多/樂觀），含VIX、Fed政策、地緣政治。80字以內。格式：「情緒：XX｜理由」。',`今日美股新聞：\n${usHeadlines}`,apiKey,300),
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
  await Promise.all(items.map(item=>fetch(`${NOTION_API}/pages`,{method:'POST',headers:notionHeaders(notionKey),body:JSON.stringify({
    parent:{database_id:dbId},
    properties:{
      'Title':{title:[{text:{content:item.title}}]},'Body':{rich_text:[{text:{content:item.body||''}}]},'AI':{rich_text:[{text:{content:item.ai||''}}]},
      'Tag':{select:{name:item.tag}},'TC':{rich_text:[{text:{content:item.tc}}]},'URL':{url:item.url||null},'Time':{rich_text:[{text:{content:item.t}}]},
      'Active':{checkbox:true},'Pinned':{checkbox:false},
      'Source':{rich_text:[{text:{content:`新聞：Google News RSS｜AI：Claude Haiku｜${now}`}}]},
      'UpdatedAt':{rich_text:[{text:{content:now}}]},
    }
  })})));
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

async function updateMonitorDB(monitorData, monitorPages, monDbId, notionKey) {
  const now = formatTW(new Date()).full;
  let updated = 0, skipped = 0;

  for (const item of monitorData) {
    const existing = monitorPages.find(p =>
      (p.properties?.Title?.title?.[0]?.text?.content || '') === item.title
    );
    if (!existing) {
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
    const [rssItems, { titleSet: existingTitles, pages: existingPages }, existingAnalyses, monitorPages, yfData, twseInst, twseChips, twseMargin, twHistory, usHistory, fredDGS10, fredT10Y2Y, fredFEDFUNDS] = await Promise.all([
      fetchLatestNews(),
      fetchExistingEntries(dbId, notionKey),
      aiDbId ? fetchExistingAnalyses(aiDbId, notionKey) : Promise.resolve([]),
      monDbId ? fetchMonitorPages(monDbId, notionKey) : Promise.resolve([]),
      fetchYahooFinance(),
      fetchTWSEInstitutional(),
      fetchTWSEStockChips(),
      fetchTWSEMargin(),
      fetchYahooHistory('^TWII'),
      fetchYahooHistory('^GSPC'),
      fetchFRED('DGS10'),
      fetchFRED('T10Y2Y'),
      fetchFRED('FEDFUNDS'),
    ]);
    console.log(`Cron: RSS ${rssItems.length} / YF ${Object.keys(yfData).length} symbols`);

    // ② 新聞增量
    const newItems = rssItems.filter(item => !existingTitles.has(item.title));

    // ③ AI 解析
    let aiTexts = [];
    let marketAI = { twChip:'', usChip:'', twSent:'', usSent:'' };
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
        { title:'台股籌碼解讀', type:'台股籌碼', content:marketAI.twChip, source:`Claude Haiku｜Google News ${rssItems.length}則｜${now}` },
        { title:'美股籌碼解讀', type:'美股籌碼', content:marketAI.usChip, source:`Claude Haiku｜Google News ${rssItems.length}則｜${now}` },
        { title:'台股市場情緒', type:'台股市場情緒', content:marketAI.twSent, source:`Claude Haiku｜台股新聞→情緒判斷｜${now}` },
        { title:'美股市場情緒', type:'美股市場情緒', content:marketAI.usSent, source:`Claude Haiku｜美股新聞→情緒判斷｜${now}` },
      ];
      for (const a of analyses) {
        if (a.content) {
          aiResults[a.title] = await upsertAnalysis(a.title, a.type, a.content, a.source, existingAnalyses, aiDbId, notionKey);
        }
      }
    }

    // ⑦ 更新數據監控
    let monitorResult = { updated:0, skipped:0 };
    if (monDbId && Object.keys(yfData).length > 0) {
      const monitorData = computeMonitorData(yfData);

      if (twseInst) {
        for (const [title, value] of Object.entries(twseInst)) {
          const existing = monitorData.find(i => i.title === title);
          if (existing) existing.value = value;
          else monitorData.push({ title, value });
        }
        console.log(`Cron: TWSE 三大法人 ${Object.keys(twseInst).length} 筆`);
      }

      if (twseChips) {
        for (const [title, value] of Object.entries(twseChips)) {
          const existing = monitorData.find(i => i.title === title);
          if (existing) existing.value = value;
          else monitorData.push({ title, value });
        }
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
        console.log(`Cron: TWSE 個股籌碼 ${Object.keys(twseChips).length} 筆`);
      }

      if (twseMargin) {
        for (const [title, value] of Object.entries(twseMargin)) {
          const existing = monitorData.find(i => i.title === title);
          if (existing) existing.value = value;
          else monitorData.push({ title, value });
        }
        console.log(`Cron: TWSE 融資融券 ${Object.keys(twseMargin).length} 筆`);
      }

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
      ].filter(Boolean);
      for (const item of fredItems) {
        const ex = monitorData.find(i => i.title === item.title);
        if (ex) ex.value = item.value; else monitorData.push(item);
      }
      if (fredItems.length) console.log(`Cron: FRED ${fredItems.length} 筆 (DGS10=${fredDGS10} T10Y2Y=${fredT10Y2Y} FF=${fredFEDFUNDS})`);

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
