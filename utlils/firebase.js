const admin = require('firebase-admin');

let firebaseReady = false;

try {
  let serviceAccount = null;

  // Preferred: base64-encoded (safe for env vars)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(decoded);
  }
  // Fallback: raw JSON string (some users prefer this)
  else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }

  if (serviceAccount && serviceAccount.project_id && !admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseReady = true;
    console.log('✅ Firebase Admin initialised');
  } else {
    console.warn('⚠️ Firebase credentials not configured — Google login disabled');
  }
} catch (err) {
  console.error('❌ Firebase init error:', err.message);
}

async function verifyGoogleToken(idToken) {
  if (!firebaseReady) return null;
  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    console.error('Firebase verify error:', err.message);
    return null;
  }
}

module.exports = { admin, verifyGoogleToken, firebaseReady };