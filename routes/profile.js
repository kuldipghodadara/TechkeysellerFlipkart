const express = require('express');
const router = express.Router();
const { db, Timestamp } = require('../firebase-config');
const { authenticateUser, getLicense } = require('../middleware/auth');

router.use(authenticateUser);

// GET /api/profile
router.get('/', async (req, res) => {
  try {
    const d = req.user;
    res.json({
      user: { uid: d.uid, sellerName: d.sellerName, mobile: d.mobile, gstNumber: d.gstNumber, email: d.email, accountStatus: d.accountStatus, createdAt: d.createdAt?.toDate?.()?.toISOString() || null },
      license: getLicense(d)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/profile/update
router.put('/update', async (req, res) => {
  try {
    const { sellerName, gstNumber } = req.body;
    const u = { updatedAt: Timestamp.now() };
    if (sellerName !== undefined) u.sellerName = sellerName;
    if (gstNumber !== undefined) u.gstNumber = gstNumber || null;
    await db.collection('users').doc(req.user.uid).update(u);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
