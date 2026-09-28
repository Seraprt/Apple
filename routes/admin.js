const express = require('express');
const { runIngestion } = require('../services/ingestion');
const Team = require('../models/Teams');
const Match = require('../models/Match');
const MatchAnalysis = require('../models/MatchAnalysis');
const { warmAnalysisCache } = require('../services/warmCache');
const CustomMatch = require('../models/CustomMatch');
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

module.exports = router;