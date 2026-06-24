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
const profileRoutes = require('./routes/profile');
const plansRoutes = require('./routes/plans');

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/plans', plansRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend service is running' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend Server running on port ${PORT}`);
});
