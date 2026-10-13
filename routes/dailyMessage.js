const express = require('express');
const DailyMessage = require('../models/DailyMessage');

const router = express.Router();

// GET /api/daily-message — returns the current active daily message
router.get('/', async (req, res) => {
  try {
    const msg = await DailyMessage.findOne({ active: true })
      .sort({ updated_at: -1 })
      .lean();

    if (!msg) {
      return res.json({ heading: null, body: null });
    }

    res.json({
      heading: msg.heading,
      body: msg.body,
      updated_at: msg.updated_at,
    });
  } catch (err) {
    console.error('daily-message error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;