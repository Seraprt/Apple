const express = require('express');
const { getLeagueAccuracy } = require('../services/accuracyStats');

const router = express.Router();

// GET /api/accuracy/leagues?refresh=true
router.get('/leagues', async (req, res) => {
  try {
    const force = req.query.refresh === 'true';
    const data = await getLeagueAccuracy(force);
    res.json(data);
  } catch (err) {
    console.error('accuracy error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;