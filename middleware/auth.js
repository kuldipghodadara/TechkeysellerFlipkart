const jwt = require('jsonwebtoken');
const { db } = require('../firebase-config');

const JWT_SECRET = process.env.JWT_SECRET || 'seller-dashboard-secret-key-change-in-production';

function getLicense(userData) {
  const status = userData.accountStatus || 'ACTIVE';
  if (status === 'BLOCKED' || status === 'DELETED' || status === 'SUSPENDED') {
    return { status: status.toLowerCase(), totalCredits: 0, usedCredits: 0, remainingCredits: 0, active: false };
  }
  const total = userData.totalCredits || 0;
  const used = userData.usedCredits || 0;
  const remaining = Math.max(0, total - used);
  return { status: 'active', totalCredits: total, usedCredits: used, remainingCredits: remaining, active: remaining > 0 };
}

async function authenticateUser(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(h.split(' ')[1], JWT_SECRET);
    const doc = await db.collection('users').doc(decoded.uid).get();
    if (!doc.exists) return res.status(401).json({ error: 'User not found' });
    req.user = { uid: decoded.uid, ...doc.data() };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function requireLicense(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const lic = getLicense(req.user);
  req.license = lic;
  if (!lic.active) return res.status(403).json({ error: 'No credits remaining', license: lic });
  next();
}

async function verifyAdmin(req, res, next) {
  const k = req.headers['x-admin-key'];
  if (k === (process.env.ADMIN_KEY || 'admin-secret-key')) return next();
  return res.status(403).json({ error: 'Admin access denied' });
}

function generateToken(uid) {
  return jwt.sign({ uid }, JWT_SECRET, { expiresIn: '30d' });
}

async function deductCredit(uid, count = 1) {
  const ref = db.collection('users').doc(uid);
  const doc = await ref.get();
  if (!doc.exists) return false;
  const d = doc.data();
  const used = (d.usedCredits || 0) + count;
  const remaining = Math.max(0, (d.totalCredits || 0) - used);
  await ref.update({ usedCredits: used, updatedAt: require('../firebase-config').Timestamp.now() });
  return { used, remaining };
}

module.exports = { authenticateUser, requireLicense, verifyAdmin, getLicense, generateToken, deductCredit, JWT_SECRET };
