// ══════════════════════════════════════════════
// services/matchDetail.js
// Fetches form, H2H, splits, factor bars for the Match Detail page
// ══════════════════════════════════════════════

const Match = require('../models/Match');
const Team = require('../models/Teams');

const toId = (id) => (typeof id === 'string' ? id : String(id));

// ── Last N results for a team ──
async function getRecentForm(teamId, matchDate, numGames = 5) {
  const matches = await Match.find({
    $or: [{ home_team_id: teamId }, { away_team_id: teamId }],
    date: { $lt: matchDate },
    home_goals: { $ne: null },
    away_goals: { $ne: null },
  })
    .sort({ date: -1 })
    .limit(numGames)
    .lean();

  if (!matches.length) return [];

  const oppIds = matches.map((m) =>
    toId(m.home_team_id) === toId(teamId) ? m.away_team_id : m.home_team_id
  );
  const opponents = await Team.find({ _id: { $in: oppIds } })
    .select('name short')
    .lean();
  const oppMap = {};
  opponents.forEach((t) => (oppMap[toId(t._id)] = t));

  return matches.map((m) => {
    const isHome = toId(m.home_team_id) === toId(teamId);
    const gf = isHome ? m.home_goals : m.away_goals;
    const ga = isHome ? m.away_goals : m.home_goals;
    const oppId = isHome ? m.away_team_id : m.home_team_id;
    const opp = oppMap[toId(oppId)];

    let result = 'D';
    if (gf > ga) result = 'W';
    else if (gf < ga) result = 'L';

    return {
      date: m.date,
      result,
      home: isHome,
      opponent: opp?.short || opp?.name || '?',
      opponent_name: opp?.name || 'Unknown',
      goals_for: gf,
      goals_against: ga,
      score: `${gf}-${ga}`,
    };
  });
}

// ── Last N head-to-head meetings ──
async function getH2H(homeId, awayId, matchDate, limit = 5) {
  const matches = await Match.find({
    $or: [
      { home_team_id: homeId, away_team_id: awayId },
      { home_team_id: awayId, away_team_id: homeId },
    ],
    date: { $lt: matchDate },
    home_goals: { $ne: null },
    away_goals: { $ne: null },
  })
    .sort({ date: -1 })
    .limit(limit)
    .lean();

  if (!matches.length) return [];

  const teamIds = new Set();
  matches.forEach((m) => {
    teamIds.add(toId(m.home_team_id));
    teamIds.add(toId(m.away_team_id));
  });
  const teams = await Team.find({ _id: { $in: [...teamIds] } })
    .select('name short')
    .lean();
  const tMap = {};
  teams.forEach((t) => (tMap[toId(t._id)] = t));

  return matches.map((m) => {
    const h = tMap[toId(m.home_team_id)];
    const a = tMap[toId(m.away_team_id)];
    let winner = 'draw';
    if (m.home_goals > m.away_goals) winner = 'home';
    else if (m.away_goals > m.home_goals) winner = 'away';
    return {
      date: m.date,
      home: { id: m.home_team_id, name: h?.name, short: h?.short },
      away: { id: m.away_team_id, name: a?.name, short: a?.short },
      home_goals: m.home_goals,
      away_goals: m.away_goals,
      score: `${m.home_goals}-${m.away_goals}`,
      winner,
      tournament: m.tournament,
    };
  });
}

// ── Home (or away) split stats ──
async function getSplitStats(teamId, matchDate, side) {
  const isHome = side === 'home';
  const sideFilter = isHome
    ? { home_team_id: teamId }
    : { away_team_id: teamId };

  const matches = await Match.find({
    ...sideFilter,
    date: { $lt: matchDate },
    home_goals: { $ne: null },
    away_goals: { $ne: null },
  })
    .sort({ date: -1 })
    .limit(20)
    .lean();

  if (!matches.length) {
    return {
      played: 0, wins: 0, draws: 0, losses: 0,
      goals_for: 0, goals_against: 0,
      ppg: 0, avg_gf: 0, avg_ga: 0,
    };
  }

  let wins = 0, draws = 0, losses = 0, gf = 0, ga = 0;
  for (const m of matches) {
    const teamGoals = isHome ? m.home_goals : m.away_goals;
    const oppGoals = isHome ? m.away_goals : m.home_goals;
    gf += teamGoals;
    ga += oppGoals;
    if (teamGoals > oppGoals) wins++;
    else if (teamGoals === oppGoals) draws++;
    else losses++;
  }
  const played = matches.length;
  const points = wins * 3 + draws;
  return {
    played,
    wins,
    draws,
    losses,
    goals_for: gf,
    goals_against: ga,
    ppg: +(points / played).toFixed(2),
    avg_gf: +(gf / played).toFixed(2),
    avg_ga: +(ga / played).toFixed(2),
  };
}

// ── Normalize factor to 0-1 for the comparison chart ──
function normalizeFactorValue(key, value) {
  if (value == null) return 0;
  switch (key) {
    case 'strength': return Math.min(1, value / 100);
    case 'tournament': return Math.min(1, Math.max(0, (value - 0.9) / 0.3));
    case 'fatigue': return Math.min(1, Math.max(0, (value - 0.5) / 0.5));
    default: return Math.min(1, Math.max(0, value));
  }
}

// ── Build the full extras bundle ──
async function buildDetailExtras(match, homeTeam, awayTeam, homeFactors, awayFactors) {
  const [homeForm, awayForm, h2h, homeSplit, awaySplit] = await Promise.all([
    getRecentForm(homeTeam._id, match.date, 5),
    getRecentForm(awayTeam._id, match.date, 5),
    getH2H(homeTeam._id, awayTeam._id, match.date, 5),
    getSplitStats(homeTeam._id, match.date, 'home'),
    getSplitStats(awayTeam._id, match.date, 'away'),
  ]);

  const raw = [
    { key: 'form', label: 'Recent form', h: homeFactors.form, a: awayFactors.form },
    { key: 'strength', label: 'Squad strength', h: homeFactors.strength, a: awayFactors.strength },
    { key: 'availability', label: 'Availability', h: homeFactors.availability, a: awayFactors.availability },
    { key: 'home_away', label: 'Home / Away', h: homeFactors.home_away, a: awayFactors.home_away },
    { key: 'h2h', label: 'Head to head', h: homeFactors.h2h, a: awayFactors.h2h },
    { key: 'fatigue', label: 'Freshness', h: homeFactors.fatigue, a: awayFactors.fatigue },
    { key: 'coach', label: 'Coach', h: homeFactors.coach, a: awayFactors.coach },
    { key: 'news', label: 'Team news', h: homeFactors.news, a: awayFactors.news },
    { key: 'tournament', label: 'Motivation', h: homeFactors.tournament, a: awayFactors.tournament },
  ];

  const factorBars = raw.map((f) => ({
    key: f.key,
    label: f.label,
    home_raw: +(+f.h).toFixed(3),
    away_raw: +(+f.a).toFixed(3),
    home: +normalizeFactorValue(f.key, f.h).toFixed(3),
    away: +normalizeFactorValue(f.key, f.a).toFixed(3),
  }));

  return {
    form_data: { home: homeForm, away: awayForm },
    h2h_data: h2h,
    splits: { home: homeSplit, away: awaySplit },
    factor_bars: factorBars,
  };
}

module.exports = {
  getRecentForm,
  getH2H,
  getSplitStats,
  buildDetailExtras,
};