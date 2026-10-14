const mongoose = require('mongoose');

const analysisSchema = new mongoose.Schema(
  {
    match_id: { type: String, required: true, unique: true, index: true },
    home_team: { type: String },
    away_team: { type: String },
    date: { type: Date, index: true },
    tournament: { type: String },

    // ── 1X2 probabilities ──
    home_win_prob: { type: Number, default: null },
    draw_prob: { type: Number, default: null },
    away_win_prob: { type: Number, default: null },
    confidence: { type: Number, default: null },

    // ── Best market ──
    best_market: { type: String, default: null },
    best_market_label: { type: String, default: null },
    probability: { type: Number, default: null },
    score: { type: Number, default: null },
    correct_score: { type: String, default: null },

    // ── Pick ──
    pick: { type: String, default: null },

    // ── Secondary pick ──
    secondary_pick: {
      market: { type: String, default: null },
      label: { type: String, default: null },
      probability: { type: Number, default: null },
    },
    secondary_market: { type: String, default: null },
    secondary_probability: { type: Number, default: null },

    // ── Reasons ──
    reason_short: { type: String, default: null },
    reasons: { type: Array, default: [] },

    // ── UI markets chips (list view) ──
    markets: { type: Array, default: [] },

    // ══════════════════════════════════════════
    // ── PR 1 EXTENSIONS (detail page data) ──
    // ══════════════════════════════════════════

    // Full market probability map (all ~60 keys)
    markets_full: { type: Object, default: {} },

    // Top 20 correct scores with probabilities
    correct_score_grid: { type: Array, default: [] },

    // Home +2/+3, Away +2/+3 with probability & confidence
    handicap_highlights: { type: Object, default: {} },

    // Detail page extras
    form_data: { type: Object, default: {} },        // { home: [...], away: [...] }
    h2h_data: { type: Array, default: [] },           // last 5 meetings
    splits: { type: Object, default: {} },            // { home: {...}, away: {...} }
    factor_bars: { type: Array, default: [] },        // 9 factors, normalized 0-1

    updated_at: { type: Date, default: Date.now },
  },
  { strict: true }
);

module.exports = mongoose.model('MatchAnalysis', analysisSchema);