// api/cron.js — 定時排程：抓新聞 → 比對 → AI解析新項目 → 增量寫入 Notion
// Vercel Cron 每天執行4次（台灣時間 06:30 / 14:00 / 17:10 / 21:45）
//
// 增量更新邏輯：
//   1. 抓 RSS 新聞 + 讀取 Notion 現有資料
//   2. 用標題比對，只新增「真正新的」新聞
//   3. 只對新項目跑 AI 解析（省 API 額度）
//   4. 封存過時項目（不在最新 RSS 且未被釘選）
//   5. Pinned=true 的項目永不被自動封存（保護手動編輯）

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function notionHeaders(key) {
  return {
    'Authorization': `Bearer ${key}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
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
    const t = isNaN(d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    let tag = '財經', tc = 'b-macro';
    if (/台積電|半導體|晶片|CoWoS|輝達|NVDA|AI/i.test(title))    { tag = '半導體'; tc = 'b-semi'; }
    else if (/Fed|聯準會|利率|通膨|降息|升息|美元/i.test(title))   { tag = '總經';   tc = 'b-macro'; }
    else if (/法說|財報|EPS|獲利|營收/i.test(title))               { tag = '財報';   tc = 'b-report'; }
    else if (/美股|S&P|那斯達克|TSLA|AAPL|Meta/i.test(title))     { tag = '美股';   tc = 'b-us'; }

    items.push({ title, body: desc, tag, tc, url: link, t, pubDate: pub });
  }
  return items;
}

// ── Claude AI 批次解析（只處理新項目）────────────────────
async function runAIAnalysis(items, apiKey) {
  if (!items.length) return [];

  const headlines = items.slice(0, 6).map((n, i) =>
    `${i + 1}. [${n.tag}] ${n.title}：${n.body}`
  ).join('\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: '你是速懶報 AI 分析師。對每則新聞用繁體中文提供一句30字以內投資解讀。只回覆JSON陣列：[{"ai":"解讀"}]，不含其他文字。',
      messages: [{ role: 'user', content: `請對以下${items.slice(0, 6).length}則新聞提供AI解讀：\n${headlines}` }]
    })
  });
  const data = await r.json();
  const text = data.content?.[0]?.text || '[]';
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  return parsed.map(i => i.ai || '');
}

// ── 讀取 Notion 現有資料 ────────────────────────────────
// 回傳 { titleSet, pages }
//   titleSet: 現有標題的 Set（用於比對重複）
//   pages:    完整頁面資料（用於封存判斷）
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

// ── 封存過時項目 ────────────────────────────────────────
// 條件：標題不在最新 RSS 中 且 Pinned ≠ true
async function archiveStaleEntries(pages, freshTitleSet, notionKey) {
  let archived = 0;

  for (const page of pages) {
    const title  = page.properties?.Title?.title?.[0]?.text?.content || '';
    const pinned = page.properties?.Pinned?.checkbox === true;

    // 釘選的永遠保留；標題還在最新 RSS 中的也保留
    if (pinned || freshTitleSet.has(title)) continue;

    await fetch(`${NOTION_API}/pages/${page.id}`, {
      method: 'PATCH',
      headers: notionHeaders(notionKey),
      body: JSON.stringify({ archived: true })
    });
    archived++;
  }

  return archived;
}

// ── 寫入新項目到 Notion ─────────────────────────────────
async function writeNewToNotion(items, dbId, notionKey) {
  const now = new Date().toISOString();
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

// ── Handler ─────────────────────────────────────────────
export default async function handler(req, res) {
  const authHeader  = req.headers['authorization'];
  const cronSecret  = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    if (authHeader) return res.status(401).json({ error: 'Unauthorized' });
  }

  const notionKey    = process.env.NOTION_API_KEY;
  const dbId         = process.env.NOTION_DB_ID;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!notionKey || !dbId) {
    return res.status(500).json({ error: 'NOTION_API_KEY or NOTION_DB_ID not set' });
  }

  try {
    // ① 同時抓 RSS 和 Notion 現有資料
    console.log('Cron: 開始抓新聞 + 讀取 Notion...');
    const [rssItems, { titleSet: existingTitles, pages: existingPages }] = await Promise.all([
      fetchLatestNews(),
      fetchExistingEntries(dbId, notionKey),
    ]);
    console.log(`Cron: RSS ${rssItems.length} 則 / Notion 現有 ${existingPages.length} 則`);

    // ② 比對：過濾出真正的新項目
    const newItems = rssItems.filter(item => !existingTitles.has(item.title));
    console.log(`Cron: 新項目 ${newItems.length} 則（跳過重複 ${rssItems.length - newItems.length} 則）`);

    // ③ 只對新項目跑 AI 解析
    let aiTexts = [];
    if (anthropicKey && newItems.length > 0) {
      try {
        aiTexts = await runAIAnalysis(newItems, anthropicKey);
        console.log(`Cron: AI 解析完成 ${aiTexts.length} 則`);
      } catch (e) {
        console.error('Cron: AI 失敗', e.message);
      }
    }

    const enriched = newItems.map((item, i) => ({ ...item, ai: aiTexts[i] || '' }));

    // ④ 封存過時項目（不在最新 RSS 且未釘選）
    const freshTitleSet = new Set(rssItems.map(i => i.title));
    const archivedCount = await archiveStaleEntries(existingPages, freshTitleSet, notionKey);
    console.log(`Cron: 封存過時項目 ${archivedCount} 則`);

    // ⑤ 寫入新項目
    if (enriched.length > 0) {
      await writeNewToNotion(enriched, dbId, notionKey);
      console.log(`Cron: 新增 Notion ${enriched.length} 則`);
    } else {
      console.log('Cron: 無新項目需寫入');
    }

    return res.status(200).json({
      success: true,
      newCount: enriched.length,
      aiCount: aiTexts.length,
      skipped: rssItems.length - newItems.length,
      archived: archivedCount,
      kept: existingPages.length - archivedCount,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Cron error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
