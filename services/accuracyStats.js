// ══════════════════════════════════════════════
// services/accuracyStats.js
// Computes prediction accuracy per league from finished matches
// ══════════════════════════════════════════════

const Match = require('../models/Match');
const MatchAnalysis = require('../models/MatchAnalysis');
const { normalizeLeague } = require('./leagues');

// ══════════════════════════════════════════════
// Evaluate a single market against actual score
// Returns true (hit), false (miss), or null (can't evaluate)
// ══════════════════════════════════════════════
function evaluateMarket(marketKey, homeGoals, awayGoals) {
  if (!marketKey) return null;

  const total = homeGoals + awayGoals;
  const diff = homeGoals - awayGoals;

  // ── 1X2 ──
  if (marketKey === 'home_win') return homeGoals > awayGoals;
  if (marketKey === 'draw') return homeGoals === awayGoals;
  if (marketKey === 'away_win') return awayGoals > homeGoals;
  if (marketKey === '1X') return homeGoals >= awayGoals;
  if (marketKey === 'X2') return awayGoals >= homeGoals;
  if (marketKey === '12') return homeGoals !== awayGoals;

  // ── Draw No Bet ──
  if (marketKey === 'dnb_home') return homeGoals > awayGoals;
  if (marketKey === 'dnb_away') return awayGoals > homeGoals;

  // ── BTTS ──
  if (marketKey === 'btts_yes') return homeGoals > 0 && awayGoals > 0;
  if (marketKey === 'btts_no') return homeGoals === 0 || awayGoals === 0;

  // ── Total goals O/U ──
  let m = marketKey.match(/^over_(\d+(?:\.\d+)?)$/);
  if (m) return total > parseFloat(m[1]);
  m = marketKey.match(/^under_(\d+(?:\.\d+)?)$/);
  if (m) return total < parseFloat(m[1]);

  // ── Team goals O/U ──
  m = marketKey.match(/^(home|away)_over_(\d+(?:\.\d+)?)$/);
  if (m) {
    const goals = m[1] === 'home' ? homeGoals : awayGoals;
    return goals > parseFloat(m[2]);
  }
  m = marketKey.match(/^(home|away)_under_(\d+(?:\.\d+)?)$/);
  if (m) {
    const goals = m[1] === 'home' ? homeGoals : awayGoals;
    return goals < parseFloat(m[2]);
  }

  // ── Handicaps ──
  m = marketKey.match(/^home_([+-]\d+(?:\.\d+)?)$/);
  if (m) return homeGoals + parseFloat(m[1]) > awayGoals;
  m = marketKey.match(/^away_([+-]\d+(?:\.\d+)?)$/);
  if (m) return awayGoals + parseFloat(m[1]) > homeGoals;

  // ── Clean sheets ──
  if (marketKey === 'home_clean_sheet') return awayGoals === 0;
  if (marketKey === 'away_clean_sheet') return homeGoals === 0;

  // ── Win to nil ──
  if (marketKey === 'home_win_to_nil') return homeGoals > 0 && awayGoals === 0;
  if (marketKey === 'away_win_to_nil') return awayGoals > 0 && homeGoals === 0;

  // ── Winning margin ──
  if (marketKey === 'home_win_by_1') return diff === 1;
  if (marketKey === 'home_win_by_2') return diff === 2;
  if (marketKey === 'home_win_by_3plus') return diff >= 3;
  if (marketKey === 'away_win_by_1') return diff === -1;
  if (marketKey === 'away_win_by_2') return diff === -2;
  if (marketKey === 'away_win_by_3plus') return diff <= -3;

  // ── Odd/Even ──
  if (marketKey === 'odd') return total % 2 === 1;
  if (marketKey === 'even') return total % 2 === 0;

  // ── Result + BTTS ──
  if (marketKey === 'home_win_btts_yes') return homeGoals > awayGoals && homeGoals > 0 && awayGoals > 0;
  if (marketKey === 'home_win_btts_no') return homeGoals > awayGoals && (homeGoals === 0 || awayGoals === 0);
  if (marketKey === 'draw_btts_yes') return homeGoals === awayGoals && homeGoals > 0;
  if (marketKey === 'draw_btts_no') return homeGoals === awayGoals && homeGoals === 0;
  if (marketKey === 'away_win_btts_yes') return awayGoals > homeGoals && homeGoals > 0 && awayGoals > 0;
  if (marketKey === 'away_win_btts_no') return awayGoals > homeGoals && (homeGoals === 0 || awayGoals === 0);

  // ── BTTS + O/U 2.5 ──
  if (marketKey === 'btts_and_over_2_5') return homeGoals > 0 && awayGoals > 0 && total > 2.5;
  if (marketKey === 'btts_and_under_2_5') return homeGoals > 0 && awayGoals > 0 && total < 2.5;
  if (marketKey === 'no_btts_and_over_2_5') return (homeGoals === 0 || awayGoals === 0) && total > 2.5;
  if (marketKey === 'no_btts_and_under_2_5') return (homeGoals === 0 || awayGoals === 0) && total < 2.5;

  // ── Any team 2.5+ ──
  if (marketKey === 'any_team_over_2.5_goals') return homeGoals > 2.5 || awayGoals > 2.5;
  if (marketKey === 'any_team_under_2.5_goals') return homeGoals < 2.5 && awayGoals < 2.5;

  // ── Score first (can't evaluate without event data) ──
  if (marketKey === 'home_score_first' || marketKey === 'away_score_first') return null;

  return null;
}

