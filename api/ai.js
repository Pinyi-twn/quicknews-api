// api/ai.js
export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key missing', aiTexts: [] });

  const headlines = req.body?.headlines;
  const count = req.body?.count || 5;
  if (!headlines) return res.status(400).json({ error: 'headlines required', aiTexts: [] });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: '你是速懶報 AI 分析師。對每則新聞用繁體中文提供一句30字以內投資解讀。只回覆JSON陣列：[{"ai":"解讀"}]，不含其他文字。',
        messages: [{ role: 'user', content: `請對以下${count}則新聞提供AI解讀：\n${headlines}` }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('Claude error:', r.status, data?.error?.message);
      return res.status(500).json({ error: `Claude ${r.status}`, detail: data?.error?.message, aiTexts: [] });
    }

    const text = data.content?.[0]?.text || '[]';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return res.status(200).json({ aiTexts: parsed.map(i => i.ai || ''), count: parsed.length });
  } catch (e) {
    console.error('Error:', e.message);
    return res.status(500).json({ error: e.message, aiTexts: [] });
  }
}
