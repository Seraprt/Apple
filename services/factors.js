// ══════════════════════════════════════════════
// services/factors.js
// Exact port of app/factors.py + league tier awareness
// ══════════════════════════════════════════════

const Match = require('../models/Match');
const Team = require('../models/Teams');
const Player = require('../models/Player');

// ══════════════════════════════════════════════
// LEAGUE TIERS
// Multiplier representing the quality of a league.
// Top-5 European = 1.00, Second tier = ~0.65-0.85,
// Non-European top flights = 0.70-0.80.
// ══════════════════════════════════════════════
const LEAGUE_TIERS = {
  // ── Top 5 European ──
  'premier league': 1.00,
  'la liga': 0.98,
  'serie a': 0.97,
  'bundesliga': 0.98,
  'ligue 1': 0.95,
  'champions league': 1.02,
  'uefa champions league': 1.02,
  'europa league': 0.98,
  'uefa europa league': 0.98,

  // ── Second tier European ──
  'eredivisie': 0.85,
  'primeira liga': 0.88,
  'belgian pro league': 0.82,
  'championship': 0.72,
  'segunda division': 0.68,
  'serie b': 0.65,
  '2. bundesliga': 0.65,
  'ligue 2': 0.62,
  'scottish premiership': 0.70,
  'russian premier league': 0.78,
  'turkish super lig': 0.78,
  'super lig': 0.78,
  'swiss super league': 0.74,
  'austrian bundesliga': 0.72,
  'ukrainian premier league': 0.72,

  // ── Non-European top flights ──
  'brasileirao': 0.80,
  'campeonato brasileiro': 0.80,
  'argentine primera division': 0.78,
  'liga mx': 0.76,
  'mls': 0.70,
  'major league soccer': 0.70,
  'saudi pro league': 0.72,
  'j1 league': 0.74,
  'k league 1': 0.72,

  // ── Fallback ──
  default: 0.80,
};

function getTierFactor(league) {
  if (!league) return LEAGUE_TIERS.default;
  const l = league.toLowerCase().trim();
  return LEAGUE_TIERS[l] ?? LEAGUE_TIERS.default;
}

// ══════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════
const toId = (id) => (typeof id === 'string' ? id : String(id));

