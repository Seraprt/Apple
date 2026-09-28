const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema(
  {
    team_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    position: {
      type: String,
      default: '', // GK, DEF, MID, FWD
    },
    importance: {
      type: Number,
      default: 0.5, // 0-1, importance to the team
      min: 0,
      max: 1,
    },
    available: {
      type: Boolean,
      default: true,
    },
    injury_note: {
      type: String,
      default: '',
    },
    external_id: {
      type: String,
      default: '',
      index: true,
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Player', playerSchema);