// ══════════════════════════════════════════════
// Sure-bet threshold (matches Python engine)
// ══════════════════════════════════════════════
const SURE_BET_MIN_PROB = 0.80;
const SURE_BET_MIN_CONF = 0.85;

// ══════════════════════════════════════════════
// Bucket helper
// ══════════════════════════════════════════════
function makeBucket() {
  return { hits: 0, total: 0 };
}
function finalize(bucket) {
  return {
    hits: bucket.hits,
    total: bucket.total,
    rate: bucket.total > 0 ? +((bucket.hits / bucket.total) * 100).toFixed(1) : null,
  };
}

// ══════════════════════════════════════════════
// Compute all league stats
// ══════════════════════════════════════════════
async function computeLeagueAccuracy() {
  const matches = await Match.find({
    home_goals: { $ne: null },
    away_goals: { $ne: null },
  })
    .select('_id tournament home_goals away_goals date')
    .lean();

  if (!matches.length) return { leagues: [], overall: null };

  const matchIds = matches.map((m) => String(m._id));
  const analyses = await MatchAnalysis.find({ match_id: { $in: matchIds } })
    .select('match_id correct_score best_market best_market_label confidence probability secondary_pick')
    .lean();

  const analysisMap = {};
  analyses.forEach((a) => { analysisMap[a.match_id] = a; });

  const leagueMap = {};
  const overall = {
    totalEvaluated: 0,
    bestPick: makeBucket(),
    sureBet: makeBucket(),
    secondary: makeBucket(),
    correctScore: makeBucket(),
  };

  function ensure(league) {
    if (!leagueMap[league]) {
      leagueMap[league] = {
        league,
        totalEvaluated: 0,
        bestPick: makeBucket(),
        sureBet: makeBucket(),
        secondary: makeBucket(),
        correctScore: makeBucket(),
      };
    }
    return leagueMap[league];
  }

  for (const m of matches) {
    const a = analysisMap[String(m._id)];
    if (!a) continue;

    const league = normalizeLeague(m.tournament) || 'Unknown';
    const stats = ensure(league);
    stats.totalEvaluated++;
    overall.totalEvaluated++;

    // ── Best Pick ──
    const bestHit = evaluateMarket(a.best_market, m.home_goals, m.away_goals);
    if (bestHit !== null) {
      stats.bestPick.total++; overall.bestPick.total++;
      if (bestHit) { stats.bestPick.hits++; overall.bestPick.hits++; }
    }

    // ── Sure Bet (subset of best pick with high prob + conf) ──
    const prob = a.probability ?? 0;
    const conf = a.confidence ?? 0;
    if (bestHit !== null && prob >= SURE_BET_MIN_PROB && conf >= SURE_BET_MIN_CONF) {
      stats.sureBet.total++; overall.sureBet.total++;
      if (bestHit) { stats.sureBet.hits++; overall.sureBet.hits++; }
    }

    // ── Secondary Pick ──
    if (a.secondary_pick?.market) {
      const secHit = evaluateMarket(a.secondary_pick.market, m.home_goals, m.away_goals);
      if (secHit !== null) {
        stats.secondary.total++; overall.secondary.total++;
        if (secHit) { stats.secondary.hits++; overall.secondary.hits++; }
      }
    }

    // ── Correct Score ──
    if (a.correct_score) {
      const actual = `${m.home_goals}-${m.away_goals}`;
      stats.correctScore.total++; overall.correctScore.total++;
      if (a.correct_score === actual) { stats.correctScore.hits++; overall.correctScore.hits++; }
    }
  }

  const leagues = Object.values(leagueMap)
    .map((s) => ({
      league: s.league,
      totalEvaluated: s.totalEvaluated,
      bestPick: finalize(s.bestPick),
      sureBet: finalize(s.sureBet),
      secondary: finalize(s.secondary),
      correctScore: finalize(s.correctScore),
    }))
    .filter((s) => s.totalEvaluated >= 3) // ignore leagues with < 3 evaluations
    .sort((a, b) => b.totalEvaluated - a.totalEvaluated);

  return {
    leagues,
    overall: {
      totalEvaluated: overall.totalEvaluated,
      bestPick: finalize(overall.bestPick),
      sureBet: finalize(overall.sureBet),
      secondary: finalize(overall.secondary),
      correctScore: finalize(overall.correctScore),
    },
  };
}

// ══════════════════════════════════════════════
// In-memory cache (1 hour)
// ══════════════════════════════════════════════
let _cache = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

async function getLeagueAccuracy(force = false) {
  if (!force && _cache && Date.now() - _cachedAt < CACHE_TTL_MS) {
    return { ..._cache, updated_at: new Date(_cachedAt), cached: true };
  }
  const fresh = await computeLeagueAccuracy();
  _cache = fresh;
  _cachedAt = Date.now();
  return { ...fresh, updated_at: new Date(_cachedAt), cached: false };
}

module.exports = { getLeagueAccuracy, computeLeagueAccuracy, evaluateMarket };