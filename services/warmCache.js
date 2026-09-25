const Match = require('../models/Match');
const Team = require('../models/Teams');
const MatchAnalysis = require('../models/MatchAnalysis');
const {
  computeXg,
  computeAllMarketProbs,
  mostLikelyScore,
  pickBestMarket,
  buildReasons,
} = require('./predictionEngine');

/**
 * Compute and cache analysis for all upcoming matches (next N days).
 * Idempotent — updates existing rows if they're already there.
 */
async function warmAnalysisCache(daysAhead = 14) {
  const now = new Date();
  const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  const matches = await Match.find({
    date: { $gte: now, $lte: future },
  }).limit(500);

  if (!matches.length) {
    console.log('⚠️ No upcoming matches to warm');
    return 0;
  }

  // Preload all teams into memory to avoid N+1 queries
  const teamIds = new Set();
  matches.forEach((m) => {
    teamIds.add(String(m.home_team_id));
    teamIds.add(String(m.away_team_id));
  });

  const teams = await Team.find({ _id: { $in: [...teamIds] } });
  const teamMap = {};
  teams.forEach((t) => { teamMap[String(t._id)] = t; });

  let count = 0;

  for (const m of matches) {
    const home = teamMap[String(m.home_team_id)];
    const away = teamMap[String(m.away_team_id)];
    if (!home || !away) continue;

    const { homeXg, awayXg } = computeXg(home, away);
    const probs = computeAllMarketProbs(homeXg, awayXg);

    // Confidence heuristic
    const ratingSpread =
      Math.abs((home.attack_rating || 1) - (away.attack_rating || 1)) +
      Math.abs((home.defence_rating || 1) - (away.defence_rating || 1));
    const maxProb = Math.max(probs.home_win, probs.draw, probs.away_win);
    const confidence = Math.min(
      0.95,
      Math.max(0.35, 0.5 + ratingSpread * 0.3 + (maxProb - 0.33) * 0.5)
    );

    const { bestMarket, bestProb, bestScore } = pickBestMarket(probs, confidence);
    const correctScore = mostLikelyScore(homeXg, awayXg);
    const reasons = buildReasons(home, away, probs);
    const top = reasons[0];

    const markets = [
      {
        key: 'Result',
        value:
          probs.home_win > probs.away_win
            ? 'Home'
            : probs.away_win > probs.home_win
            ? 'Away'
            : 'Draw',
      },
      { key: 'BTTS', value: probs.btts_yes > 0.5 ? 'Yes' : 'No' },
      { key: 'Goals', value: probs.over_2_5 > 0.5 ? 'Over 2.5' : 'Under 2.5' },
    ];

    await MatchAnalysis.updateOne(
      { match_id: String(m._id) },
      {
        $set: {
          match_id: String(m._id),
          home_team: home.name,
          away_team: away.name,
          date: m.date,
          tournament: m.tournament,
          best_market: bestMarket,
          probability: bestProb,
          confidence,
          score: bestScore,
          correct_score: correctScore,
          reason_short: top ? `${top.title}. ${top.text}` : null,
          reasons,
          markets,
          updated_at: new Date(),
        },
      },
      { upsert: true }
    );
    count++;
  }

  console.log(`✅ Warmed ${count} analyses (${daysAhead} days ahead)`);
  return count;
}

module.exports = { warmAnalysisCache };