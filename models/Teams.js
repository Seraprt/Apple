const mongoose = require('mongoose');

const teamSchema = new mongoose.Schema({
  name: { type: String, required: true, index: true },
  short: { type: String, default: '' },       // e.g. ARS
  logo: { type: String, default: '' },        // crest URL
  league: { type: String, default: '' },
  country: { type: String, default: '' },
  color: { type: String, default: '#333333' },

  // Ratings
  attack_rating: { type: Number, default: 1.0 },
  defence_rating: { type: Number, default: 1.0 },
  elo_rating: { type: Number, default: 1500 },
  home_ppg: { type: Number, default: 1.5 },   // home points per game
  away_ppg: { type: Number, default: 1.0 },   // away points per game
  strength: { type: Number, default: 50 },

  external_id: { type: String, default: '', index: true },
  updated_at: { type: Date, default: Date.now },
});

teamSchema.index({ name: 'text', short: 'text' });

module.exports = mongoose.model('Team', teamSchema);