// api/ai.js — Claude AI 新聞解析（Vercel server 端）
// 呼叫方式：POST /api/ai  body: { headlines: "1. [標籤] 標題：內文\n2. ...", count: 5 }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { headlines, count } = req.body || {};
  if (!headlines) return res.status(400).json({ error: 'headlines required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: '你是速懶報 Quicknews 的 AI 財經分析師。請用繁體中文，對每則新聞提供一句 30 字以內的投資解讀。只回覆 JSON 陣列，格式：[{"ai":"解讀文字"}]，不要其他文字或 markdown。',
        messages: [{ role: 'user', content: `請對以下 ${count || 5} 則新聞各提供一句 AI 解讀：\n${headlines}` }]
      })
    });

    if (!response.ok) throw new Error(`Claude ${response.status}`);
    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';
    const parsed = JSON.parse(text.replace(/```json|```/g,'').trim());
    return res.status(200).json({ aiTexts: parsed.map(i => i.ai || ''), count: parsed.length });
  } catch(e) {
    return res.status(500).json({ error: e.message, aiTexts: [] });
  }
}
