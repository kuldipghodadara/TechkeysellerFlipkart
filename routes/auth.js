const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db, Timestamp } = require('../firebase-config');
const { authenticateUser, requireLicense, getLicense, generateToken, deductCredit } = require('../middleware/auth');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { mobile, sellerName, gstNumber, email, password, confirmPassword } = req.body;
    if (!mobile || !sellerName || !email || !password || !confirmPassword) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' });

    if (!(await db.collection('users').where('mobile', '==', mobile).get()).empty) return res.status(409).json({ error: 'Mobile already registered' });
    if (!(await db.collection('users').where('email', '==', email.toLowerCase()).get()).empty) return res.status(409).json({ error: 'Email already registered' });

    const now = Timestamp.now();
    const ref = db.collection('users').doc();
    await ref.set({
      mobile, sellerName, gstNumber: gstNumber || null, email: email.toLowerCase(),
      passwordHash: await bcrypt.hash(password, 10),
      accountStatus: 'ACTIVE', totalCredits: 50, usedCredits: 0,
      createdAt: now, updatedAt: now
    });

    const token = generateToken(ref.id);
    res.json({
      success: true, token,
      user: { uid: ref.id, mobile, sellerName, gstNumber: gstNumber || null, email: email.toLowerCase(), accountStatus: 'ACTIVE', createdAt: new Date().toISOString() },
      license: { status: 'active', totalCredits: 50, usedCredits: 0, remainingCredits: 50, active: true }
    });
  } catch (err) { console.error('[Auth] Register:', err); res.status(500).json({ error: err.message }); }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { mobileOrEmail, password } = req.body;
    if (!mobileOrEmail || !password) return res.status(400).json({ error: 'Credentials required' });

    const field = mobileOrEmail.includes('@') ? 'email' : 'mobile';
    const val = field === 'email' ? mobileOrEmail.toLowerCase() : mobileOrEmail;
    const snap = await db.collection('users').where(field, '==', val).limit(1).get();
    if (snap.empty) return res.status(401).json({ error: 'Invalid credentials' });

    const doc = snap.docs[0]; const d = doc.data();
    if (['SUSPENDED', 'BLOCKED', 'DELETED'].includes(d.accountStatus)) return res.status(403).json({ error: `Account ${d.accountStatus.toLowerCase()}. Contact administrator.` });
    if (!await bcrypt.compare(password, d.passwordHash)) return res.status(401).json({ error: 'Invalid credentials' });

    await db.collection('users').doc(doc.id).update({ lastLogin: Timestamp.now(), updatedAt: Timestamp.now() });

    res.json({
      success: true, token: generateToken(doc.id),
      user: { uid: doc.id, mobile: d.mobile, sellerName: d.sellerName, gstNumber: d.gstNumber, email: d.email, accountStatus: d.accountStatus, createdAt: d.createdAt?.toDate?.()?.toISOString() || null },
      license: getLicense(d),
      assignedPlan: d.assignedPlan || null
    });
  } catch (err) { console.error('[Auth] Login:', err); res.status(500).json({ error: err.message }); }
});

// GET /api/auth/bootstrap — single startup call, returns everything
router.get('/bootstrap', authenticateUser, async (req, res) => {
  try {
    const d = req.user;
    const s = d.accountStatus;
    if (['SUSPENDED', 'BLOCKED', 'DELETED'].includes(s)) {
      return res.json({ success: false, kicked: true, reason: s.toLowerCase(), error: `Account ${s.toLowerCase()}` });
    }
    res.json({
      success: true,
      user: { uid: d.uid, mobile: d.mobile, sellerName: d.sellerName, gstNumber: d.gstNumber, email: d.email, accountStatus: d.accountStatus, createdAt: d.createdAt?.toDate?.()?.toISOString() || null },
      license: getLicense(d),
      assignedPlan: d.assignedPlan || null
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/auth/deduct-credit — called after successful accept/print/rtd
router.post('/deduct-credit', authenticateUser, requireLicense, async (req, res) => {
  try {
    const { count } = req.body;
    const result = await deductCredit(req.user.uid, count || 1);
    if (!result) return res.status(500).json({ error: 'Deduction failed' });
    res.json({ success: true, usedCredits: result.used, remainingCredits: result.remaining });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => { res.json({ success: true }); });

// PUT /api/auth/profile
router.put('/profile', authenticateUser, async (req, res) => {
  try {
    const { sellerName, gstNumber } = req.body;
    const u = { updatedAt: Timestamp.now() };
    if (sellerName) u.sellerName = sellerName;
    if (gstNumber !== undefined) u.gstNumber = gstNumber || null;
    await db.collection('users').doc(req.user.uid).update(u);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
