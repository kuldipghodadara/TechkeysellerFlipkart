const express = require('express');
const router = express.Router();
const { db, Timestamp } = require('../firebase-config');

// Receive activity logs from Electron app
router.post('/activity', async (req, res) => {
  try {
    const { userId, event, data, appVersion } = req.body;

    if (!userId || !event) {
      return res.status(400).json({ error: 'userId and event are required' });
    }

    await db.collection('activity_logs').add({
      userId,
      event,
      data: data || {},
      appVersion: appVersion || 'unknown',
      timestamp: Timestamp.now()
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[Logs] Activity log error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