async function getTeam(teamId) {
  try {
    return await Team.findById(teamId).lean();
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════
// 1. FORM
// ══════════════════════════════════════════════
async function getFormScore(teamId, matchDate, numGames = 5) {
  const matches = await Match.find({
    $or: [{ home_team_id: teamId }, { away_team_id: teamId }],
    date: { $lt: matchDate },
    home_goals: { $ne: null },
    away_goals: { $ne: null },
  })
    .sort({ date: -1 })
    .limit(numGames)
    .lean();

  if (!matches.length) return 0.5;

  const weights = [5, 4, 3, 2, 1].slice(0, matches.length);
  const maxPossible = weights.reduce((a, b) => a + b, 0) * 3;
  let totalPoints = 0;

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const isHome = toId(m.home_team_id) === toId(teamId);
    const gf = isHome ? m.home_goals : m.away_goals;
    const ga = isHome ? m.away_goals : m.home_goals;
    const oppId = isHome ? m.away_team_id : m.home_team_id;

    let pts = 0;
    if (gf > ga) pts = 3;
    else if (gf === ga) pts = 1;

    const opp = await getTeam(oppId);
    const oppStrength = opp?.strength ? opp.strength / 100.0 : 0.5;
    const adjustedPts = pts * (0.5 + 0.5 * oppStrength);
    totalPoints += weights[i] * adjustedPts;
  }

  const norm = maxPossible > 0 ? totalPoints / maxPossible : 0.5;
  return Math.min(1.0, norm);
}

// ══════════════════════════════════════════════
// 2. STRENGTH — ELO × league tier
// ══════════════════════════════════════════════
async function getStrengthScore(teamId) {
  const team = await getTeam(teamId);
  if (!team) return 50.0;

  const elo = team.elo_rating || 1500;
  const baseStrength = Math.max(0, Math.min(100, (elo - 1000) / 10));

  // Apply league tier — this is the key change
  const tier = getTierFactor(team.league);
  return baseStrength * tier;
}

// ══════════════════════════════════════════════
// 3. AVAILABILITY
// ══════════════════════════════════════════════
async function getAvailabilityScore(teamId) {
  try {
    if (!Player) return 0.5;
    const players = await Player.find({ team_id: teamId }).lean();
    if (!players.length) return 0.5;
    let totalImp = 0;
    let availableImp = 0;
    for (const p of players) {
      const imp = p.importance ?? 0.5;
      totalImp += imp;
      if (p.available !== false) availableImp += imp;
    }
    return totalImp > 0 ? availableImp / totalImp : 0.5;
  } catch {
    return 0.5;
  }
}

// ══════════════════════════════════════════════
// 4. TOURNAMENT FACTOR
// ══════════════════════════════════════════════
function getTournamentFactor(tournament, stage, leg, aggregateDiff) {
  const t = (tournament || '').toLowerCase();
  const s = (stage || '').toLowerCase();

  if (s.includes('final')) return 1.2;
  if (s.includes('semi')) return 1.1;
  if (s.includes('quarter')) return 1.05;
  if (s.includes('group')) return 1.0;
  if (t.includes('cup') && (s.includes('round') || s.includes('1st') || s.includes('2nd'))) return 0.9;
  if (leg === 2 && aggregateDiff !== null && aggregateDiff !== undefined) {
    if (Math.abs(aggregateDiff) >= 2) return 0.95;
  }
  return 1.0;
}

// ══════════════════════════════════════════════
// 5. COACH
// ══════════════════════════════════════════════
async function getCoachScore(teamId) {
  const team = await getTeam(teamId);
  if (!team || (team.matches_coached || 0) < 2) return 0.5;
  return team.coach_win_rate ?? 0.5;
}

// ══════════════════════════════════════════════
// 6. HOME / AWAY
// ══════════════════════════════════════════════
async function getHomeAwayScore(teamId, isHome, opponentStrength) {
  const team = await getTeam(teamId);
  if (!team) return 0.5;

  const oppFactor = opponentStrength ? opponentStrength / 100.0 : 0.5;

  if (isHome) {
    const raw = (team.home_ppg ?? 1.5) / 3.0;
    return Math.max(0, Math.min(1, raw * (1 + 0.2 * (1 - oppFactor))));
  } else {
    const raw = (team.away_ppg ?? 1.0) / 3.0;
    return Math.max(0, Math.min(1, raw * (1 - 0.2 * oppFactor)));
  }
}

// ══════════════════════════════════════════════
// 7. HEAD-TO-HEAD
// ══════════════════════════════════════════════
async function getH2HScore(homeId, awayId, matchDate) {
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
    .limit(5)
    .lean();

  if (!matches.length) return 0.5;

  const weights = [5, 4, 3, 2, 1].slice(0, matches.length);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  let total = 0;

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const isHome = toId(m.home_team_id) === toId(homeId);
    if (isHome) {
      if (m.home_goals > m.away_goals) total += weights[i] * 1.0;
      else if (m.home_goals === m.away_goals) total += weights[i] * 0.5;
    } else {
      if (m.away_goals > m.home_goals) total += weights[i] * 1.0;
      else if (m.away_goals === m.home_goals) total += weights[i] * 0.5;
    }
  }

  return weightSum > 0 ? total / weightSum : 0.5;
}

// ══════════════════════════════════════════════
// 8. WEATHER — placeholder
// ══════════════════════════════════════════════
async function getWeatherMultiplier(lat, lon, matchTime) {
  return 1.0;
}

