const express = require('express');
const { runIngestion } = require('../services/ingestion');
const Team = require('../models/Team');
const Match = require('../models/Match');
const MatchAnalysis = require('../models/MatchAnalysis');
const { warmAnalysisCache } = require('../services/warmCache');

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

module.exports = router;