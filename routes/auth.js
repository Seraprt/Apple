const express = require('express');
const jwt = require('jsonwebtoken');
const validator = require('validator');
const User = require('../models/User');
const { verifyGoogleToken, firebaseReady } = require('../utils/firebase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Long-lived token (100 years) — like Flash Score, stays until device clears data
function makeToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '36500d' });
}

function userPayload(user) {
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    provider: user.provider,
  };
}

// ───── POST /api/auth/signup ─────
router.post('/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (!validator.isEmail(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) return res.status(400).json({ error: 'Email or username already taken' });

    const user = new User({ username, email, password, provider: 'email' });
    await user.save();

    const token = makeToken(user._id);
    res.status(201).json({ token, user: userPayload(user) });
  } catch (err) {
    console.error('signup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───── POST /api/auth/login ─────
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Identifier and password required' });
    }

    const user = await User.findOne({
      $or: [{ email: identifier.toLowerCase() }, { username: identifier }],
    });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.password) {
      return res.status(400).json({ error: 'This account uses Google sign-in. Please use Google.' });
    }

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = makeToken(user._id);
    res.json({ token, user: userPayload(user) });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───── POST /api/auth/google-login ─────
router.post('/google-login', async (req, res) => {
  try {
    if (!firebaseReady) {
      return res.status(503).json({ error: 'Google login not configured' });
    }
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken required' });

    const decoded = await verifyGoogleToken(idToken);
    if (!decoded || !decoded.email) {
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    let user = await User.findOne({ email: decoded.email.toLowerCase() });
    if (!user) {
      // Create new Google user
      let username = decoded.name?.replace(/\s+/g, '').toLowerCase() || decoded.email.split('@')[0];
      // Ensure unique username
      const taken = await User.findOne({ username });
      if (taken) username = username + Math.floor(Math.random() * 9999);

      user = new User({
        username,
        email: decoded.email.toLowerCase(),
        provider: 'google',
        googleUid: decoded.uid,
        avatar: decoded.picture || '',
      });
      await user.save();
    }

    const token = makeToken(user._id);
    res.json({ token, user: userPayload(user) });
  } catch (err) {
    console.error('google-login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───── GET /api/auth/me ─────
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: userPayload(req.user) });
});

module.exports = router;