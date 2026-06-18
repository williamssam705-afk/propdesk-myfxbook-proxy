// PropDesk Myfxbook Proxy — standalone server
// Runs on Render (or any non-Cloudflare host) to avoid Myfxbook's
// Cloudflare-IP bot detection that blocks requests from Cloudflare Workers.
//
// Endpoints (same shape as the old Worker, so the frontend needs zero changes
// beyond pointing MFB_WORKER at this server's URL):
//   GET /myfxbook/login?email=X&password=Y
//   GET /myfxbook/accounts?session=X
//   GET /myfxbook/history?session=X&id=Y
//   GET /myfxbook/open-trades?session=X&id=Y
//   GET /myfxbook/daily-gain?session=X&id=Y&start=...&end=...
//   GET /myfxbook/summary?session=X

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const MFB_BASE = 'https://www.myfxbook.com/api';

// Map our short paths to Myfxbook's actual API endpoints
const PATH_MAP = {
  '/login': '/login.json',
  '/accounts': '/get-my-accounts.json',
  '/history': '/get-history.json',
  '/open-trades': '/get-open-trades.json',
  '/daily-gain': '/get-data-daily.json',
  '/summary': '/get-my-accounts.json',
};

app.use(cors({ origin: '*' }));

app.get('/myfxbook/*', async (req, res) => {
  const path = req.path.replace('/myfxbook', '');
  const mfbPath = PATH_MAP[path];

  if (!mfbPath) {
    return res.status(404).json({ error: true, message: 'Unknown endpoint: ' + path });
  }

  // Rebuild the query string from the incoming request
  const params = new URLSearchParams(req.query).toString();
  const mfbUrl = `${MFB_BASE}${mfbPath}${params ? '?' + params : ''}`;

  try {
    const response = await fetch(mfbUrl, {
      headers: {
        // A realistic browser fingerprint — this server has a normal
        // residential/datacenter IP (not a Cloudflare Worker IP), which is
        // the actual fix; these headers just make it look extra legitimate.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.myfxbook.com/',
        'Origin': 'https://www.myfxbook.com',
      },
    });

    const text = await response.text();
    res.set('Cache-Control', 'no-store');
    res.status(response.status).type('application/json').send(text);
  } catch (err) {
    res.status(502).json({ error: true, message: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'PropDesk Myfxbook Proxy' });
});

app.listen(PORT, () => {
  console.log(`PropDesk Myfxbook Proxy listening on port ${PORT}`);
});
