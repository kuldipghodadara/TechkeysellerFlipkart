const express = require('express');
const router = express.Router();
const { db, auth, Timestamp } = require('../firebase-config');

// List all users with optional filters
router.get('/users', async (req, res) => {
  try {
    const { plan, limit = 50, offset = 0 } = req.query;

    let query = db.collection('users').orderBy('createdAt', 'desc');

    if (plan && plan !== 'all') {
      query = query.where('plan', '==', plan);
    }

    const snapshot = await query.limit(parseInt(limit)).offset(parseInt(offset)).get();

    const users = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      users.push({
        uid: doc.id,
        name: data.name,
        email: data.email,
        mobile: data.mobile,
        plan: data.plan,
        createdAt: data.createdAt?.toDate?.() || null,
        trialExpiresAt: data.trialExpiresAt?.toDate?.() || null,
        planExpiresAt: data.planExpiresAt?.toDate?.() || null,
        lastLogin: data.lastLogin?.toDate?.() || null
      });
    });

    res.json({ users, total: users.length });
  } catch (err) {
    console.error('[Admin] List users error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get single user
router.get('/users/:id', async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    const data = doc.data();
    res.json({
      uid: doc.id,
      ...data,
      createdAt: data.createdAt?.toDate?.() || null,
      trialExpiresAt: data.trialExpiresAt?.toDate?.() || null,
      planExpiresAt: data.planExpiresAt?.toDate?.() || null,
      lastLogin: data.lastLogin?.toDate?.() || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user plan/status
router.put('/users/:id', async (req, res) => {
  try {
    const { plan, planExpiresAt } = req.body;
    const updates = {};

    if (plan) updates.plan = plan;
    if (planExpiresAt) updates.planExpiresAt = Timestamp.fromDate(new Date(planExpiresAt));

    await db.collection('users').doc(req.params.id).update(updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get activity logs
router.get('/logs', async (req, res) => {
  try {
    const { limit = 100, userId } = req.query;

    let query = db.collection('activity_logs').orderBy('timestamp', 'desc');

    if (userId) {
      query = query.where('userId', '==', userId);
    }

    const snapshot = await query.limit(parseInt(limit)).get();

    const logs = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      logs.push({
        id: doc.id,
        ...data,
        timestamp: data.timestamp?.toDate?.() || null
      });
    });

    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get admin stats
router.get('/stats', async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();

    let total = 0, active = 0, trial = 0, expired = 0;
    usersSnapshot.forEach(doc => {
      total++;
      const plan = doc.data().plan;
      if (plan === 'active') active++;
      else if (plan === 'trial') trial++;
      else expired++;
    });

    res.json({ total, active, trial, expired });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
