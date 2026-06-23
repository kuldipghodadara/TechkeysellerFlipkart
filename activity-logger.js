const { net } = require('electron');
const authService = require('./auth-service');

const BACKEND_URL = 'http://localhost:5000';

class ActivityLogger {
  async log(event, data = {}) {
    const user = authService.getUser();
    if (!user || !user.uid) return;

    const payload = {
      userId: user.uid,
      event,
      data,
      appVersion: '1.0.0'
    };

    try {
      const request = net.request({
        method: 'POST',
        url: `${BACKEND_URL}/api/logs/activity`,
        headers: { 'Content-Type': 'application/json' }
      });

      request.write(JSON.stringify(payload));
      request.on('response', () => {});
      request.on('error', (err) => {
        console.error('[ActivityLogger] Failed to send log:', err.message);
      });
      request.end();
    } catch (err) {
      // Silently fail - logging should never block the app
    }
  }
}

module.exports = new ActivityLogger();
