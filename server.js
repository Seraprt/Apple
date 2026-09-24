require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const authRoutes = require('./routes/auth');
const teamRoutes = require('./routes/teams');
const matchRoutes = require('./routes/matches');
const predictionRoutes = require('./routes/predictions');
const adminRoutes = require('./routes/admin');

const app = express();

// ───── CORS ─────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8100',   // Capacitor
  'capacitor://localhost',
  'https://localhost',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Also allow all render.com subdomains in prod
    if (origin.endsWith('.onrender.com')) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));

// ───── Health check ─────
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'formline-backend',
    time: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ───── Routes ─────
app.use('/api/auth', authRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/predictions', predictionRoutes);
app.use('/api/admin', adminRoutes);

// ───── Keep-alive (Render free tier) ─────
const KEEP_ALIVE_INTERVAL = 4 * 60 * 1000;
function keepAlive() {
  const host = process.env.RENDER_EXTERNAL_HOSTNAME;
  if (!host) return;
  fetch(`https://${host}/health`)
    .then((r) => {
      if (r.ok) console.log(`✅ Keep-alive ping at ${new Date().toISOString()}`);
    })
    .catch((err) => console.log(`⚠️ Keep-alive error: ${err.message}`));
}
setInterval(keepAlive, KEEP_ALIVE_INTERVAL);

// ───── Scheduled warm-cache (every 6 hours) ─────
function scheduleWarmCache() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  const run = async () => {
    try {
      const { warmAnalysisCache } = require('./services/warmCache');
      console.log('🔥 Scheduled warm-cache starting...');
      await warmAnalysisCache(14);
      console.log('✅ Scheduled warm-cache done');
    } catch (err) {
      console.error('❌ Warm-cache error:', err.message);
    }
  };

  // First run 30s after startup (let things settle)
  setTimeout(run, 30 * 1000);
  // Then every 6 hours
  setInterval(run, SIX_HOURS);
}

// ───── Start ─────
const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Formline backend running on port ${PORT}`);

      // Start keep-alive in production
      if (process.env.RENDER_EXTERNAL_HOSTNAME) {
        setTimeout(keepAlive, 5000);
      }

      // Start warm-cache scheduler
      scheduleWarmCache();
    });
  })
  .catch((err) => {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  });