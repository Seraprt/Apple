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
    best_market: { type: String, default: null },        // e.g. "over_2.5"
    best_market_label: { type: String, default: null },  // e.g. "Over 2.5"
    probability: { type: Number, default: null },
    score: { type: Number, default: null },              // confidence × probability
    correct_score: { type: String, default: null },

    // ── Pick text (main label shown on card) ──
    pick: { type: String, default: null },

    // ── Secondary pick ──
    secondary_pick: {
      market: { type: String, default: null },
      label: { type: String, default: null },
      probability: { type: Number, default: null },
    },
    // Legacy alias (in case anything else reads it)
    secondary_market: { type: String, default: null },
    secondary_probability: { type: Number, default: null },

    // ── Reasons ──
    reason_short: { type: String, default: null },
    reasons: { type: Array, default: [] },

    // ── UI markets chips ──
    markets: { type: Array, default: [] },

    updated_at: { type: Date, default: Date.now },
  },
  { strict: true }   // keep strict, we've now declared everything
);

module.exports = mongoose.model('MatchAnalysis', analysisSchema);