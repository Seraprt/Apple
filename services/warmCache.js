const Match = require('../models/Match');
const Team = require('../models/Teams');                  // ← FIXED
const MatchAnalysis = require('../models/MatchAnalysis');
const { analyzeMatch } = require('./predictionEngine');

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

  let count = 0;

  for (const m of matches) {
    const home = teamMap[String(m.home_team_id)];
    const away = teamMap[String(m.away_team_id)];
    if (!home || !away) continue;

    try {
      const result = await analyzeMatch(m, home, away);

      await MatchAnalysis.updateOne(
        { match_id: String(m._id) },
        {
          $set: {
            match_id: String(m._id),
            home_team: home.name,
            away_team: away.name,
            date: m.date,
            tournament: m.tournament,

            // Core
            home_win_prob: result.home_win_prob,
            draw_prob: result.draw_prob,
            away_win_prob: result.away_win_prob,
            confidence: result.confidence,

            // Market + score
            best_market: result.best_market?.market || null,
            best_market_label: result.best_market?.label || null,
            probability: result.best_market?.probability || null,
            score: result.best_market?.score || null,
            correct_score: result.predicted_correct_score,

            // Picks
            pick: result.pick,
            secondary_pick: result.secondary_pick || null,

            // Reasons + UI data
            reason_short: result.reason_short,
            reasons: result.reasons,
            markets: result.markets,

            updated_at: new Date(),
          },
        },
        { upsert: true }
      );

      count++;
    } catch (err) {
      console.error(`warm error for match ${m._id}:`, err.message);
    }
  }

  console.log(`✅ Warmed ${count} analyses (${daysAhead} days ahead)`);
  return count;
}

module.exports = { warmAnalysisCache };