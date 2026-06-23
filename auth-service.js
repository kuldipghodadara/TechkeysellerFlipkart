const { net } = require('electron');
const path = require('path');
const fs = require('fs');

const BACKEND_URL = 'http://localhost:5000';

function getStorePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'auth-store.json');
}

function readStore() {
  try {
    const filePath = getStorePath();
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function writeStore(data) {
  try {
    fs.writeFileSync(getStorePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

class AuthService {
  constructor() {
    this.currentUser = null;
  }

  _loadUser() {
    if (this.currentUser) return;
    const data = readStore();
    this.currentUser = data.user || null;
  }

  isAuthenticated() {
    this._loadUser();
    if (!this.currentUser) return false;
    if (this.currentUser.plan === 'expired') return false;
    if (this.currentUser.expiresAt) {
      return new Date(this.currentUser.expiresAt) > new Date();
    }
    return true;
  }

  getUser() {
    this._loadUser();
    return this.currentUser;
  }

  async login(email, password) {
    const response = await this._request('POST', '/api/auth/login', { email, password });

    if (response.success) {
      this.currentUser = {
        uid: response.uid,
        name: response.name,
        email,
        token: response.token,
        plan: response.plan,
        expiresAt: response.expiresAt,
        daysRemaining: response.daysRemaining
      };
      writeStore({ user: this.currentUser });
    }

    return response;
  }

  async register(name, email, mobile, password) {
    const response = await this._request('POST', '/api/auth/register', { name, email, mobile, password });

    if (response.success) {
      this.currentUser = {
        uid: response.uid,
        name,
        email,
        token: response.token,
        plan: response.plan,
        expiresAt: response.trialExpiresAt,
        daysRemaining: 7
      };
      writeStore({ user: this.currentUser });
    }

    return response;
  }

  async verifyLicense() {
    this._loadUser();
    if (!this.currentUser || !this.currentUser.uid) {
      return { valid: false, error: 'Not logged in' };
    }

    try {
      const response = await this._request('POST', '/api/auth/verify', {
        uid: this.currentUser.uid,
        token: this.currentUser.token
      });

      if (response.valid) {
        this.currentUser.plan = response.plan;
        this.currentUser.expiresAt = response.expiresAt;
        this.currentUser.daysRemaining = response.daysRemaining;
        writeStore({ user: this.currentUser });
      }

      return response;
    } catch (err) {
      return { valid: this.isAuthenticated(), offline: true };
    }
  }

  logout() {
    this.currentUser = null;
    writeStore({});
  }

  _request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const request = net.request({
        method,
        url: `${BACKEND_URL}${urlPath}`,
        headers: { 'Content-Type': 'application/json' }
      });

      if (body) {
        request.write(JSON.stringify(body));
      }

      request.on('response', (response) => {
        let data = '';
        response.on('data', (chunk) => data += chunk.toString());
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            reject(new Error('Invalid response from server'));
          }
        });
      });

      request.on('error', (err) => {
        reject(err);
      });

      request.end();
    });
  }
}

module.exports = new AuthService();
