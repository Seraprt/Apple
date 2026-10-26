const express = require('express');
const router = express.Router();

// GET /api/img?url=<encoded-logo-url>
// Proxies football-data.org crests so html2canvas can read them (CORS)
router.get('/', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url || !/^https?:\/\//.test(url)) {
      return res.status(400).send('Invalid URL');
    }
    // Only allow football-data.org domains (prevents SSRF)
    if (!url.includes('football-data.org')) {
      return res.status(403).send('Only football-data.org images allowed');
    }

    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).send('Fetch failed');

    const buffer = await response.arrayBuffer();
    res.set('Content-Type', response.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send('Failed to fetch image');
  }
});

module.exports = router;