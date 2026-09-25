const express = require('express');
const Team = require('../models/Team');
const { compareTeams } = require('../services/predictionEngine');

const router = express.Router();

// GET /api/predictions/compare?home_id=X&away_id=Y
router.get('/compare', async (req, res) => {
  try {
    const { home_id, away_id } = req.query;
    if (!home_id || !away_id) {
      return res.status(400).json({ error: 'home_id and away_id required' });
    }

    const [home, away] = await Promise.all([
      Team.findById(home_id).lean(),
      Team.findById(away_id).lean(),
    ]);
    if (!home || !away) return res.status(404).json({ error: 'Team not found' });

    const result = compareTeams(home, away);
    res.json(result);
  } catch (err) {
    console.error('compare error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;