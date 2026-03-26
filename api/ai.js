// api/ai.js — AI 新聞解析 + AI 問答（統一入口）
export const config = {
  api: { bodyParser: { sizeLimit: '2mb' } }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key missing', aiTexts: [] });

  const body = req.body || {};
  const mode = body.mode || 'news'; // 'news' 或 'chat'

  try {
    let requestBody;

    if (mode === 'chat') {
      // AI 問答模式
      const { messages, system } = body;
      if (!messages || !messages.length) {
        return res.status(400).json({ error: 'messages required' });
      }
      requestBody = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: system || '你是「速懶報 Quicknews」AI 助理，吉祥物是樹懶拿閃電🦥⚡。專精台股與美股，特別擅長市場情緒分析、三大法人籌碼解讀、融資融券分析。用繁體中文回答，語氣親切專業。重要數字用**粗體**。最後提醒：本資訊僅供參考，不構成投資建議。',
        messages: messages
      };
    } else {
      // 新聞解析模式
      const { headlines, count } = body;
      if (!headlines) return res.status(400).json({ error: 'headlines required', aiTexts: [] });
      requestBody = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: '你是速懶報 AI 分析師。對每則新聞用繁體中文提供一句30字以內投資解讀。只回覆JSON陣列：[{"ai":"解讀"}]，不含其他文字。',
        messages: [{ role: 'user', content: `請對以下${count || 5}則新聞提供AI解讀：\n${headlines}` }]
      };
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody)
    });

    const data = await r.json();

    if (!r.ok) {
      console.error('Claude error:', r.status, data?.error?.message);
      return res.status(500).json({
        error: `Claude ${r.status}`,
        detail: data?.error?.message,
        aiTexts: [],
        reply: '抱歉，AI 服務暫時無法使用，請稍後再試。'
      });
    }

    const text = data.content?.[0]?.text || '';

    if (mode === 'chat') {
      return res.status(200).json({ reply: text });
    } else {
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      return res.status(200).json({ aiTexts: parsed.map(i => i.ai || ''), count: parsed.length });
    }
  } catch (e) {
    console.error('Error:', e.message);
    return res.status(500).json({
      error: e.message,
      aiTexts: [],
      reply: '抱歉，發生錯誤，請稍後再試。'
    });
  }
}
