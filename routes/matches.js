const express = require('express');
const Match = require('../models/Match');
const Team = require('../models/Teams');
const MatchAnalysis = require('../models/MatchAnalysis');

const router = express.Router();

// GET /api/matches/analysis?days=7&league=&date=
router.get('/analysis', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const league = req.query.league;
    const dateStr = req.query.date;

    const now = new Date();
    let start, end;

    if (dateStr) {
      start = new Date(dateStr);
      start.setHours(0, 0, 0, 0);
      end = new Date(start);
      end.setDate(end.getDate() + 1);
    } else {
      start = now;
      end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    }

    const query = { date: { $gte: start, $lt: end } };
    if (league && league !== 'All') query.tournament = league;

    const matches = await Match.find(query).sort({ date: 1 }).limit(200);

    const results = [];
    for (const m of matches) {
      const home = await Team.findById(m.home_team_id).select('name short logo color');
      const away = await Team.findById(m.away_team_id).select('name short logo color');
      if (!home || !away) continue;

      // Try to get cached analysis first
      let analysis = await MatchAnalysis.findOne({ match_id: String(m._id) });

      results.push({
        match_id: m._id,
        date: m.date,
        tournament: m.tournament,
        home: { id: home._id, name: home.name, short: home.short, logo: home.logo, color: home.color },
        away: { id: away._id, name: away.name, short: away.short, logo: away.logo, color: away.color },
        home_win_prob: m.home_win_prob,
        draw_prob: m.draw_prob,
        away_win_prob: m.away_win_prob,
        confidence: m.confidence,
        correct_score: m.predicted_correct_score,
        best_market: analysis?.best_market || null,
        reason_short: analysis?.reason_short || null,
        reasons: analysis?.reasons || [],
        markets: analysis?.markets || [],
      });
    }

    res.json(results);
  } catch (err) {
    console.error('analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/matches/leagues – unique tournaments in DB
router.get('/leagues', async (req, res) => {
  try {
    const leagues = await Match.distinct('tournament');
    res.json(['All', ...leagues.filter(Boolean).sort()]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;