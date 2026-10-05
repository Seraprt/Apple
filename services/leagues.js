// ══════════════════════════════════════════════
// services/leagues.js
// Centralizes league name normalization + tier quality
// ══════════════════════════════════════════════

// ── Aliases: what the API calls it → what we display/store ──
const LEAGUE_NAME_ALIASES = {
  // ── La Liga (Spanish + English variants) ──
  'primera division': 'La Liga',
  'premier division': 'La Liga',       // ← ADDED (this was the miss)
  'laliga': 'La Liga',
  'la liga santander': 'La Liga',
  'spanish la liga': 'La Liga',

  // ── Serie A ──
  'serie a tim': 'Serie A',
  'italian serie a': 'Serie A',

  // ── Bundesliga ──
  '1. bundesliga': 'Bundesliga',
  'german bundesliga': 'Bundesliga',

  // ── Ligue 1 ──
  'ligue 1 uber eats': 'Ligue 1',
  'french ligue 1': 'Ligue 1',

  // ── Premier League ──
  'english premier league': 'Premier League',
  'epl': 'Premier League',

  // ── Champions League ──
  'uefa champions league': 'Champions League',
  'champions league': 'Champions League',

  // ── Europa League ──
  'uefa europa league': 'Europa League',
  'europa league': 'Europa League',
};

// ── Tier quality multipliers ──
const LEAGUE_TIERS = {
  // Top 5 European
  'premier league': 1.00,
  'la liga': 0.98,
  'serie a': 0.97,
  'bundesliga': 0.98,
  'ligue 1': 0.95,
  'champions league': 1.02,
  'europa league': 0.98,

  // Second tier European
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

  // Non-European top flights
  'brasileirao': 0.80,
  'campeonato brasileiro': 0.80,
  'argentine primera division': 0.78,
  'liga mx': 0.76,
  'mls': 0.70,
  'major league soccer': 0.70,
  'saudi pro league': 0.72,
  'j1 league': 0.74,
  'k league 1': 0.72,

  // Fallback
  default: 0.80,
};

function normalizeLeague(name) {
  if (!name) return '';
  const key = name.toLowerCase().trim();
  return LEAGUE_NAME_ALIASES[key] || name;
}

function getTierFactor(league) {
  if (!league) return LEAGUE_TIERS.default;
  const normalized = normalizeLeague(league);
  const l = normalized.toLowerCase().trim();
  return LEAGUE_TIERS[l] ?? LEAGUE_TIERS.default;
}

module.exports = {
  LEAGUE_TIERS,
  LEAGUE_NAME_ALIASES,
  normalizeLeague,
  getTierFactor,
};