// ══════════════════════════════════════════════
// services/rankings.js
// Computes home/away strength rankings with 1-100 ratings
// ══════════════════════════════════════════════

const Match = require('../models/Match');
const Team = require('../models/Teams');

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
let _cache = null;
let _cacheAt = 0;

// ══════════════════════════════════════════════
// Convert points-per-game to 1-100 rating
// ══════════════════════════════════════════════
function ppgToRating(ppg) {
  const v = Math.round((ppg / 3.0) * 100);
  return Math.max(1, Math.min(100, v));
}

// ══════════════════════════════════════════════
// Compute all team stats
// ══════════════════════════════════════════════
async function computeRankings() {
  const matches = await Match.find({
    home_goals: { $ne: null },
    away_goals: { $ne: null },
  })
    .select('home_team_id away_team_id home_goals away_goals')
    .lean();

  if (!matches.length) return { home: [], away: [] };

  const homeStats = {};
  const awayStats = {};

  for (const m of matches) {
    const hId = String(m.home_team_id);
    const aId = String(m.away_team_id);

    if (!homeStats[hId]) homeStats[hId] = { played: 0, points: 0, gf: 0, ga: 0 };
    if (!awayStats[aId]) awayStats[aId] = { played: 0, points: 0, gf: 0, ga: 0 };

    homeStats[hId].played++;
    homeStats[hId].gf += m.home_goals;
    homeStats[hId].ga += m.away_goals;
    if (m.home_goals > m.away_goals) homeStats[hId].points += 3;
    else if (m.home_goals === m.away_goals) homeStats[hId].points += 1;

    awayStats[aId].played++;
    awayStats[aId].gf += m.away_goals;
    awayStats[aId].ga += m.home_goals;
    if (m.away_goals > m.home_goals) awayStats[aId].points += 3;
    else if (m.away_goals === m.home_goals) awayStats[aId].points += 1;
  }

  const teamIds = Object.keys({ ...homeStats, ...awayStats });
  const teams = await Team.find({ _id: { $in: teamIds } })
    .select('name short logo league color')
    .lean();
  const teamMap = {};
  teams.forEach((t) => { teamMap[String(t._id)] = t; });

  function buildList(statsMap) {
    const list = [];
    for (const [teamId, s] of Object.entries(statsMap)) {
      const team = teamMap[teamId];
      if (!team) continue;
      const ppg = s.played > 0 ? s.points / s.played : 0;
      list.push({
        id: teamId,
        team_id: teamId,
        name: team.name,
        short: team.short,
        logo: team.logo,
        league: team.league,
        color: team.color || '#333333',
        played: s.played,
        points: s.points,
        ppg: +ppg.toFixed(2),
        rating: ppgToRating(ppg),
        gf_avg: s.played > 0 ? +(s.gf / s.played).toFixed(2) : 0,
        ga_avg: s.played > 0 ? +(s.ga / s.played).toFixed(2) : 0,
      });
    }
    return list;
  }

  return {
    home: buildList(homeStats),
    away: buildList(awayStats),
  };
}

// ══════════════════════════════════════════════
// Get rankings (cached + filtered)
// ══════════════════════════════════════════════
async function getRankings(type, limit = 20, minMatches = 10) {
  const now = Date.now();
  if (!_cache || now - _cacheAt > CACHE_TTL_MS) {
    _cache = await computeRankings();
    _cacheAt = now;
  }

  const src = type.startsWith('home') ? _cache.home : _cache.away;
  const filtered = src.filter((t) => t.played >= minMatches);
  const sorted = [...filtered].sort((a, b) => b.ppg - a.ppg);

  if (type.endsWith('bottom')) {
    sorted.reverse();
  }

  return {
    results: sorted.slice(0, limit),
    total_eligible: filtered.length,
    cached_at: new Date(_cacheAt).toISOString(),
  };
}

module.exports = { getRankings, computeRankings, ppgToRating };