// ══════════════════════════════════════════════
// services/marketAccuracy.js
// Computes per-category historical hit rate (under/over/dc/1x2)
// from finished matches with cached analyses
// ══════════════════════════════════════════════

const Match = require('../models/Match');
const MatchAnalysis = require('../models/MatchAnalysis');
const { evaluateMarket } = require('./accuracyStats');

const CATEGORY_FILTERS = {
  under: (k) => /^under_/.test(k),
  over: (k) => /^over_/.test(k),
  dc: (k) => ['1X', 'X2', '12'].includes(k),
  '1x2': (k) => ['home_win', 'draw', 'away_win'].includes(k),
};

function pickBestInCategory(marketsFull, category) {
  const filter = CATEGORY_FILTERS[category];
  if (!filter) return null;

  let best = null;
  for (const [key, prob] of Object.entries(marketsFull || {})) {
    if (!filter(key)) continue;
    if (typeof prob !== 'number') continue;
    if (!best || prob > best.prob) best = { key, prob };
  }
  return best;
}

async function computeCategoryAccuracy() {
  const matches = await Match.find({
    home_goals: { $ne: null },
    away_goals: { $ne: null },
  })
    .select('_id home_goals away_goals')
    .lean();

  if (!matches.length) {
    return {
      under: { hits: 0, total: 0, rate: null },
      over: { hits: 0, total: 0, rate: null },
      dc: { hits: 0, total: 0, rate: null },
      '1x2': { hits: 0, total: 0, rate: null },
    };
  }

  const ids = matches.map((m) => String(m._id));
  const analyses = await MatchAnalysis.find({ match_id: { $in: ids } })
    .select('match_id markets_full')
    .lean();
  const map = {};
  analyses.forEach((a) => { map[a.match_id] = a; });

  const cats = {
    under: { hits: 0, total: 0 },
    over: { hits: 0, total: 0 },
    dc: { hits: 0, total: 0 },
    '1x2': { hits: 0, total: 0 },
  };

  for (const m of matches) {
    const a = map[String(m._id)];
    if (!a || !a.markets_full) continue;

    for (const cat of Object.keys(cats)) {
      const best = pickBestInCategory(a.markets_full, cat);
      if (!best) continue;
      const hit = evaluateMarket(best.key, m.home_goals, m.away_goals);
      if (hit === null) continue;
      cats[cat].total++;
      if (hit) cats[cat].hits++;
    }
  }

  const out = {};
  for (const [cat, b] of Object.entries(cats)) {
    out[cat] = {
      hits: b.hits,
      total: b.total,
      rate: b.total > 0 ? +((b.hits / b.total) * 100).toFixed(1) : null,
    };
  }
  return out;
}

// ── Cache (30 min) ──
let _cache = null;
let _cacheAt = 0;
const TTL = 30 * 60 * 1000;

async function getCategoryAccuracy(force = false) {
  if (!force && _cache && Date.now() - _cacheAt < TTL) {
    return _cache;
  }
  _cache = await computeCategoryAccuracy();
  _cacheAt = Date.now();
  return _cache;
}

module.exports = { getCategoryAccuracy, computeCategoryAccuracy, pickBestInCategory };