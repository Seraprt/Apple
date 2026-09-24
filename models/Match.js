const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  event_id: { type: String, required: true, unique: true, index: true },
  home_team_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  away_team_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  date: { type: Date, required: true, index: true },
  tournament: { type: String, default: '' },
  stage: { type: String, default: 'group' },
  home_goals: { type: Number, default: null },
  away_goals: { type: Number, default: null },

  // Predictions (computed)
  home_win_prob: { type: Number, default: null },
  draw_prob: { type: Number, default: null },
  away_win_prob: { type: Number, default: null },
  confidence: { type: Number, default: null },
  home_xg: { type: Number, default: null },
  away_xg: { type: Number, default: null },
  predicted_correct_score: { type: String, default: null },
});

matchSchema.index({ date: 1, home_team_id: 1, away_team_id: 1 });

module.exports = mongoose.model('Match', matchSchema);