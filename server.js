const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase
require('./firebase-config');

// Routes
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const logsRoutes = require('./routes/logs');

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/logs', logsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend service is running' });
});

// Legacy license endpoint (backward compatibility during transition)
app.post('/api/license/verify', (req, res) => {
  const { licenseKey } = req.body;
  if (licenseKey === 'VALID-1234') {
    res.json({ valid: true, expires: '2027-01-01' });
  } else {
    res.status(401).json({ valid: false, message: 'Invalid License Key' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend Server running on port ${PORT}`);
});
