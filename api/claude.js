const MAX_PROMPT_LENGTH = 4000;
const RATE_LIMIT_MAX_REQUESTS = 8;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Owner mode skips the public limit but still gets a generous cap, so a
// runaway loop or a leaked key can't rack up unbounded API cost.
const OWNER_RATE_LIMIT_MAX_REQUESTS = 100;
const OWNER_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Best-effort in-memory limiter: Vercel reuses warm instances for most
// consecutive requests, so this throttles real traffic, but each cold
// start gets its own counter, so it isn't a hard guarantee under heavy
// concurrent load from many instances at once.
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ error: 'prompt is too long' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    const owner = isOwnerRequest(req);
    const rateLimitKey = (owner ? 'owner:' : 'public:') + getClientIp(req);
    const maxRequests = owner ? OWNER_RATE_LIMIT_MAX_REQUESTS : RATE_LIMIT_MAX_REQUESTS;
    const windowMs = owner ? OWNER_RATE_LIMIT_WINDOW_MS : RATE_LIMIT_WINDOW_MS;
    const { allowed, retryAfterMs } = checkRateLimit(rateLimitKey, maxRequests, windowMs);
    if (!allowed) {
      const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
      return res.status(429).json({ error: `利用制限に達しました。${minutes}分後にもう一度お試しください。` });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey.trim(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    const text = data.content.map((b) => b.text || '').join('');
    return res.status(200).json({ text });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
