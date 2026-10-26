const mongoose = require('mongoose');

const dailyMetaSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true, index: true },
  booking_code: { type: String, default: '' },
  published: { type: Boolean, default: false },
  published_at: { type: Date, default: null },
  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('DailyMeta', dailyMetaSchema);