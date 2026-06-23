const fs = require('fs');
const path = require('path');

const SERVICE_NAME = 'TechKeySeller';
let keytar = null;

try {
  keytar = require('keytar');
} catch (e) {
  console.warn('[SecureStorage] keytar not available, falling back to file storage');
}

class SecureStorage {
  constructor() {
    this._storePath = null;
  }

  _getStorePath() {
    if (!this._storePath) {
      const { app } = require('electron');
      this._storePath = path.join(app.getPath('userData'), 'accounts.json');
    }
    return this._storePath;
  }

  _readStore() {
    try {
      const p = this._getStorePath();
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {}
    return { accounts: [] };
  }

  _writeStore(data) {
    fs.writeFileSync(this._getStorePath(), JSON.stringify(data, null, 2), 'utf8');
  }

  getAccounts() {
    const store = this._readStore();
    return store.accounts.map(a => ({
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      sellerId: a.sellerId,
      lastLogin: a.lastLogin
    }));
  }

  async getAccountWithCredentials(accountId) {
    const store = this._readStore();
    const account = store.accounts.find(a => a.id === accountId);
    if (!account) return null;

    let password = null;
    if (keytar) {
      password = await keytar.getPassword(SERVICE_NAME, account.email);
    } else {
      password = account._fallbackPwd || null;
    }

    return { ...account, password };
  }

  async saveAccount({ email, password, displayName, sellerId }) {
    const store = this._readStore();
    let account = store.accounts.find(a => a.email === email);

    if (account) {
      if (displayName) account.displayName = displayName;
      if (sellerId) account.sellerId = sellerId;
      account.lastLogin = new Date().toISOString();
    } else {
      account = {
        id: 'acc_' + Date.now(),
        email,
        displayName: displayName || email,
        sellerId: sellerId || null,
        lastLogin: new Date().toISOString()
      };
      store.accounts.push(account);
    }

    if (keytar && password) {
      await keytar.setPassword(SERVICE_NAME, email, password);
    } else if (password) {
      account._fallbackPwd = password;
    }

    this._writeStore(store);
    return account;
  }

  async removeAccount(accountId) {
    const store = this._readStore();
    const account = store.accounts.find(a => a.id === accountId);
    if (account && keytar) {
      try { await keytar.deletePassword(SERVICE_NAME, account.email); } catch (e) {}
    }
    store.accounts = store.accounts.filter(a => a.id !== accountId);
    this._writeStore(store);
  }

  saveSession(accountId, sessionData) {
    const store = this._readStore();
    const account = store.accounts.find(a => a.id === accountId);
    if (account) {
      account.session = {
        cookies: sessionData.cookies,
        csrfToken: sessionData.csrfToken,
        sellerId: sessionData.sellerId,
        locationId: sessionData.locationId,
        savedAt: new Date().toISOString()
      };
      account.sellerId = sessionData.sellerId || account.sellerId;
      account.lastLogin = new Date().toISOString();
      this._writeStore(store);
    }
  }

  getSession(accountId) {
    const store = this._readStore();
    const account = store.accounts.find(a => a.id === accountId);
    return account?.session || null;
  }

  getLastActiveAccountId() {
    const store = this._readStore();
    if (store.lastActiveAccountId) return store.lastActiveAccountId;
    const sorted = [...store.accounts].sort((a, b) => new Date(b.lastLogin || 0) - new Date(a.lastLogin || 0));
    return sorted[0]?.id || null;
  }

  setLastActiveAccountId(accountId) {
    const store = this._readStore();
    store.lastActiveAccountId = accountId;
    this._writeStore(store);
  }
}

module.exports = new SecureStorage();
