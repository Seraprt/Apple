// ══════════════════════════════════════════════
// services/factors.js
// Exact port of app/factors.py from the Python engine
// ══════════════════════════════════════════════

const Match = require('../models/Match');
const Team = require('../models/Team');
const Player = require('../models/Player');  // optional; returns null if missing
const axios = require('axios');

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
// 1. FORM — last N matches, weighted by recency & opponent strength
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
// 2. STRENGTH — pure ELO (returns 0-100)
// ══════════════════════════════════════════════
async function getStrengthScore(teamId) {
  const team = await getTeam(teamId);
  if (!team) return 50.0;
  const elo = team.elo_rating || 1500;
  return Math.max(0, Math.min(100, (elo - 1000) / 10));
}

// ══════════════════════════════════════════════
// 3. AVAILABILITY — from players collection (placeholder if missing)
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
// 6. HOME / AWAY ADVANTAGE
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
// 8. WEATHER — placeholder (returns 1.0 multiplier)
// ══════════════════════════════════════════════
// Python calls a real weather API. In Node, we return neutral 1.0
// unless you wire up OpenWeatherMap later.
async function getWeatherMultiplier(lat, lon, matchTime) {
  // TODO: add OpenWeatherMap integration later
  return 1.0;
}

// ══════════════════════════════════════════════
// 9. FATIGUE — rest days + travel
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

  // Travel penalty — skip if we don't have coordinates
  // (Python uses haversine between venues; we'll approximate as 0)
  const travelPenalty = 0.0;

  return Math.max(0.5, Math.min(1.0, restFactor - travelPenalty));
}

// ══════════════════════════════════════════════
// 10. NEWS — placeholder (returns 0.5 neutral)
// ══════════════════════════════════════════════
async function getNewsScore(teamId) {
  // TODO: integrate news sentiment API later
  return 0.5;
}

// ══════════════════════════════════════════════
// 11. ATTACK / DEFENCE RATINGS (already stored on team)
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
// MAIN — compute all 10 factors for a match
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

  return { homeFactors, awayFactors };
}

module.exports = {
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