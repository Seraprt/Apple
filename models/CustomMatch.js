const mongoose = require('mongoose');

const customMatchSchema = new mongoose.Schema({
  home_team_name: { type: String, required: true, trim: true },
  away_team_name: { type: String, required: true, trim: true },
  league: { type: String, required: true, trim: true },
  country: { type: String, default: '' },
  date: { type: Date, required: true, index: true },
  suggested_market: { type: String, required: true },
  suggested_score: { type: String, default: '' },   // optional, e.g. "2-1"
  notes: { type: String, default: '' },             // optional short note
  active: { type: Boolean, default: true },
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('CustomMatch', customMatchSchema);