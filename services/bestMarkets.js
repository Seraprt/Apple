// ══════════════════════════════════════════════
// services/bestMarkets.js
// Returns best picks for a market category + historical accuracy
// ══════════════════════════════════════════════

const Match = require('../models/Match');
const Team = require('../models/Teams');
const MatchAnalysis = require('../models/MatchAnalysis');
const { getCategoryAccuracy, pickBestInCategory } = require('./marketAccuracy');
const { formatMarketLabel } = require('./predictionEngine');

async function getBestMarkets(type, days = 7, limit = 20) {
  const accuracy = await getCategoryAccuracy();
  const categoryAcc = accuracy[type] || { hits: 0, total: 0, rate: null };

  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const matches = await Match.find({ date: { $gte: now, $lte: end } })
    .sort({ date: 1 })
    .limit(500)
    .lean();

  if (!matches.length) {
    return {
      type,
      category_accuracy: categoryAcc,
      picks: [],
      total_candidates: 0,
    };
  }

  const ids = matches.map((m) => String(m._id));
  const analyses = await MatchAnalysis.find({ match_id: { $in: ids } }).lean();
  const map = {};
  analyses.forEach((a) => { map[a.match_id] = a; });

  const teamIds = new Set();
  matches.forEach((m) => {
    teamIds.add(String(m.home_team_id));
    teamIds.add(String(m.away_team_id));
  });
  const teams = await Team.find({ _id: { $in: [...teamIds] } })
    .select('name short logo')
    .lean();
  const teamMap = {};
  teams.forEach((t) => { teamMap[String(t._id)] = t; });

  const picks = [];
  for (const m of matches) {
    const a = map[String(m._id)];
    if (!a || !a.markets_full) continue;

    const best = pickBestInCategory(a.markets_full, type);
    if (!best) continue;

    const home = teamMap[String(m.home_team_id)];
    const away = teamMap[String(m.away_team_id)];
    if (!home || !away) continue;

    const conf = a.confidence ?? 0.5;
    picks.push({
      match_id: String(m._id),
      date: m.date,
      tournament: m.tournament,
      home: { id: home._id, name: home.name, short: home.short, logo: home.logo },
      away: { id: away._id, name: away.name, short: away.short, logo: away.logo },
      market_key: best.key,
      market_label: formatMarketLabel(best.key),
      probability: +best.prob.toFixed(4),
      confidence: +conf.toFixed(3),
      score: +(best.prob * conf).toFixed(4),
      correct_score: a.correct_score || null,
    });
  }

  picks.sort((a, b) => b.score - a.score);

  return {
    type,
    category_accuracy: categoryAcc,
    picks: picks.slice(0, limit),
    total_candidates: picks.length,
  };
}

module.exports = { getBestMarkets };