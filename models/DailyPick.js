const mongoose = require('mongoose');

const dailyPickSchema = new mongoose.Schema({
  date: { type: String, required: true, index: true }, // YYYY-MM-DD
  match_id: { type: String, default: null },           // null for custom
  is_custom: { type: Boolean, default: false },
  home_name: { type: String, required: true },
  away_name: { type: String, required: true },
  home_logo: { type: String, default: '' },
  away_logo: { type: String, default: '' },
  league: { type: String, default: '' },
  match_time: { type: Date, default: null },
  secondary_prediction: { type: String, default: '' },
  correct_score: { type: String, default: '' },
  order: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now },
});

dailyPickSchema.index({ date: 1, order: 1 });

module.exports = mongoose.model('DailyPick', dailyPickSchema);