const MAX_GUCHI_LENGTH = 500;
const MAX_NAME_LENGTH = 40;
const MAX_TEMPLATE_LENGTH = 1000;
const MIN_CHARACTERS = 2;
const MAX_CHARACTERS = 3;

const PANEL_RATE_LIMIT_MAX_REQUESTS = 1;
const PANEL_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 day
// Owner mode skips the public limit but still gets a generous cap, so a
// runaway loop or a leaked key can't rack up unbounded API cost.
const OWNER_PANEL_RATE_LIMIT_MAX_REQUESTS = 20;
const OWNER_PANEL_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 1 day

// Best-effort in-memory limiter, same caveat as api/claude.js: accurate per
// warm Vercel instance, not a hard global guarantee under heavy concurrent
// cold starts. Deliberately separate store from the per-hour convert limit -
// this one is a much stricter, independent cap on the expensive multi-call
// panel feature.
const rateLimitStore = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  const record = rateLimitStore.get(key) || { count: 0, windowStart: now };

  if (now - record.windowStart > windowMs) {
    record.count = 0;
    record.windowStart = now;
  }

  if (record.count >= maxRequests) {
    return { allowed: false, retryAfterMs: windowMs - (now - record.windowStart) };
  }

  record.count += 1;
  rateLimitStore.set(key, record);
  return { allowed: true };
}

function isOwnerRequest(req) {
  const ownerKey = process.env.OWNER_BYPASS_KEY;
  if (!ownerKey) return false;
  const provided = req.headers['x-owner-key'];
  return Boolean(provided) && provided === ownerKey;
}

async function callClaude(apiKey, prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey.trim(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content.map((b) => b.text || '').join('');
}

function buildPrompt(guchi, character, previousTurns) {
  let prompt = `あなたは「${character.name}」として振る舞います。【キャラ設定】${character.template}【ルール】会話調で直接話しかけてください。40から80文字程度。`;

  if (previousTurns.length > 0) {
    prompt += '他のキャラの発言も踏まえて、掛け合いのように反応してください。';
  } else {
    prompt += 'この会話の最初の発言者です。';
  }

  prompt += `【愚痴】「${guchi}」`;

  if (previousTurns.length > 0) {
    prompt += '【これまでの会話】\n' + previousTurns.map((t) => `${t.name}: ${t.text}`).join('\n');
  }

  prompt += '返答してください。';
  return prompt;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { guchi, characters } = req.body;

    if (!guchi) {
      return res.status(400).json({ error: 'guchi is required' });
    }
    if (guchi.length > MAX_GUCHI_LENGTH) {
      return res.status(400).json({ error: 'guchi is too long' });
    }
    if (!Array.isArray(characters) || characters.length < MIN_CHARACTERS || characters.length > MAX_CHARACTERS) {
      return res.status(400).json({ error: `characters must be ${MIN_CHARACTERS}-${MAX_CHARACTERS} items` });
    }
    for (const c of characters) {
      if (!c || typeof c.name !== 'string' || typeof c.template !== 'string' || !c.name.trim() || !c.template.trim()) {
        return res.status(400).json({ error: 'invalid character data' });
      }
      if (c.name.length > MAX_NAME_LENGTH || c.template.length > MAX_TEMPLATE_LENGTH) {
        return res.status(400).json({ error: 'character data too long' });
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    const owner = isOwnerRequest(req);
    const rateLimitKey = (owner ? 'owner:' : 'public:') + getClientIp(req);
    const maxRequests = owner ? OWNER_PANEL_RATE_LIMIT_MAX_REQUESTS : PANEL_RATE_LIMIT_MAX_REQUESTS;
    const windowMs = owner ? OWNER_PANEL_RATE_LIMIT_WINDOW_MS : PANEL_RATE_LIMIT_WINDOW_MS;
    const { allowed, retryAfterMs } = checkRateLimit(rateLimitKey, maxRequests, windowMs);
    if (!allowed) {
      const hours = Math.max(1, Math.ceil(retryAfterMs / 3600000));
      return res.status(429).json({ error: `会議モードの利用上限に達しました。あと約${hours}時間後にお試しください。` });
    }

    const turns = [];
    for (const character of characters) {
      const prompt = buildPrompt(guchi, character, turns);
      const text = await callClaude(apiKey, prompt);
      turns.push({ name: character.name, emoji: character.emoji || '', text });
    }

    return res.status(200).json({ turns });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
