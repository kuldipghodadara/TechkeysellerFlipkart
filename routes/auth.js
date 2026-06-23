const express = require('express');
const router = express.Router();
const { db, auth, Timestamp } = require('../firebase-config');

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { name, email, mobile, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    // Create Firebase Auth user
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: name
    });

    // Create Firestore user document with 7-day trial
    const now = Timestamp.now();
    const trialExpiry = new Date();
    trialExpiry.setDate(trialExpiry.getDate() + 7);

    await db.collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      name,
      email,
      mobile: mobile || null,
      createdAt: now,
      trialExpiresAt: Timestamp.fromDate(trialExpiry),
      plan: 'trial',
      planExpiresAt: null,
      machineId: null,
      lastLogin: now
    });

    // Generate custom token for immediate login
    const token = await auth.createCustomToken(userRecord.uid);

    res.json({
      success: true,
      uid: userRecord.uid,
      token,
      plan: 'trial',
      trialExpiresAt: trialExpiry.toISOString()
    });
  } catch (err) {
    console.error('[Auth] Registration error:', err);
    if (err.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Firebase Admin SDK doesn't support password verification directly
    // The client app should use Firebase Client SDK for auth
    // Here we verify the user exists and return their license status
    const userRecord = await auth.getUserByEmail(email);

    // Get user document from Firestore
    const userDoc = await db.collection('users').doc(userRecord.uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    const userData = userDoc.data();

    // Update last login
    await db.collection('users').doc(userRecord.uid).update({
      lastLogin: Timestamp.now()
    });

    // Check license/trial status
    const licenseStatus = checkLicenseStatus(userData);

    // Generate custom token
    const token = await auth.createCustomToken(userRecord.uid);

    res.json({
      success: true,
      uid: userRecord.uid,
      token,
      ...licenseStatus,
      name: userData.name
    });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    if (err.code === 'auth/user-not-found') {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Verify token and get license status
router.post('/verify', async (req, res) => {
  try {
    const { token, uid } = req.body;

    if (!uid) {
      return res.status(400).json({ error: 'UID is required' });
    }

    const userDoc = await db.collection('users').doc(uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ valid: false, error: 'User not found' });
    }

    const userData = userDoc.data();
    const licenseStatus = checkLicenseStatus(userData);

    res.json({
      valid: licenseStatus.plan !== 'expired',
      ...licenseStatus,
      name: userData.name
    });
  } catch (err) {
    console.error('[Auth] Verify error:', err);
    res.status(500).json({ valid: false, error: err.message });
  }
});

// Forgot password
router.post('/forgot', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Generate password reset link
    const link = await auth.generatePasswordResetLink(email);

    // In production, send this via email service
    // For now, return success
    res.json({ success: true, message: 'Password reset link generated' });
  } catch (err) {
    console.error('[Auth] Forgot password error:', err);
    res.status(500).json({ error: err.message });
  }
});

function checkLicenseStatus(userData) {
  const now = new Date();

  // Check if active plan exists
  if (userData.plan === 'active' && userData.planExpiresAt) {
    const expiry = userData.planExpiresAt.toDate();
    if (expiry > now) {
      return {
        plan: 'active',
        expiresAt: expiry.toISOString(),
        daysRemaining: Math.ceil((expiry - now) / (1000 * 60 * 60 * 24))
      };
    }
  }

  // Check trial
  if (userData.trialExpiresAt) {
    const trialExpiry = userData.trialExpiresAt.toDate();
    if (trialExpiry > now) {
      return {
        plan: 'trial',
        expiresAt: trialExpiry.toISOString(),
        daysRemaining: Math.ceil((trialExpiry - now) / (1000 * 60 * 60 * 24))
      };
    }
  }

  return { plan: 'expired', expiresAt: null, daysRemaining: 0 };
}

module.exports = router;
