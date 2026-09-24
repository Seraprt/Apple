const mongoose = require('mongoose');

// Caches the full analysis (markets + reasons) for a match
const analysisSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true, index: true },
  home_team: { type: String },
  away_team: { type: String },
  date: { type: Date, index: true },
  tournament: { type: String },

  best_market: { type: String },
  probability: { type: Number },
  confidence: { type: Number },
  score: { type: Number },
  correct_score: { type: String },

  secondary_market: { type: String, default: null },
  secondary_probability: { type: Number, default: null },

  reason_short: { type: String },       // 2-line plain English reason
  reasons: [{ type: Object }],          // array of {tone, tag, title, text}

  markets: [{ key: String, value: String }],

  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('MatchAnalysis', analysisSchema);