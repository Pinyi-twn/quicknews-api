// api/cron.js — 定時排程：抓新聞 + AI分析 → 增量寫入 Notion
// Vercel Cron 每天執行4次（台灣時間 06:30 / 14:00 / 17:10 / 21:45）
//
// 寫入兩個 Notion 資料庫：
//   NOTION_DB_ID    → 速懶報新聞（新聞 + 每則 AI 解讀）
//   NOTION_AI_DB_ID → 速懶報 AI 分析（市場情緒、台股籌碼、美股籌碼）
//
// 增量更新邏輯：
//   - 用標題比對，只新增新新聞
//   - 自動偵測手動編輯，不覆蓋
//   - Pinned 項目永不封存

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function notionHeaders(key) {
  return {
    'Authorization': `Bearer ${key}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

// ── 台灣時間格式 ────────────────────────────────────────
function formatTW(date) {
  const tw = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const y = tw.getUTCFullYear();
  const M = String(tw.getUTCMonth() + 1).padStart(2, '0');
  const d = String(tw.getUTCDate()).padStart(2, '0');
  const h = String(tw.getUTCHours()).padStart(2, '0');
  const m = String(tw.getUTCMinutes()).padStart(2, '0');
  return { date: `${y}.${M}.${d}`, full: `${y}.${M}.${d} ${h}:${m}` };
}

// ── 抓 Google News RSS ──────────────────────────────────
async function fetchLatestNews() {
  const RSS_URL = 'https://news.google.com/rss/search?q=%E5%8F%B0%E7%A9%8D%E9%9B%BB+OR+%E5%8F%B0%E8%82%A1+OR+%E8%81%AF%E7%99%BC%E7%A7%91+OR+%E7%BE%8E%E8%82%A1+OR+Fed&hl=zh-TW&gl=TW&ceid=TW:zh-Hant';
  const r = await fetch(RSS_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const xml = await r.text();

  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < 8) {
    const b = m[1];
    const clean = s => (s || '')
      .replace(/<!\\[CDATA\\[(.*?)\\]\\]>/gs, '$1')
      .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;.*?&gt;/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();

    const title = clean((b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || b.match(/<title>(.*?)<\/title>/))?.[1] || '')
      .replace(/ - [^-]+$/, '').trim();
    const desc = clean((b.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || b.match(/<description>([\s\S]*?)<\/description>/))?.[1] || '').slice(0, 120);
    const link = (b.match(/<link>(.*?)<\/link>/))?.[1]?.trim() || '';
    const pub = (b.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim() || '';

    if (!title || title.length < 5) continue;

    const d = pub ? new Date(pub) : new Date();
    const t = isNaN(d) ? formatTW(new Date()).date : formatTW(d).date;

    let tag = '財經', tc = 'b-macro';
    if (/台積電|半導體|晶片|CoWoS|輝達|NVDA|AI/i.test(title))    { tag = '半導體'; tc = 'b-semi'; }
    else if (/Fed|聯準會|利率|通膨|降息|升息|美元/i.test(title))   { tag = '總經';   tc = 'b-macro'; }
    else if (/法說|財報|EPS|獲利|營收/i.test(title))               { tag = '財報';   tc = 'b-report'; }
    else if (/美股|S&P|那斯達克|TSLA|AAPL|Meta/i.test(title))     { tag = '美股';   tc = 'b-us'; }

    items.push({ title, body: desc, tag, tc, url: link, t, pubDate: pub });
  }
  return items;
}

// ── Claude API 通用呼叫 ─────────────────────────────────
async function callClaude(system, userMsg, apiKey, maxTokens = 1200) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMsg }]
    })
  });
  const data = await r.json();
  return data.content?.[0]?.text || '';
}

// ── 新聞 AI 解讀（每則一句）─────────────────────────────
async function runNewsAI(items, apiKey) {
  if (!items.length) return [];
  const headlines = items.map((n, i) =>
    `${i + 1}. [${n.tag}] ${n.title}：${n.body}`
  ).join('\n');

  const text = await callClaude(
    '你是速懶報 AI 分析師。對每則新聞用繁體中文提供一句30字以內投資解讀。只回覆JSON陣列：[{"ai":"解讀"}]，不含其他文字。',
    `請對以下${items.length}則新聞提供AI解讀：\n${headlines}`,
    apiKey
  );
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  return parsed.map(i => i.ai || '');
}

// ── 市場分析 AI（台股籌碼、美股籌碼、市場情緒）──────────
async function runMarketAI(items, apiKey) {
  const headlines = items.map((n, i) =>
    `${i + 1}. [${n.tag}] ${n.title}：${n.body}`
  ).join('\n');

  const [twChip, usChip, sentiment] = await Promise.all([
    // 台股籌碼
    callClaude(
      '你是台股籌碼分析師。用繁體中文，根據今日新聞分析三大法人（外資、投信、自營商）動向與台股籌碼面變化。100字以內，重點列出買賣超方向、重點標的、對盤勢的影響。只回覆分析文字，不含標題。',
      `今日台股相關新聞：\n${headlines}`,
      apiKey, 400
    ),
    // 美股籌碼
    callClaude(
      '你是美股分析師。用繁體中文，根據今日新聞分析美股市場動態，包含主要指數表現、資金流向、重點個股（如台積電ADR）、影響台股的關鍵因素。100字以內。只回覆分析文字，不含標題。',
      `今日美股相關新聞：\n${headlines}`,
      apiKey, 400
    ),
    // 市場情緒
    callClaude(
      '你是市場情緒分析師。用繁體中文，根據今日新聞綜合判斷當前市場情緒（恐慌/偏空/中性/偏多/樂觀），並簡述理由。80字以內。格式：「情緒：XX｜理由」。只回覆分析文字，不含標題。',
      `今日財經新聞：\n${headlines}`,
      apiKey, 300
    ),
  ]);

  return { twChip, usChip, sentiment };
}

// ── Notion：讀取現有新聞 ────────────────────────────────
async function fetchExistingEntries(dbId, notionKey) {
  const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
    method: 'POST',
    headers: notionHeaders(notionKey),
    body: JSON.stringify({
      filter: { property: 'Active', checkbox: { equals: true } },
      page_size: 100
    })
  });
  const data = await r.json();
  const pages = data.results || [];
  const titleSet = new Set();
  for (const page of pages) {
    const title = page.properties?.Title?.title?.[0]?.text?.content || '';
    if (title) titleSet.add(title);
  }
  return { titleSet, pages };
}

// ── Notion：讀取現有 AI 分析 ────────────────────────────
async function fetchExistingAnalyses(aiDbId, notionKey) {
  const r = await fetch(`${NOTION_API}/databases/${aiDbId}/query`, {
    method: 'POST',
    headers: notionHeaders(notionKey),
    body: JSON.stringify({
      filter: { property: 'Active', checkbox: { equals: true } },
      page_size: 100
    })
  });
  const data = await r.json();
  return data.results || [];
}

// ── 判斷是否手動編輯過 ──────────────────────────────────
function isManuallyEdited(page) {
  const lastEdited = new Date(page.last_edited_time);
  const updatedAtStr = page.properties?.UpdatedAt?.rich_text?.[0]?.text?.content || '';
  if (!updatedAtStr) return true;
  // UpdatedAt 格式是 yyyy.mm.dd HH:MM，需解析
  const parts = updatedAtStr.match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})/);
  if (!parts) return true;
  // 轉成 UTC（UpdatedAt 記錄的是台灣時間）
  const cronTime = new Date(Date.UTC(
    parseInt(parts[1]), parseInt(parts[2]) - 1, parseInt(parts[3]),
    parseInt(parts[4]) - 8, parseInt(parts[5])
  ));
  if (isNaN(cronTime)) return true;
  return (lastEdited - cronTime) > 2 * 60 * 1000;
}

// ── 封存過時新聞 ────────────────────────────────────────
async function archiveStaleEntries(pages, freshTitleSet, notionKey) {
  let archived = 0;
  const kept = { pinned: 0, fresh: 0, edited: 0 };

  for (const page of pages) {
    const title  = page.properties?.Title?.title?.[0]?.text?.content || '';
    const pinned = page.properties?.Pinned?.checkbox === true;

    if (pinned)                     { kept.pinned++; continue; }
    if (freshTitleSet.has(title))   { kept.fresh++;  continue; }
    if (isManuallyEdited(page))     { kept.edited++; continue; }

    await fetch(`${NOTION_API}/pages/${page.id}`, {
      method: 'PATCH',
      headers: notionHeaders(notionKey),
      body: JSON.stringify({ archived: true })
    });
    archived++;
  }
  return { archived, kept };
}

// ── 寫入新聞到 Notion ───────────────────────────────────
async function writeNewNews(items, dbId, notionKey) {
  const now = formatTW(new Date()).full;
  await Promise.all(items.map(item =>
    fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers: notionHeaders(notionKey),
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties: {
          'Title':     { title: [{ text: { content: item.title } }] },
          'Body':      { rich_text: [{ text: { content: item.body || '' } }] },
          'AI':        { rich_text: [{ text: { content: item.ai || '' } }] },
          'Tag':       { select: { name: item.tag } },
          'TC':        { rich_text: [{ text: { content: item.tc } }] },
          'URL':       { url: item.url || null },
          'Time':      { rich_text: [{ text: { content: item.t } }] },
          'Active':    { checkbox: true },
          'Pinned':    { checkbox: false },
          'UpdatedAt': { rich_text: [{ text: { content: now } }] },
        }
      })
    })
  ));
}

// ── 寫入／更新 AI 分析到 Notion ─────────────────────────
// 策略：找到同 Title 的現有項目 → 更新（除非手動編輯過）→ 找不到就新建
async function upsertAnalysis(title, type, content, existingPages, aiDbId, notionKey) {
  const now = formatTW(new Date()).full;

  // 找現有的同名項目
  const existing = existingPages.find(p =>
    (p.properties?.Title?.title?.[0]?.text?.content || '') === title
  );

  if (existing) {
    const pinned = existing.properties?.Pinned?.checkbox === true;
    if (pinned || isManuallyEdited(existing)) {
      return 'skipped'; // 手動編輯過或釘選 → 不覆蓋
    }
    // 更新現有項目
    await fetch(`${NOTION_API}/pages/${existing.id}`, {
      method: 'PATCH',
      headers: notionHeaders(notionKey),
      body: JSON.stringify({
        properties: {
          'Content':   { rich_text: [{ text: { content } }] },
          'UpdatedAt': { rich_text: [{ text: { content: now } }] },
        }
      })
    });
    return 'updated';
  } else {
    // 新建
    await fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers: notionHeaders(notionKey),
      body: JSON.stringify({
        parent: { database_id: aiDbId },
        properties: {
          'Title':     { title: [{ text: { content: title } }] },
          'Type':      { select: { name: type } },
          'Content':   { rich_text: [{ text: { content } }] },
          'Active':    { checkbox: true },
          'Pinned':    { checkbox: false },
          'UpdatedAt': { rich_text: [{ text: { content: now } }] },
        }
      })
    });
    return 'created';
  }
}

// ── Handler ─────────────────────────────────────────────
export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    if (authHeader) return res.status(401).json({ error: 'Unauthorized' });
  }

  const notionKey    = process.env.NOTION_API_KEY;
  const dbId         = process.env.NOTION_DB_ID;
  const aiDbId       = process.env.NOTION_AI_DB_ID;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!notionKey || !dbId) {
    return res.status(500).json({ error: 'NOTION_API_KEY or NOTION_DB_ID not set' });
  }

  try {
    // ① 同時抓 RSS + 讀取兩個 Notion 資料庫
    console.log('Cron: 開始...');
    const [rssItems, { titleSet: existingTitles, pages: existingPages }, existingAnalyses] = await Promise.all([
      fetchLatestNews(),
      fetchExistingEntries(dbId, notionKey),
      aiDbId ? fetchExistingAnalyses(aiDbId, notionKey) : Promise.resolve([]),
    ]);
    console.log(`Cron: RSS ${rssItems.length} / 新聞 ${existingPages.length} / AI分析 ${existingAnalyses.length}`);

    // ② 過濾新項目
    const newItems = rssItems.filter(item => !existingTitles.has(item.title));
    console.log(`Cron: 新新聞 ${newItems.length}（跳過 ${rssItems.length - newItems.length}）`);

    // ③ AI 解析（新聞解讀 + 市場分析，同時跑）
    let aiTexts = [];
    let marketAI = { twChip: '', usChip: '', sentiment: '' };

    if (anthropicKey) {
      const tasks = [];

      if (newItems.length > 0) {
        tasks.push(runNewsAI(newItems, anthropicKey).then(r => { aiTexts = r; }));
      }

      if (aiDbId && rssItems.length > 0) {
        tasks.push(runMarketAI(rssItems, anthropicKey).then(r => { marketAI = r; }));
      }

      try {
        await Promise.all(tasks);
        console.log(`Cron: 新聞AI ${aiTexts.length} / 市場分析完成`);
      } catch (e) {
        console.error('Cron: AI 失敗', e.message);
      }
    }

    const enriched = newItems.map((item, i) => ({ ...item, ai: aiTexts[i] || '' }));

    // ④ 封存過時新聞
    const freshTitleSet = new Set(rssItems.map(i => i.title));
    const { archived: archivedCount, kept: keptDetail } = await archiveStaleEntries(existingPages, freshTitleSet, notionKey);
    console.log(`Cron: 封存 ${archivedCount} / 保留：釘選${keptDetail.pinned} RSS${keptDetail.fresh} 編輯${keptDetail.edited}`);

    // ⑤ 寫入新新聞
    if (enriched.length > 0) {
      await writeNewNews(enriched, dbId, notionKey);
      console.log(`Cron: 新增新聞 ${enriched.length}`);
    }

    // ⑥ 寫入 AI 分析到第二個資料庫
    const aiResults = {};
    if (aiDbId) {
      const analyses = [
        { title: '台股籌碼解讀', type: '台股籌碼', content: marketAI.twChip },
        { title: '美股籌碼解讀', type: '美股籌碼', content: marketAI.usChip },
        { title: '市場情緒',     type: '市場情緒', content: marketAI.sentiment },
      ];

      for (const a of analyses) {
        if (a.content) {
          const result = await upsertAnalysis(a.title, a.type, a.content, existingAnalyses, aiDbId, notionKey);
          aiResults[a.title] = result;
          console.log(`Cron: AI分析 [${a.title}] → ${result}`);
        }
      }
    }

    return res.status(200).json({
      success: true,
      rss: rssItems.length,
      newCount: enriched.length,
      aiCount: aiTexts.length,
      skipped: rssItems.length - newItems.length,
      archived: archivedCount,
      kept: keptDetail,
      aiAnalyses: aiResults,
      updatedAt: formatTW(new Date()).full,
    });
  } catch (e) {
    console.error('Cron error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
