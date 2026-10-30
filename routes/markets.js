const express = require('express');
const { getBestMarkets } = require('../services/bestMarkets');

const router = express.Router();

// GET /api/markets/best?type=under|over|dc|1x2&days=7&limit=20
router.get('/best', async (req, res) => {
  try {
    const valid = ['under', 'over', 'dc', '1x2'];
    const type = valid.includes(req.query.type) ? req.query.type : 'under';
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const data = await getBestMarkets(type, days, limit);
    res.json(data);
  } catch (err) {
    console.error('markets/best error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;