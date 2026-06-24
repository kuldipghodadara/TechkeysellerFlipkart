const express = require('express');
const router = express.Router();
const { db, Timestamp } = require('../firebase-config');
const { verifyAdmin, getLicense } = require('../middleware/auth');

router.use(verifyAdmin);

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const snap = await db.collection('users').get();
    let total = 0, active = 0, noCredits = 0, blocked = 0;
    snap.forEach(doc => {
      total++;
      const d = doc.data();
      if (['BLOCKED', 'SUSPENDED', 'DELETED'].includes(d.accountStatus)) { blocked++; return; }
      const lic = getLicense(d);
      if (lic.active) active++; else noCredits++;
    });
    res.json({ total, active, noCredits, blocked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/users
router.get('/users', async (req, res) => {
  try {
    const { status, limit = 200, offset = 0 } = req.query;
    const snap = await db.collection('users').orderBy('createdAt', 'desc').limit(parseInt(limit)).offset(parseInt(offset)).get();
    const users = [];
    snap.forEach(doc => {
      const d = doc.data();
      const lic = getLicense(d);
      if (status && status !== 'all') {
        if (status === 'active' && !lic.active) return;
        if (status === 'nocredits' && (lic.active || ['BLOCKED','SUSPENDED','DELETED'].includes(d.accountStatus))) return;
        if (status === 'blocked' && !['BLOCKED','SUSPENDED','DELETED'].includes(d.accountStatus)) return;
      }
      users.push({
        uid: doc.id, sellerName: d.sellerName || '-', mobile: d.mobile || '-', email: d.email, gstNumber: d.gstNumber || '-',
        accountStatus: d.accountStatus || 'ACTIVE',
        totalCredits: d.totalCredits || 0, usedCredits: d.usedCredits || 0, remainingCredits: lic.remainingCredits,
        licenseActive: lic.active,
        assignedPlan: d.assignedPlan || null,
        createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
        lastLogin: d.lastLogin?.toDate?.()?.toISOString() || null,
        updatedAt: d.updatedAt?.toDate?.()?.toISOString() || null
      });
    });
    res.json({ users, total: users.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/users/:id/set-credits
router.post('/users/:id/set-credits', async (req, res) => {
  try {
    const { totalCredits } = req.body;
    if (totalCredits === undefined) return res.status(400).json({ error: 'totalCredits required' });
    await db.collection('users').doc(req.params.id).update({ totalCredits: parseInt(totalCredits), updatedAt: Timestamp.now() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/users/:id/add-credits
router.post('/users/:id/add-credits', async (req, res) => {
  try {
    const { credits } = req.body;
    if (!credits) return res.status(400).json({ error: 'credits required' });
    const doc = await db.collection('users').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const current = doc.data().totalCredits || 0;
    await db.collection('users').doc(req.params.id).update({ totalCredits: current + parseInt(credits), updatedAt: Timestamp.now() });
    res.json({ success: true, newTotal: current + parseInt(credits) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/users/:id/reset-usage
router.post('/users/:id/reset-usage', async (req, res) => {
  try {
    await db.collection('users').doc(req.params.id).update({ usedCredits: 0, updatedAt: Timestamp.now() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/users/:id/assign-plan
router.post('/users/:id/assign-plan', async (req, res) => {
  try {
    const { planId } = req.body;
    if (!planId) return res.status(400).json({ error: 'planId required' });
    const planDoc = await db.collection('plans').doc(planId).get();
    if (!planDoc.exists) return res.status(404).json({ error: 'Plan not found' });
    const plan = planDoc.data();
    await db.collection('users').doc(req.params.id).update({
      assignedPlan: { planId, planName: plan.planName, credits: plan.credits, price: plan.price, costPerOrder: plan.costPerOrder },
      totalCredits: plan.credits,
      usedCredits: 0,
      updatedAt: Timestamp.now()
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/users/:id/block
router.post('/users/:id/block', async (req, res) => {
  try { await db.collection('users').doc(req.params.id).update({ accountStatus: 'BLOCKED', updatedAt: Timestamp.now() }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/users/:id/unblock', async (req, res) => {
  try { await db.collection('users').doc(req.params.id).update({ accountStatus: 'ACTIVE', updatedAt: Timestamp.now() }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/users/:id/delete', async (req, res) => {
  try { await db.collection('users').doc(req.params.id).update({ accountStatus: 'DELETED', updatedAt: Timestamp.now() }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/users/:id/activate', async (req, res) => {
  try { await db.collection('users').doc(req.params.id).update({ accountStatus: 'ACTIVE', updatedAt: Timestamp.now() }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// Activity logs
router.get('/logs', async (req, res) => {
  try {
    const { limit = 100, userId } = req.query;
    let q = db.collection('activity_logs').orderBy('timestamp', 'desc');
    if (userId) q = q.where('userId', '==', userId);
    const snap = await q.limit(parseInt(limit)).get();
    const logs = [];
    snap.forEach(doc => { const d = doc.data(); logs.push({ id: doc.id, ...d, timestamp: d.timestamp?.toDate?.()?.toISOString() || null }); });
    res.json({ logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
