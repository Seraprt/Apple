const express = require('express');
const Team = require('../models/Teams');
const Match = require('../models/Match');

const router = express.Router();

// Simple plain-English descriptions
function describeAttack(v) {
  if (v >= 1.3) return { label: 'Very Strong', tone: 'good' };
  if (v >= 1.1) return { label: 'Strong', tone: 'good' };
  if (v >= 0.9) return { label: 'Average', tone: 'ok' };
  if (v >= 0.7) return { label: 'Weak', tone: 'warn' };
  return { label: 'Very Weak', tone: 'bad' };
}
function describeDefence(v) {
  if (v <= 0.7) return { label: 'Very Strong', tone: 'good' };
  if (v <= 0.9) return { label: 'Strong', tone: 'good' };
  if (v <= 1.1) return { label: 'Average', tone: 'ok' };
  if (v <= 1.3) return { label: 'Weak', tone: 'warn' };
  return { label: 'Very Weak', tone: 'bad' };
}
function describeAway(v) {
  if (v < 0.30) return { label: 'Poor traveller', tone: 'bad',
    note: 'Well below our 0.30 away line — they rarely get results on the road.' };
  if (v < 0.45) return { label: 'Below average', tone: 'warn',
    note: 'They travel worse than their league position suggests.' };
  if (v < 0.65) return { label: 'Solid', tone: 'ok',
    note: 'A dependable away side that picks up points on the road.' };
  return { label: 'Elite away', tone: 'good',
    note: 'One of the best travelling records in the league.' };
}
function describeHome(v) {
  if (v < 0.40) return { label: 'Weak at home', tone: 'bad',
    note: 'They give up their home advantage.' };
  if (v < 0.60) return { label: 'Average', tone: 'warn',
    note: 'A normal home record. No major edge, no major weakness.' };
  if (v < 0.78) return { label: 'Strong', tone: 'ok',
    note: 'They win most home games and score freely in front of their crowd.' };
  return { label: 'Fortress', tone: 'good',
    note: 'A genuine fortress. Very few sides take points here.' };
}

// GET /api/teams/search?q=arsenal
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);

    const teams = await Team.find({
      $or: [
        { name: { $regex: q, $options: 'i' } },
        { short: { $regex: q, $options: 'i' } },
      ],
    }).limit(20);

    res.json(
      teams.map((t) => ({
        id: t._id,
        name: t.name,
        short: t.short,
        logo: t.logo,
        league: t.league,
        color: t.color,
      }))
    );
  } catch (err) {
    console.error('search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/teams/:id
// ───── GET /api/teams/:id ─────
router.get('/:id', async (req, res) => {
  try {
    const t = await Team.findById(req.params.id).lean();
    if (!t) return res.status(404).json({ error: 'Team not found' });

    // Recent finished matches (last 5)
    const recentRaw = await Match.find({
      $or: [{ home_team_id: t._id }, { away_team_id: t._id }],
      home_goals: { $ne: null },
      away_goals: { $ne: null },
    })
      .sort({ date: -1 })
      .limit(5)
      .lean();

    // Enrich recent matches with opponent info
    const recent = [];
    for (const m of recentRaw) {
      const isHome = String(m.home_team_id) === String(t._id);
      const oppId = isHome ? m.away_team_id : m.home_team_id;
      const opp = await Team.findById(oppId).select('name short logo color').lean();
      const gf = isHome ? m.home_goals : m.away_goals;
      const ga = isHome ? m.away_goals : m.home_goals;

      recent.push({
        date: m.date,
        competition: m.tournament || '',
        was_home: isHome,
        opponent: opp
          ? {
              id: opp._id,
              name: opp.name,
              short: opp.short,
              logo: opp.logo,
              color: opp.color,
            }
          : null,
        goals_for: gf,
        goals_against: ga,
        result: gf > ga ? 'W' : gf === ga ? 'D' : 'L',
      });
    }

    // Next upcoming match
    const nextRaw = await Match.findOne({
      $or: [{ home_team_id: t._id }, { away_team_id: t._id }],
      date: { $gte: new Date() },
    })
      .sort({ date: 1 })
      .lean();

    let nextMatch = null;
    if (nextRaw) {
      const isHome = String(nextRaw.home_team_id) === String(t._id);
      const oppId = isHome ? nextRaw.away_team_id : nextRaw.home_team_id;
      const opp = await Team.findById(oppId).select('name short logo color').lean();
      nextMatch = {
        date: nextRaw.date,
        competition: nextRaw.tournament || '',
        was_home: isHome,
        opponent: opp
          ? {
              id: opp._id,
              name: opp.name,
              short: opp.short,
              logo: opp.logo,
              color: opp.color,
            }
          : null,
      };
    }

    const form = recent.map((m) => m.result);

    res.json({
      id: t._id,
      name: t.name,
      short: t.short,
      logo: t.logo,
      league: t.league,
      color: t.color,
      attack_rating: t.attack_rating ?? 1.0,
      defence_rating: t.defence_rating ?? 1.0,
      attack_text: describeAttack(t.attack_rating ?? 1.0),
      defence_text: describeDefence(t.defence_rating ?? 1.0),
      home_strength: t.home_ppg ?? 1.5,
      away_strength: t.away_ppg ?? 1.0,
      home_text: describeHome(t.home_ppg ?? 1.5),
      away_text: describeAway(t.away_ppg ?? 1.0),
      elo: t.elo_rating ?? 1500,
      recent_form: form,
      recent_matches: recent,     // ← NEW
      next_match: nextMatch,      // ← NEW
      away_warning: (t.away_ppg ?? 1.0) < 0.30,
    });
  } catch (err) {
    console.error('team details error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;