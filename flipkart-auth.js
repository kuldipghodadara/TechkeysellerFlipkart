const { net } = require('electron');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://seller.flipkart.com';
const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
  'Origin': BASE_URL,
  'Referer': BASE_URL + '/',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Encoding': 'identity'
};

function logDebug(label, data) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [AUTH] ${label}: ${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`;
  console.log(line);
  try {
    const { app } = require('electron');
    const logPath = path.join(app.getPath('userData'), 'AUTH_DEBUG.log');
    fs.appendFileSync(logPath, line + '\n', 'utf8');
  } catch (e) {}
}

class FlipkartAuth {
  constructor() {
    this._cookies = {};
  }

  clearSession() {
    logDebug('CLEAR_SESSION', `Clearing ${Object.keys(this._cookies).length} cookies`);
    this._cookies = {};
  }

  async checkState(email) {
    // Get a fresh T cookie by hitting the base URL first — clears CAPTCHA counter
    this._cookies = {};
    await this._request('GET', `${BASE_URL}/`);
    logDebug('FRESH_SESSION', { cookiesAfter: Object.keys(this._cookies) });

    const url = `${BASE_URL}/getStateDetails?username=${encodeURIComponent(email)}&suppressForgotPassword=true`;
    const result = await this._request('GET', url);
    logDebug('CHECK_STATE', {
      status: result.statusCode,
      body: result.body,
      cookiesAfter: Object.keys(this._cookies)
    });
    return result;
  }

  async login(email, password) {
    const payload = {
      authName: 'flipkart',
      username: email,
      password: password,
      userNameType: email.includes('@') ? 'email' : 'mobile'
    };

    logDebug('LOGIN_REQUEST', { email, userNameType: payload.userNameType });
    const result = await this._request('POST', `${BASE_URL}/login`, payload);

    logDebug('LOGIN_RESPONSE', {
      status: result.statusCode,
      body: result.body,
      raw: result.raw?.substring(0, 1000),
      cookiesAfter: Object.keys(this._cookies),
      setCookieCount: Object.keys(this._cookies).length
    });

    return result;
  }

  async verifyOtp(otp) {
    logDebug('VERIFY_OTP_REQUEST', { otp, cookiesBefore: Object.keys(this._cookies) });

    const result = await this._request('POST', `${BASE_URL}/verifyOtp`, { otp });

    logDebug('VERIFY_OTP_RESPONSE', {
      status: result.statusCode,
      body: result.body,
      raw: result.raw?.substring(0, 1000),
      cookiesAfter: Object.keys(this._cookies),
      hasSellerId: !!this._cookies['sellerId'],
      hasIsLogin: !!this._cookies['is_login'],
      hasConnectSid: !!this._cookies['connect.sid']
    });

    // Validate using response BODY — code 1000 means authenticated
    const verifyBody = result.body || {};
    const isVerified = verifyBody.code === 1000 && verifyBody.data?.sellerId;

    if (isVerified) {
      // Inject sellerId from response body since server doesn't always set is_login cookie
      if (verifyBody.data.sellerId && !this._cookies['sellerId']) {
        this._cookies['sellerId'] = verifyBody.data.sellerId;
      }
      this._cookies['is_login'] = 'true';

      logDebug('POST_LOGIN', 'OTP verified (code=1000). Fetching post-login pages for CSRF...');

      const featResult = await this._request('GET', `${BASE_URL}/getFeaturesForSeller`);
      logDebug('FEATURES_RESPONSE', { status: featResult.statusCode, cookiesAfter: Object.keys(this._cookies) });

      const idxResult = await this._request('GET', `${BASE_URL}/index.html`);
      logDebug('INDEX_RESPONSE', { status: idxResult.statusCode, cookiesAfter: Object.keys(this._cookies) });
    } else {
      logDebug('VERIFY_FAILED', `code=${verifyBody.code}, message=${verifyBody.message}, hasSellerId=${!!verifyBody.data?.sellerId}`);
    }

    // Attach parsed verification data to result for caller
    result._verified = isVerified;
    result._sellerData = verifyBody.data || null;

    return result;
  }

  async validateSession(cookies) {
    try {
      const result = await this._rawRequest('GET', `${BASE_URL}/getFeaturesForSeller`, null, cookies);

      if (result.statusCode !== 200) {
        logDebug('VALIDATE_SESSION', { status: result.statusCode, valid: false });
        return false;
      }

      // Parse response — valid session returns a JSON object with seller features
      // Invalid/expired session returns a redirect page (HTML) or empty response
      let data;
      try {
        data = JSON.parse(result.body);
      } catch (e) {
        // Response is not JSON — likely an HTML login redirect
        logDebug('VALIDATE_SESSION', { status: result.statusCode, valid: false, reason: 'not JSON', bodyStart: result.body?.substring(0, 100) });
        return false;
      }

      // A valid features response is a non-empty object (could be array or object)
      // An auth failure returns something like {"error":"..."} or redirects
      const valid = data !== null && typeof data === 'object' && !data.error;

      logDebug('VALIDATE_SESSION', { status: result.statusCode, valid, type: typeof data, isArray: Array.isArray(data), keys: Array.isArray(data) ? data.length : Object.keys(data).slice(0, 5) });
      return valid;
    } catch (e) {
      logDebug('VALIDATE_SESSION_ERROR', e.message);
      return false;
    }
  }

  extractSessionData() {
    const sellerId = this._cookies['sellerId'] || null;
    const isLogin = this._cookies['is_login'] === 'true';
    const hasConnectSid = !!this._cookies['connect.sid'];

    // Strategy 1: known cookie name
    let csrfToken = this._cookies['XyZ7pQ9rS2T1uV8wA3bC6dE4fG0h'] || null;

    // Strategy 2: scan for CSRF pattern
    if (!csrfToken) {
      const skipNames = new Set(['T','connect.sid','sellerId','is_login','DID','nonce','experiment','moe_uuid']);
      for (const [name, value] of Object.entries(this._cookies)) {
        if (skipNames.has(name)) continue;
        if (name.startsWith('_') || name.startsWith('AMCV') || name.startsWith('s_') || name.startsWith('mp_')) continue;
        if (name.length >= 10 && /^[A-Za-z0-9]+$/.test(name) && value.length >= 20 && value.length <= 60 && /^[A-Za-z0-9\-_]+$/.test(value)) {
          csrfToken = value;
          logDebug('CSRF_DETECTED', `Cookie name: ${name}, value: ${value.substring(0, 20)}...`);
          break;
        }
      }
    }

    const cookieStr = Object.entries(this._cookies).map(([k, v]) => `${k}=${v}`).join('; ');

    logDebug('SESSION_DATA', {
      sellerId,
      csrfToken: csrfToken ? csrfToken.substring(0, 15) + '...' : null,
      isLogin,
      hasConnectSid,
      totalCookies: Object.keys(this._cookies).length,
      cookieNames: Object.keys(this._cookies).join(', ')
    });

    return { sellerId, csrfToken, isLogin, hasConnectSid, cookieStr, cookies: { ...this._cookies } };
  }

  setCookies(cookieObj) {
    this._cookies = { ...cookieObj };
  }

  _request(method, url, body = null) {
    return new Promise((resolve, reject) => {
      const request = net.request({ method, url });

      Object.entries(COMMON_HEADERS).forEach(([k, v]) => {
        try { request.setHeader(k, v); } catch (e) {}
      });

      if (body) {
        request.setHeader('Content-Type', 'application/json');
      }

      const cookieStr = Object.entries(this._cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookieStr) {
        try { request.setHeader('Cookie', cookieStr); } catch (e) {}
      }

      if (body) {
        request.write(JSON.stringify(body));
      }

      request.on('response', (response) => {
        this._extractCookies(response.headers['set-cookie']);

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const bodyStr = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(bodyStr); } catch (e) {}

          resolve({
            statusCode: response.statusCode,
            body: parsed,
            raw: bodyStr,
            cookies: { ...this._cookies }
          });
        });
      });

      request.on('error', (err) => {
        logDebug('REQUEST_ERROR', { method, url, error: err.message });
        reject(err);
      });

      request.end();
    });
  }

  _rawRequest(method, url, body, cookieObj) {
    return new Promise((resolve, reject) => {
      const request = net.request({ method, url });

      Object.entries(COMMON_HEADERS).forEach(([k, v]) => {
        try { request.setHeader(k, v); } catch (e) {}
      });

      const cookieStr = Object.entries(cookieObj || {}).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookieStr) {
        try { request.setHeader('Cookie', cookieStr); } catch (e) {}
      }

      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      });

      request.on('error', reject);
      request.end();
    });
  }

  _extractCookies(setCookieHeaders) {
    if (!setCookieHeaders) return;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const header of headers) {
      const parts = header.split(';')[0].trim();
      const eqIdx = parts.indexOf('=');
      if (eqIdx > 0) {
        const name = parts.substring(0, eqIdx);
        const value = parts.substring(eqIdx + 1);
        this._cookies[name] = value;
      }
    }
  }
}

module.exports = new FlipkartAuth();
