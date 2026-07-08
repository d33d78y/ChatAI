// api/chat.js
// Vercel Edge Function — deploy this by placing it at /api/chat.js in your
// repo root. Vercel automatically turns it into a live endpoint at
// https://<your-project>.vercel.app/api/chat
//
// The OpenRouter key lives only in Vercel's Environment Variables (set in
// Project Settings → Environment Variables), never in the browser or in git.

export const config = { runtime: 'edge' };

// Best-effort in-memory rate limit. Note: Edge functions can run as multiple
// isolated instances across regions, so this only limits abuse *per instance*,
// not globally. Good enough to slow down casual abuse; for hard guarantees
// you'd want Vercel KV / Upstash Redis-backed limiting instead.
const rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const max = 20;
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
  entry.count += 1;
  rateLimitMap.set(ip, entry);
  return entry.count <= max;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: 'Method not allowed' } }), { status: 405 });
  }

  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!checkRateLimit(ip)) {
    return new Response(
      JSON.stringify({ error: { message: 'Слишком много запросов. Подождите немного и попробуйте снова.' } }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: { message: 'Сервер не настроен: добавьте OPENROUTER_API_KEY в Vercel → Settings → Environment Variables.' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: 'Некорректный JSON в запросе' } }), { status: 400 });
  }
  if (!body.model) body.model = process.env.DEFAULT_MODEL || 'openrouter/free';

  let upstream;
  try {
    upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.SITE_URL || 'https://chat-ai-4a.vercel.app',
        'X-Title': 'BarbosovAI'
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: 'Не удалось связаться с OpenRouter: ' + err.message } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Pipe the upstream response (including SSE streaming chunks) straight
  // through to the browser — Edge Runtime lets us hand back its body as-is.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' }
  });
}
