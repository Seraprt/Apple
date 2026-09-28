const express = require('express');
const Match = require('../models/Match');
const Team = require('../models/Teams');
const MatchAnalysis = require('../models/MatchAnalysis');
const CustomMatch = require('../models/CustomMatch');

const router = express.Router();

// ───── GET /api/matches/analysis?days=7&league=&date= ─────
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

    const matches = await Match.find(query).sort({ date: 1 }).limit(200).lean();

    // Preload teams
    const teamIds = new Set();
    matches.forEach((m) => {
      teamIds.add(String(m.home_team_id));
      teamIds.add(String(m.away_team_id));
    });
    const teams = await Team.find({ _id: { $in: [...teamIds] } }).lean();
    const teamMap = {};
    teams.forEach((t) => {
      teamMap[String(t._id)] = t;
    });

    // Preload cached analyses
    const matchIds = matches.map((m) => String(m._id));
    const analyses = await MatchAnalysis.find({ match_id: { $in: matchIds } }).lean();
    const analysisMap = {};
    analyses.forEach((a) => {
      analysisMap[a.match_id] = a;
    });

    const results = matches
      .map((m) => {
        const home = teamMap[String(m.home_team_id)];
        const away = teamMap[String(m.away_team_id)];
        if (!home || !away) return null;

        const analysis = analysisMap[String(m._id)];

        return {
          match_id: m._id,
          is_custom: false,
          date: m.date,
          tournament: m.tournament,
          home: {
            id: home._id,
            name: home.name,
            short: home.short,
            logo: home.logo,
            color: home.color,
          },
          away: {
            id: away._id,
            name: away.name,
            short: away.short,
            logo: away.logo,
            color: away.color,
          },
          home_win_prob: analysis?.home_win_prob || null,
          draw_prob: analysis?.draw_prob || null,
          away_win_prob: analysis?.away_win_prob || null,
          confidence: analysis?.confidence || null,
          correct_score: analysis?.correct_score || null,
          best_market: analysis?.best_market || null,
          best_market_label: analysis?.best_market_label || null,
          pick: analysis?.pick || null,
          secondary_pick: analysis?.secondary_pick || null,
          reason_short: analysis?.reason_short || null,
          reasons: analysis?.reasons || [],
          markets: analysis?.markets || [],
        };
      })
      .filter(Boolean);

    // ── Merge in custom matches ──
    const customQuery = { active: true, date: { $gte: start, $lt: end } };
    if (league && league !== 'All') customQuery.league = league;

    const customMatches = await CustomMatch.find(customQuery).lean();

    for (const cm of customMatches) {
      results.push({
        match_id: `custom-${cm._id}`,
        is_custom: true,
        date: cm.date,
        tournament: cm.league,
        home: {
          id: null,
          name: cm.home_team_name,
          short: cm.home_team_name.slice(0, 3).toUpperCase(),
          logo: '',
          color: '#5A6474',
        },
        away: {
          id: null,
          name: cm.away_team_name,
          short: cm.away_team_name.slice(0, 3).toUpperCase(),
          logo: '',
          color: '#5A6474',
        },
        home_win_prob: null,
        draw_prob: null,
        away_win_prob: null,
        confidence: null,
        correct_score: cm.suggested_score || null,
        best_market: cm.suggested_market,
        best_market_label: cm.suggested_market,
        pick: cm.suggested_market,
        secondary_pick: null,
        reason_short: cm.notes || null,
        reasons: [],
        markets: [{ key: 'Suggested', value: cm.suggested_market }],
        custom_notice:
          'This league is not covered by our main data feed — prediction is a manual market suggestion.',
      });
    }

    // Chronological order
    results.sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json(results);
  } catch (err) {
    console.error('analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───── GET /api/matches/leagues ─────
router.get('/leagues', async (req, res) => {
  try {
    const [apiLeagues, customLeagues] = await Promise.all([
      Match.distinct('tournament'),
      CustomMatch.distinct('league'),
    ]);
    const merged = [...new Set([...apiLeagues, ...customLeagues])]
      .filter(Boolean)
      .sort();
    res.json(['All', ...merged]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;