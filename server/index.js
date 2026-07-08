// server/index.js
// BarbosovAI backend — proxies chat requests to OpenRouter so the API key
// never has to live in the browser. Deploy this anywhere that runs Node.js
// (Render, Railway, Fly.io, a VPS, etc).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // set to your frontend's domain in production
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'openrouter/free';

if (!OPENROUTER_API_KEY) {
  console.error('⚠️  OPENROUTER_API_KEY is not set. Create a .env file (see .env.example) before starting the server.');
}

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '15mb' })); // generous limit to allow base64 image attachments

// ---- Rate limiting ----
// Protects your shared key from being drained by a single abusive client.
// Tune these numbers to taste once you see real traffic.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,             // 20 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Слишком много запросов. Подождите немного и попробуйте снова.' } }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, hasKey: !!OPENROUTER_API_KEY });
});

// ---- Main proxy endpoint ----
// The frontend posts the same payload shape it used to send straight to
// OpenRouter (model, messages, stream, temperature, top_p, reasoning...).
// We inject the real Authorization header here and pipe the response
// (including SSE streaming chunks) straight back to the client.
app.post('/api/chat', chatLimiter, async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: { message: 'Сервер не настроен: отсутствует OPENROUTER_API_KEY.' } });
  }

  const body = { ...req.body };
  if (!body.model) body.model = DEFAULT_MODEL;

  try {
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': ALLOWED_ORIGIN !== '*' ? ALLOWED_ORIGIN : 'https://barbosov.ai',
        'X-Title': 'BarbosovAI'
      },
      body: JSON.stringify(body)
    });

    // Forward status + relevant headers
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type') || '';
    res.setHeader('Content-Type', contentType);

    if (body.stream && upstream.body) {
      // Pipe the SSE stream straight through, chunk by chunk.
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      res.flushHeaders?.();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(encoder.encode(decoder.decode(value, { stream: true })));
      }
      res.end();
    } else {
      const data = await upstream.text();
      res.send(data);
    }
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).json({ error: { message: 'Не удалось связаться с OpenRouter: ' + err.message } });
  }
});

app.listen(PORT, () => {
  console.log(`BarbosovAI backend listening on port ${PORT}`);
});
