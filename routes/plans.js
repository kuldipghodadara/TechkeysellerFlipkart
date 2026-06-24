const express = require('express');
const router = express.Router();
const { db, Timestamp } = require('../firebase-config');
const { verifyAdmin } = require('../middleware/auth');

router.use(verifyAdmin);

// GET /api/plans — list all plans
router.get('/', async (req, res) => {
  try {
    const snap = await db.collection('plans').orderBy('credits', 'asc').get();
    const plans = [];
    snap.forEach(doc => plans.push({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null, updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || null }));
    res.json({ plans });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/plans/:id
router.get('/:id', async (req, res) => {
  try {
    const doc = await db.collection('plans').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Plan not found' });
    const d = doc.data();
    res.json({ id: doc.id, ...d, createdAt: d.createdAt?.toDate?.()?.toISOString() || null, updatedAt: d.updatedAt?.toDate?.()?.toISOString() || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/plans — create plan
router.post('/', async (req, res) => {
  try {
    const { planName, credits, price, costPerOrder, description } = req.body;
    if (!planName || !credits || price === undefined) return res.status(400).json({ error: 'planName, credits, price required' });
    const now = Timestamp.now();
    const ref = await db.collection('plans').add({
      planName, credits: parseInt(credits), price: parseFloat(price),
      costPerOrder: parseFloat(costPerOrder || (price / credits).toFixed(2)),
      status: 'ACTIVE', description: description || '',
      createdAt: now, updatedAt: now
    });
    res.json({ success: true, id: ref.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/plans/:id — update plan
router.put('/:id', async (req, res) => {
  try {
    const { planName, credits, price, costPerOrder, status, description } = req.body;
    const u = { updatedAt: Timestamp.now() };
    if (planName !== undefined) u.planName = planName;
    if (credits !== undefined) u.credits = parseInt(credits);
    if (price !== undefined) u.price = parseFloat(price);
    if (costPerOrder !== undefined) u.costPerOrder = parseFloat(costPerOrder);
    if (status !== undefined) u.status = status;
    if (description !== undefined) u.description = description;
    await db.collection('plans').doc(req.params.id).update(u);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/plans/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.collection('plans').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
