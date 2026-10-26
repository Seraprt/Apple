const express = require('express');
const { runIngestion } = require('../services/ingestion');
const Team = require('../models/Teams');
const Match = require('../models/Match');
const MatchAnalysis = require('../models/MatchAnalysis');
const DailyPick = require('../models/DailyPick');
const DailyMeta = require('../models/DailyMeta');
const { warmAnalysisCache } = require('../services/warmCache');
const CustomMatch = require('../models/CustomMatch');
const DailyMessage = require('../models/DailyMessage');
const User = require('../models/User');

const router = express.Router();

// Admin key middleware
router.use((req, res, next) => {
  const key = req.header('X-Admin-Key');
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

// State tracker
let _ingestRunning = false;
let _warmRunning = false;

// ── Start ingestion ──
router.post('/ingest', async (req, res) => {
  if (_ingestRunning) {
    return res.status(409).json({ message: 'Ingestion already running' });
  }
  _ingestRunning = true;

  runIngestion()
    .then(() => { _ingestRunning = false; })
    .catch((e) => { console.error('ingest error:', e); _ingestRunning = false; });

  res.json({ message: 'Ingestion started' });
});

// ── Warm analysis cache (compute & store for upcoming matches) ──
router.post('/warm-cache', async (req, res) => {
  if (_warmRunning) {
    return res.status(409).json({ message: 'Warm cache already running' });
  }
  _warmRunning = true;

  warmAnalysisCache()
    .then(() => { _warmRunning = false; })
    .catch((e) => { console.error('warm error:', e); _warmRunning = false; });

  res.json({ message: 'Cache warm started' });
});

// ── Status ──
router.get('/status', async (req, res) => {
  const [teamCount, matchCount, analysisCount] = await Promise.all([
    Team.countDocuments({}),
    Match.countDocuments({}),
    MatchAnalysis.countDocuments({}),
  ]);
  res.json({
    ingestion: _ingestRunning ? 'running' : 'idle',
    warmCache: _warmRunning ? 'running' : 'idle',
    teams: teamCount,
    matches: matchCount,
    analyses: analysisCount,
  });
});

// ── Clear analysis cache ──
router.post('/clear-cache', async (req, res) => {
  const result = await MatchAnalysis.deleteMany({});
  res.json({ message: `Cleared ${result.deletedCount} analyses` });
});


// ───── GET /api/admin/custom-matches ─────
router.get('/custom-matches', async (req, res) => {
  try {
    const matches = await CustomMatch.find().sort({ date: 1 }).lean();
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───── POST /api/admin/custom-matches ─────
router.post('/custom-matches', async (req, res) => {
  try {
    const {
      home_team_name,
      away_team_name,
      league,
      country,
      date,
      suggested_market,
      suggested_score,
      notes,
    } = req.body;

    if (!home_team_name || !away_team_name || !league || !date || !suggested_market) {
      return res.status(400).json({
        error: 'home_team_name, away_team_name, league, date, suggested_market are required',
      });
    }

    const match = new CustomMatch({
      home_team_name,
      away_team_name,
      league,
      country: country || '',
      date: new Date(date),
      suggested_market,
      suggested_score: suggested_score || '',
      notes: notes || '',
      active: true,
    });
    await match.save();

    res.status(201).json({ message: 'Custom match created', match });
  } catch (err) {
    console.error('custom match create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───── PUT /api/admin/custom-matches/:id ─────
router.put('/custom-matches/:id', async (req, res) => {
  try {
    const updated = await CustomMatch.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Updated', match: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───── DELETE /api/admin/custom-matches/:id ─────
router.delete('/custom-matches/:id', async (req, res) => {
  try {
    const deleted = await CustomMatch.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───── GET /api/admin/users-stats ─────
router.get('/users-stats', async (req, res) => {
  try {
    const [total, googleCount, emailCount, recentUsers] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ provider: 'google' }),
      User.countDocuments({ provider: 'email' }),
      User.find({})
        .sort({ createdAt: -1 })
        .limit(20)
        .select('username email provider createdAt avatar')
        .lean(),
    ]);

    res.json({
      total,
      google: googleCount,
      email: emailCount,
      other: Math.max(0, total - googleCount - emailCount),
      recent: recentUsers.map((u) => ({
        id: String(u._id),
        username: u.username || 'Unknown',
        email: u.email || '—',
        provider: u.provider || 'email',
        avatar: u.avatar || '',
        createdAt: u.createdAt,
      })),
    });
  } catch (err) {
    console.error('users-stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// DAILY PICKS BUILDER
// ══════════════════════════════════════════════

// ── GET /api/admin/daily-picks?date=YYYY-MM-DD ──
router.get('/daily-picks', async (req, res) => {
  try {
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'date required' });

    const [picks, meta] = await Promise.all([
      DailyPick.find({ date }).sort({ order: 1, created_at: 1 }).lean(),
      DailyMeta.findOne({ date }).lean(),
    ]);

    res.json({
      picks,
      meta: meta || {
        date,
        booking_code: '',
        published: false,
        published_at: null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/daily-picks/search?date=&q= ──
router.get('/daily-picks/search', async (req, res) => {
  try {
    const date = req.query.date;
    const q = (req.query.q || '').trim();
    if (!date) return res.status(400).json({ error: 'date required' });

    const start = new Date(date + 'T00:00:00.000Z');
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    const filter = { date: { $gte: start, $lt: end } };
    if (q) {
      filter.$or = [
        { home_team: { $regex: q, $options: 'i' } },
        { away_team: { $regex: q, $options: 'i' } },
        { tournament: { $regex: q, $options: 'i' } },
      ];
    }

    const analyses = await MatchAnalysis.find(filter).limit(50).lean();
    if (!analyses.length) return res.json({ results: [] });

    const matchIds = analyses.map((a) => a.match_id);
    const matches = await Match.find({ _id: { $in: matchIds } }).lean();
    const matchMap = {};
    matches.forEach((m) => {
      matchMap[String(m._id)] = m;
    });

    const teamIds = new Set();
    matches.forEach((m) => {
      teamIds.add(String(m.home_team_id));
      teamIds.add(String(m.away_team_id));
    });
    const teams = await Team.find({ _id: { $in: [...teamIds] } }).lean();
    const teamMap = {};
    teams.forEach((t) => {
      teamMap[String(t._id)] = t;
    });

    const existing = await DailyPick.find({ date }).select('match_id').lean();
    const existingIds = new Set(existing.map((p) => p.match_id));

    const results = analyses
      .map((a) => {
        const m = matchMap[a.match_id];
        if (!m) return null;
        const h = teamMap[String(m.home_team_id)];
        const aw = teamMap[String(m.away_team_id)];
        return {
          match_id: a.match_id,
          date: a.date,
          tournament: a.tournament,
          home_name: a.home_team,
          away_name: a.away_team,
          home_logo: h?.logo || '',
          away_logo: aw?.logo || '',
          best_pick: a.best_market_label || '',
          secondary_prediction: a.secondary_pick?.label || '',
          correct_score: a.correct_score || '',
          already_added: existingIds.has(a.match_id),
        };
      })
      .filter(Boolean);

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/daily-picks — add from system ──
router.post('/daily-picks', async (req, res) => {
  try {
    const { date, match_id } = req.body;
    if (!date || !match_id) {
      return res.status(400).json({ error: 'date and match_id required' });
    }

    const existing = await DailyPick.findOne({ date, match_id });
    if (existing) {
      return res.status(409).json({ error: 'Match already in this day' });
    }

    const analysis = await MatchAnalysis.findOne({ match_id }).lean();
    if (!analysis) return res.status(404).json({ error: 'Match analysis not found' });

    const match = await Match.findById(match_id).lean();
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const [home, away] = await Promise.all([
      Team.findById(match.home_team_id).lean(),
      Team.findById(match.away_team_id).lean(),
    ]);

    const count = await DailyPick.countDocuments({ date });

    const pick = await DailyPick.create({
      date,
      match_id,
      is_custom: false,
      home_name: analysis.home_team,
      away_name: analysis.away_team,
      home_logo: home?.logo || '',
      away_logo: away?.logo || '',
      league: analysis.tournament,
      match_time: match.date,
      secondary_prediction: analysis.secondary_pick?.label || '',
      correct_score: analysis.correct_score || '',
      order: count,
    });

    res.status(201).json({ pick });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/daily-picks/custom — add custom match ──
router.post('/daily-picks/custom', async (req, res) => {
  try {
    const {
      date, home_name, away_name, league, match_time,
      secondary_prediction, correct_score,
    } = req.body;

    if (!date || !home_name || !away_name) {
      return res.status(400).json({ error: 'date, home_name, away_name required' });
    }

    const count = await DailyPick.countDocuments({ date });

    const pick = await DailyPick.create({
      date,
      match_id: null,
      is_custom: true,
      home_name,
      away_name,
      home_logo: '',
      away_logo: '',
      league: league || '',
      match_time: match_time ? new Date(match_time) : null,
      secondary_prediction: secondary_prediction || '',
      correct_score: correct_score || '',
      order: count,
    });

    res.status(201).json({ pick });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/admin/daily-picks/:id ──
router.put('/daily-picks/:id', async (req, res) => {
  try {
    const { secondary_prediction, correct_score, order } = req.body;
    const update = {};
    if (secondary_prediction !== undefined) update.secondary_prediction = secondary_prediction;
    if (correct_score !== undefined) update.correct_score = correct_score;
    if (order !== undefined) update.order = order;

    const pick = await DailyPick.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    );
    if (!pick) return res.status(404).json({ error: 'Not found' });
    res.json({ pick });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/daily-picks/:id ──
router.delete('/daily-picks/:id', async (req, res) => {
  try {
    const deleted = await DailyPick.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ───── GET /api/admin/daily-message ─────
router.get('/daily-message', async (req, res) => {
  try {
    const msg = await DailyMessage.findOne().sort({ updated_at: -1 }).lean();
    res.json(msg || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───── PUT /api/admin/daily-message (create or replace) ─────
router.put('/daily-message', async (req, res) => {
  try {
    const { heading, body } = req.body;

    if (!heading || !body) {
      return res.status(400).json({ error: 'heading and body are required' });
    }

    // Single-message model: wipe old ones, save fresh
    await DailyMessage.deleteMany({});

    const msg = new DailyMessage({
      heading: heading.trim(),
      body: body.trim(),
      active: true,
      updated_at: new Date(),
    });

    await msg.save();

    res.json({ message: 'Daily message saved', dailyMessage: msg });
  } catch (err) {
    console.error('daily-message save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───── DELETE /api/admin/daily-message ─────
router.delete('/daily-message', async (req, res) => {
  try {
    const result = await DailyMessage.deleteMany({});
    res.json({ message: `Deleted ${result.deletedCount} daily message(s)` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/admin/daily-picks/meta/:date/booking-code ──
router.put('/daily-picks/meta/:date/booking-code', async (req, res) => {
  try {
    const { date } = req.params;
    const { booking_code } = req.body;

    const meta = await DailyMeta.findOneAndUpdate(
      { date },
      { $set: { booking_code: booking_code || '', updated_at: new Date() } },
      { new: true, upsert: true }
    );
    res.json({ meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/daily-picks/publish/:date ──
router.post('/daily-picks/publish/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const picks = await DailyPick.find({ date }).lean();
    if (!picks.length) return res.status(400).json({ error: 'No picks to publish' });

    const meta = await DailyMeta.findOneAndUpdate(
      { date },
      { $set: { published: true, published_at: new Date(), updated_at: new Date() } },
      { new: true, upsert: true }
    );
    res.json({ meta, count: picks.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/daily-picks/unpublish/:date ──
router.post('/daily-picks/unpublish/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const meta = await DailyMeta.findOneAndUpdate(
      { date },
      { $set: { published: false, updated_at: new Date() } },
      { new: true, upsert: true }
    );
    res.json({ meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───── GET /api/admin/activity-stats ─────
router.get('/activity-stats', async (req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);

    const [
      totalUsers,
      loggedInToday,
      onlineNow,
      onlineLast30,
      recentActive,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ lastLogin: { $gte: startOfToday } }),
      User.countDocuments({ lastSeen: { $gte: fiveMinAgo } }),
      User.countDocuments({ lastSeen: { $gte: thirtyMinAgo } }),
      User.find({ lastSeen: { $ne: null } })
        .sort({ lastSeen: -1 })
        .limit(20)
        .select('username email provider avatar lastLogin lastSeen')
        .lean(),
    ]);

    res.json({
      totalUsers,
      loggedInToday,
      onlineNow,
      onlineLast30,
      recentActive: recentActive.map((u) => ({
        id: String(u._id),
        username: u.username || 'Unknown',
        email: u.email || '—',
        provider: u.provider || 'email',
        avatar: u.avatar || '',
        lastLogin: u.lastLogin,
        lastSeen: u.lastSeen,
      })),
    });
  } catch (err) {
    console.error('activity-stats error:', err);
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;