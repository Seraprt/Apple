const express = require('express');
const { getRankings } = require('../services/rankings');

const router = express.Router();

// GET /api/rankings?type=home_top&limit=20&min_matches=10
// types: home_top | home_bottom | away_top | away_bottom
router.get('/', async (req, res) => {
  try {
    const valid = ['home_top', 'home_bottom', 'away_top', 'away_bottom'];
    const type = valid.includes(req.query.type) ? req.query.type : 'home_top';
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const minMatches = Math.max(parseInt(req.query.min_matches) || 10, 1);

    const data = await getRankings(type, limit, minMatches);
    res.json({
      type,
      limit,
      min_matches: minMatches,
      total_eligible: data.total_eligible,
      cached_at: data.cached_at,
      results: data.results,
    });
  } catch (err) {
    console.error('rankings error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;