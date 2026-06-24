const { net } = require('electron');
const path = require('path');
const fs = require('fs');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';
const LICENSE_MAX_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours

function getStorePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'auth-store.json');
}
function readStore() { try { const p = getStorePath(); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {} return {}; }
function writeStore(d) { try { fs.writeFileSync(getStorePath(), JSON.stringify(d, null, 2), 'utf8'); } catch {} }

class AuthService {
  constructor() {
    this.token = null;
    this.currentUser = null;
    this.currentLicense = null;
    this.assignedPlan = null;
    this.lastValidatedAt = 0;
    this._loaded = false;
  }

  _load() {
    if (this._loaded) return;
    const d = readStore();
    this.token = d.token || null;
    this.currentUser = d.user || null;
    this.currentLicense = d.license || null;
    this.assignedPlan = d.assignedPlan || null;
    this.lastValidatedAt = d.lastValidatedAt || 0;
    this._loaded = true;
  }

  _persist() {
    writeStore({
      token: this.token, user: this.currentUser, license: this.currentLicense,
      assignedPlan: this.assignedPlan, lastValidatedAt: this.lastValidatedAt
    });
  }

  isAuthenticated() { this._load(); return !!this.token && !!this.currentUser; }

  isLicenseActive() {
    this._load();
    if (!this.currentLicense) return false;
    if (this.currentLicense.status !== 'active') return false;
    if (this.currentLicense.remainingCredits <= 0) return false;
    return true;
  }

  isCacheExpired() {
    this._load();
    return (Date.now() - this.lastValidatedAt) > LICENSE_MAX_CACHE_MS;
  }

  getUser() { this._load(); return this.currentUser; }
  getLicense() { this._load(); return this.currentLicense; }
  getAssignedPlan() { this._load(); return this.assignedPlan; }

  async register(data) {
    const r = await this._req('POST', '/api/auth/register', data);
    if (r.success) {
      this.token = r.token; this.currentUser = r.user; this.currentLicense = r.license;
      this.assignedPlan = r.assignedPlan || null; this.lastValidatedAt = Date.now();
      this._persist();
    }
    return r;
  }

  async login(mobileOrEmail, password) {
    const r = await this._req('POST', '/api/auth/login', { mobileOrEmail, password });
    if (r.success) {
      this.token = r.token; this.currentUser = r.user; this.currentLicense = r.license;
      this.assignedPlan = r.assignedPlan || null; this.lastValidatedAt = Date.now();
      this._persist();
    }
    return r;
  }

  // Startup bootstrap: always tries network. Offline fallback only if cache < 24h old.
  async bootstrap() {
    this._load();
    if (!this.token || !this.currentUser) return { authenticated: false, reason: 'no_token' };

    try {
      const r = await this._reqAuth('GET', '/api/auth/bootstrap');

      if (r.error) {
        if (['User not found', 'Invalid or expired token', 'No token provided'].some(m => r.error.includes(m))) {
          this.logout();
          return { authenticated: false, reason: 'invalid', error: r.error };
        }
        // Backend returned error but not auth-fatal — treat as unreachable
        return this._offlineFallback();
      }

      if (r.kicked) {
        this.logout();
        return { authenticated: false, reason: r.reason, error: r.error };
      }

      if (r.success && r.user) {
        this.currentUser = r.user;
        this.currentLicense = r.license;
        this.assignedPlan = r.assignedPlan || null;
        this.lastValidatedAt = Date.now();
        this._persist();
        return { authenticated: true, user: r.user, license: r.license, assignedPlan: this.assignedPlan, validated: true };
      }

      return this._offlineFallback();
    } catch (err) {
      console.warn('[AuthService] Bootstrap network error:', err.message);
      return this._offlineFallback();
    }
  }

  _offlineFallback() {
    if (this.isCacheExpired()) {
      return {
        authenticated: true,
        user: this.currentUser,
        license: this.currentLicense,
        assignedPlan: this.assignedPlan,
        expired: true,
        validated: false,
        error: 'License cache expired. Connect to internet and restart.'
      };
    }
    return {
      authenticated: true,
      user: this.currentUser,
      license: this.currentLicense,
      assignedPlan: this.assignedPlan,
      offline: true,
      validated: false
    };
  }

  // Called after successful accept/print/rtd
  async deductCredit(count = 1) {
    this._load();
    try {
      const r = await this._reqAuth('POST', '/api/auth/deduct-credit', { count });
      if (r.success) {
        this.currentLicense.usedCredits = r.usedCredits;
        this.currentLicense.remainingCredits = r.remainingCredits;
        this.currentLicense.active = r.remainingCredits > 0;
        this._persist();
      }
      return r;
    } catch (err) {
      if (this.currentLicense) {
        this.currentLicense.usedCredits = (this.currentLicense.usedCredits || 0) + count;
        this.currentLicense.remainingCredits = Math.max(0, (this.currentLicense.totalCredits || 0) - this.currentLicense.usedCredits);
        this.currentLicense.active = this.currentLicense.remainingCredits > 0;
        this._persist();
      }
      return { success: false, error: err.message };
    }
  }

  async updateProfile(data) { return await this._reqAuth('PUT', '/api/auth/profile', data); }

  logout() {
    this.token = null; this.currentUser = null; this.currentLicense = null;
    this.assignedPlan = null; this.lastValidatedAt = 0; this._loaded = true;
    writeStore({});
  }

  _req(method, path, body) {
    return new Promise((resolve, reject) => {
      const r = net.request({ method, url: `${BACKEND_URL}${path}` });
      r.setHeader('Content-Type', 'application/json');
      if (body) r.write(JSON.stringify(body));
      r.on('response', res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Bad response')); } }); });
      r.on('error', reject); r.end();
    });
  }

  _reqAuth(method, path, body) {
    return new Promise((resolve, reject) => {
      const r = net.request({ method, url: `${BACKEND_URL}${path}` });
      r.setHeader('Content-Type', 'application/json');
      if (this.token) r.setHeader('Authorization', `Bearer ${this.token}`);
      if (body) r.write(JSON.stringify(body));
      r.on('response', res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Bad response')); } }); });
      r.on('error', reject); r.end();
    });
  }
}

module.exports = new AuthService();
