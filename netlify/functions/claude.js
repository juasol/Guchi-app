const { connectLambda, getStore } = require("@netlify/blobs");

const MAX_PROMPT_LENGTH = 4000;
const RATE_LIMIT_MAX_REQUESTS = 8;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function getClientIp(event) {
  return (
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["client-ip"] ||
    (event.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown"
  );
}

function isOwnerRequest(event) {
  const ownerKey = process.env.OWNER_BYPASS_KEY;
  if (!ownerKey) return false;
  const provided = event.headers["x-owner-key"];
  return Boolean(provided) && provided === ownerKey;
}

async function checkRateLimit(ip) {
  const store = getStore("guchi-rate-limit");
  const key = `ip:${ip}`;
  const now = Date.now();
  const record = (await store.get(key, { type: "json" })) || { count: 0, windowStart: now };

  if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    record.count = 0;
    record.windowStart = now;
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, retryAfterMs: RATE_LIMIT_WINDOW_MS - (now - record.windowStart) };
  }

  record.count += 1;
  await store.setJSON(key, record);
  return { allowed: true };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const { prompt } = JSON.parse(event.body || "{}");

    if (!prompt) {
      return { statusCode: 400, body: JSON.stringify({ error: "prompt is required" }) };
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return { statusCode: 400, body: JSON.stringify({ error: "prompt is too long" }) };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: "API key not configured" }) };
    }

    connectLambda(event);

    if (!isOwnerRequest(event)) {
      const { allowed, retryAfterMs } = await checkRateLimit(getClientIp(event));
      if (!allowed) {
        const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
        return {
          statusCode: 429,
          body: JSON.stringify({ error: `利用制限に達しました。${minutes}分後にもう一度お試しください。` }),
        };
      }
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey.trim(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      return { statusCode: 400, body: JSON.stringify({ error: data.error.message }) };
    }

    const text = data.content.map((b) => b.text || "").join("");
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
