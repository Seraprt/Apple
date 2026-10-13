const mongoose = require('mongoose');

const dailyMessageSchema = new mongoose.Schema(
  {
    heading: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    updated_at: { type: Date, default: Date.now },
  },
  { strict: true }
);

module.exports = mongoose.model('DailyMessage', dailyMessageSchema);