// ══════════════════════════════════════════════
// 9. FATIGUE
// ══════════════════════════════════════════════
async function getFatigueScore(teamId, matchDate) {
  const lastMatch = await Match.findOne({
    $or: [{ home_team_id: teamId }, { away_team_id: teamId }],
    date: { $lt: matchDate },
  })
    .sort({ date: -1 })
    .lean();

  if (!lastMatch) return 1.0;

  const restDays =
    (new Date(matchDate).getTime() - new Date(lastMatch.date).getTime()) / 86400000;

  let restFactor;
  if (restDays >= 4) restFactor = 1.0;
  else if (restDays >= 3) restFactor = 0.95;
  else if (restDays >= 2) restFactor = 0.85;
  else restFactor = 0.7;

  return Math.max(0.5, Math.min(1.0, restFactor));
}

// ══════════════════════════════════════════════
// 10. NEWS — placeholder
// ══════════════════════════════════════════════
async function getNewsScore(teamId) {
  return 0.5;
}

// ══════════════════════════════════════════════
// 11. ATTACK / DEFENCE
// ══════════════════════════════════════════════
async function getAttackRating(teamId) {
  const team = await getTeam(teamId);
  return team?.attack_rating ?? 1.0;
}
async function getDefenceRating(teamId) {
  const team = await getTeam(teamId);
  return team?.defence_rating ?? 1.0;
}

// ══════════════════════════════════════════════
// MAIN — compute all factors for a match
// ══════════════════════════════════════════════
async function computeMatchFactors(match, homeTeam, awayTeam) {
  const matchDate = new Date(match.date);

  const homeStrength = await getStrengthScore(homeTeam._id);
  const awayStrength = await getStrengthScore(awayTeam._id);

  const [
    homeForm,
    awayForm,
    homeAvail,
    awayAvail,
    homeCoach,
    awayCoach,
    homeHomeAway,
    awayHomeAway,
    homeH2H,
    homeFatigue,
    awayFatigue,
    homeNews,
    awayNews,
  ] = await Promise.all([
    getFormScore(homeTeam._id, matchDate),
    getFormScore(awayTeam._id, matchDate),
    getAvailabilityScore(homeTeam._id),
    getAvailabilityScore(awayTeam._id),
    getCoachScore(homeTeam._id),
    getCoachScore(awayTeam._id),
    getHomeAwayScore(homeTeam._id, true, awayStrength),
    getHomeAwayScore(awayTeam._id, false, homeStrength),
    getH2HScore(homeTeam._id, awayTeam._id, matchDate),
    getFatigueScore(homeTeam._id, matchDate),
    getFatigueScore(awayTeam._id, matchDate),
    getNewsScore(homeTeam._id),
    getNewsScore(awayTeam._id),
  ]);

  const tournamentFactor = getTournamentFactor(
    match.tournament,
    match.stage,
    match.leg || 1,
    match.aggregate_home != null
      ? match.aggregate_home - (match.aggregate_away || 0)
      : null
  );

  const homeFactors = {
    form: homeForm,
    strength: homeStrength,
    availability: homeAvail,
    tournament: tournamentFactor,
    coach: homeCoach,
    home_away: homeHomeAway,
    h2h: homeH2H,
    fatigue: homeFatigue,
    news: homeNews,
  };

  const awayFactors = {
    form: awayForm,
    strength: awayStrength,
    availability: awayAvail,
    tournament: tournamentFactor,
    coach: awayCoach,
    home_away: awayHomeAway,
    h2h: 1 - homeH2H,
    fatigue: awayFatigue,
    news: awayNews,
  };

  // Include tier info for the engine to use in reasons & xG
  const homeTier = getTierFactor(homeTeam.league);
  const awayTier = getTierFactor(awayTeam.league);

  return {
    homeFactors,
    awayFactors,
    homeTier,
    awayTier,
  };
}

module.exports = {
  LEAGUE_TIERS,
  getTierFactor,
  getFormScore,
  getStrengthScore,
  getAvailabilityScore,
  getTournamentFactor,
  getCoachScore,
  getHomeAwayScore,
  getH2HScore,
  getWeatherMultiplier,
  getFatigueScore,
  getNewsScore,
  getAttackRating,
  getDefenceRating,
  computeMatchFactors,
};