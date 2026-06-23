const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const registryClient = require('./registry-api-client');
const flipkartAuth = require('./flipkart-auth');
const secureStorage = require('./secure-storage');
const authService = require('./auth-service');
const activityLogger = require('./activity-logger');

let mainWindow;
let currentAccountId = null;

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

function getDownloadFolder() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return data.downloadFolder || null;
    }
  } catch (e) {
    console.error('Error reading settings:', e);
  }
  return null;
}

function saveDownloadFolder(folderPath) {
  try {
    let data = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
    data.downloadFolder = folderPath;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Error writing settings:', e);
  }
}

async function promptForDownloadFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Label Download Folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const selectedPath = result.filePaths[0];
  saveDownloadFolder(selectedPath);
  return selectedPath;
}

function getDiscoveryDir() {
  return path.join(app.getPath('userData'), 'discovery');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    titleBarStyle: 'default',
    backgroundColor: '#ffffff'
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const regPath = path.join(getDiscoveryDir(), 'api-registry.json');
  if (fs.existsSync(regPath)) {
    registryClient.loadRegistry(getDiscoveryDir());
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// =============== Auto Updater Setup ===============
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs', 'updater.log');
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

autoUpdater.on('checking-for-update', () => mainWindow?.webContents.send('updater-event', { event: 'checking-for-update' }));
autoUpdater.on('update-available', (info) => mainWindow?.webContents.send('updater-event', { event: 'update-available', data: info, currentVersion: app.getVersion() }));
autoUpdater.on('update-not-available', (info) => mainWindow?.webContents.send('updater-event', { event: 'update-not-available', data: info }));
autoUpdater.on('error', (err) => mainWindow?.webContents.send('updater-event', { event: 'error', data: err.message }));
autoUpdater.on('download-progress', (progressObj) => mainWindow?.webContents.send('updater-event', { event: 'download-progress', data: progressObj }));
autoUpdater.on('update-downloaded', (info) => mainWindow?.webContents.send('updater-event', { event: 'update-downloaded', data: info, currentVersion: app.getVersion() }));

ipcMain.handle('check-for-updates', () => autoUpdater.checkForUpdates());
ipcMain.handle('install-update', () => autoUpdater.quitAndInstall(false, true));


// =============== Software Auth (License) ===============

ipcMain.handle('auth-login', async (e, { email, password }) => {
  const r = await authService.login(email, password);
  if (r.success) activityLogger.log('login');
  return r;
});

ipcMain.handle('auth-register', async (e, { name, email, mobile, password }) => {
  const r = await authService.register(name, email, mobile, password);
  if (r.success) activityLogger.log('register');
  return r;
});

ipcMain.handle('auth-logout', () => { authService.logout(); return { success: true }; });

ipcMain.handle('auth-check', async () => {
  const user = authService.getUser();
  if (!user) return { authenticated: false };
  const license = await authService.verifyLicense();
  return { authenticated: authService.isAuthenticated(), user, license };
});

// =============== Flipkart Direct Auth ===============

ipcMain.handle('fk-get-accounts', () => secureStorage.getAccounts());

ipcMain.handle('fk-add-account', async (e, { email, password, displayName }) => {
  await secureStorage.saveAccount({ email, password, displayName });
  return secureStorage.getAccounts();
});

ipcMain.handle('fk-remove-account', async (e, accountId) => {
  await secureStorage.removeAccount(accountId);
  return secureStorage.getAccounts();
});

ipcMain.handle('fk-login', async (e, accountId) => {
  try {
    const account = await secureStorage.getAccountWithCredentials(accountId);
    if (!account || !account.password) return { success: false, error: 'No credentials found for this account' };

    // CRITICAL: Clear all previous session state before login
    flipkartAuth.clearSession();
    registryClient.setAuth(null, null);
    registryClient.sellerConstants.sellerId = null;
    registryClient.sellerConstants.locationId = null;
    currentAccountId = null;

    const stateResult = await flipkartAuth.checkState(account.email);
    const loginResult = await flipkartAuth.login(account.email, account.password);

    const loginBody = loginResult.body || {};
    const loginRaw = loginResult.raw || '';

    console.log('[LOGIN] status:', loginResult.statusCode, 'bodyKeys:', Object.keys(loginBody));

    // HTTP error
    if (loginResult.statusCode !== 200) {
      flipkartAuth.clearSession();
      return { success: false, error: loginBody.message || `Login failed (HTTP ${loginResult.statusCode})` };
    }

    // CRITICAL: Flipkart returns HTTP 200 for BOTH success and failure.
    // Success: {"mfa":{"otp":{"email":{...},"mobile":{...}}}}
    // Failure: {"message":"Username and password do not match"} or similar
    //
    // OTP was sent ONLY if mfa.otp exists in response.
    const otpData = loginBody.mfa?.otp;

    if (!otpData) {
      flipkartAuth.clearSession();
      const rawMsg = loginBody.message || loginBody.error || '';
      const code = loginBody.code;
      console.log('[LOGIN] Rejected: code=' + code + ' message=' + rawMsg);

      // Map Flipkart codes/messages to user-friendly errors
      const ERROR_MAP = {
        'Show_CAPTCHA': 'Too many login attempts. Please wait a few minutes and try again, or log in via seller.flipkart.com first to clear the CAPTCHA.',
        'Username and password do not match': 'Incorrect email or password.',
        'INVALID_CREDENTIALS': 'Incorrect email or password.',
        'ACCOUNT_LOCKED': 'Account is locked. Please try again later.',
        'ACCOUNT_BLOCKED': 'Account has been blocked. Contact Flipkart support.',
      };

      const errorMsg = ERROR_MAP[rawMsg] || rawMsg || 'Login failed (code ' + code + ')';
      return { success: false, error: errorMsg };
    }

    // OTP was genuinely sent — extract delivery info
    const otpEmail = otpData.email?.user_id || null;
    const otpMobile = otpData.mobile?.user_id || null;
    const otpExpiry = otpData.email?.expiry_date || otpData.mobile?.expiry_date || null;

    console.log('[LOGIN] OTP sent to email:', otpEmail, 'mobile:', otpMobile, 'expires:', otpExpiry);

    return {
      success: true,
      needsOtp: true,
      accountId,
      otpInfo: { email: otpEmail, mobile: otpMobile, expiry: otpExpiry }
    };
  } catch (err) {
    flipkartAuth.clearSession();
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fk-verify-otp', async (e, { accountId, otp }) => {
  try {
    const result = await flipkartAuth.verifyOtp(otp);

    const verifyBody = result.body || {};

    // PRIMARY CHECK: use response body code, NOT cookies
    // code 1000 = "The Seller were authenticated successfully"
    if (!result._verified) {
      const errorMsg = verifyBody.message || `OTP verification failed (code=${verifyBody.code}, HTTP ${result.statusCode})`;
      console.error('[AUTH] OTP body verification failed:', { code: verifyBody.code, message: verifyBody.message, status: result.statusCode });
      flipkartAuth.clearSession();
      registryClient.setAuth(null, null);
      return { success: false, error: errorMsg };
    }

    const session = flipkartAuth.extractSessionData();
    const sellerData = result._sellerData || {};

    // Session should now have sellerId (injected from body) and is_login=true
    if (!session.sellerId) {
      console.error('[AUTH] No sellerId after verified OTP');
      flipkartAuth.clearSession();
      registryClient.setAuth(null, null);
      return { success: false, error: 'Authenticated but sellerId missing from session' };
    }

    // If no CSRF yet, still proceed — API may work with session cookies
    if (!session.csrfToken) {
      console.warn('[AUTH] No CSRF token found after post-login fetches. API calls may fail.');
    }

    registryClient.setAuth(session.csrfToken, session.cookieStr);
    registryClient.sellerConstants.sellerId = session.sellerId;

    // Dynamically resolve location ID for the current account
    const locationId = await registryClient.fetchLocation();

    // Use displayName from verify response
    const displayName = sellerData.displayName || sellerData.businessName || sellerData.name || null;

    secureStorage.saveSession(accountId, {
      cookies: session.cookies,
      csrfToken: session.csrfToken,
      sellerId: session.sellerId,
      locationId: locationId
    });

    const account = await secureStorage.getAccountWithCredentials(accountId);
    if (account) {
      await secureStorage.saveAccount({
        email: account.email,
        password: account.password,
        displayName: displayName || account.displayName,
        sellerId: session.sellerId
      });
    }

    currentAccountId = accountId;
    secureStorage.setLastActiveAccountId(accountId);
    activityLogger.log('flipkart-login');

    return { success: true, sellerId: session.sellerId, hasCsrf: !!session.csrfToken };
  } catch (err) {
    flipkartAuth.clearSession();
    registryClient.setAuth(null, null);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fk-restore-session', async (e, accountId) => {
  const targetId = accountId || secureStorage.getLastActiveAccountId();
  if (!targetId) return { success: false };

  const session = secureStorage.getSession(targetId);
  if (!session || !session.cookies) return { success: false };

  flipkartAuth.setCookies(session.cookies);
  const valid = await flipkartAuth.validateSession(session.cookies);

  if (valid) {
    const cookieStr = Object.entries(session.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    registryClient.setAuth(session.csrfToken, cookieStr);
    if (session.sellerId) registryClient.sellerConstants.sellerId = session.sellerId;
    if (session.locationId) {
      registryClient.sellerConstants.locationId = session.locationId;
      console.log(`[AUTH] Restored location ID from session: ${session.locationId}`);
    } else {
      const locationId = await registryClient.fetchLocation();
      if (locationId) {
        secureStorage.saveSession(targetId, {
          ...session,
          locationId
        });
      }
    }
    currentAccountId = targetId;
    return { success: true, accountId: targetId, sellerId: session.sellerId };
  }

  return { success: false };
});

ipcMain.handle('fk-logout', () => {
  flipkartAuth.clearSession();
  registryClient.setAuth(null, null);
  registryClient.sellerConstants.sellerId = null;
  registryClient.sellerConstants.locationId = null;
  currentAccountId = null;
  activityLogger.log('flipkart-logout');
  return { success: true };
});

// =============== Orders & Stats ===============

function wrapApi(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') {
        mainWindow.webContents.send('session-expired');
        return null;
      }
      if (err.message === 'NO_AUTH') return null;
      console.error('[Main] API error:', err.message);
      return null;
    }
  };
}

ipcMain.handle('get-dashboard-stats', wrapApi(() => registryClient.fetchDashboardStats()));
ipcMain.handle('get-orders', wrapApi(() => registryClient.fetchToAccept()));
ipcMain.handle('get-to-pack-orders', wrapApi(() => registryClient.fetchToPack()));
ipcMain.handle('get-in-transit-orders', wrapApi(() => registryClient.fetchInTransit()));
ipcMain.handle('get-completed-orders', wrapApi(() => registryClient.fetchCompleted()));
ipcMain.handle('get-upcoming-orders', wrapApi(() => registryClient.fetchUpcoming()));
ipcMain.handle('get-pending-dispatch', wrapApi(() => registryClient.fetchPendingDispatch()));

ipcMain.handle('get-orders-page', wrapApi(async (e, { status, pageNum, pageSize }) => {
  return registryClient.fetchOrders(status, pageNum, pageSize || 20);
}));

ipcMain.handle('get-otc', wrapApi(() => registryClient.fetchOTC()));

// =============== Export ===============

ipcMain.handle('export-orders', async () => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Orders to CSV',
    defaultPath: 'orders_export.csv',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  if (!filePath) return { success: false, message: 'Cancelled' };
  try {
    const orders = await registryClient.fetchCompleted();
    if (!orders || orders.length === 0) return { success: false, message: 'No orders to export' };
    const { createObjectCsvWriter } = require('csv-writer');
    const writer = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'order_id', title: 'Order ID' },
        { id: 'sku', title: 'SKU' },
        { id: 'product_title', title: 'Product' },
        { id: 'quantity', title: 'Qty' },
        { id: 'seller_price', title: 'Price' },
        { id: 'order_status', title: 'Status' },
        { id: 'dispatch_date', title: 'Dispatch Date' },
        { id: 'courier_partner', title: 'Courier' }
      ]
    });
    await writer.writeRecords(orders);
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// =============== Registry ===============

ipcMain.handle('check-registry', () => {
  const regPath = path.join(getDiscoveryDir(), 'api-registry.json');
  const exists = fs.existsSync(regPath);
  let entryCount = 0;
  if (exists) { try { entryCount = Object.keys(JSON.parse(fs.readFileSync(regPath, 'utf8'))).length; } catch (e) {} }
  return { exists, entryCount };
});

// =============== Active Flipkart Features ===============

ipcMain.handle('accept-order', wrapApi(async (e, { shipmentIds }) => {
  return await registryClient.acceptOrders(shipmentIds);
}));

ipcMain.handle('rtd-orders', wrapApi(async (e, { shipmentIds }) => {
  return await registryClient.rtdOrders(shipmentIds);
}));

ipcMain.handle('get-download-folder', () => {
  return getDownloadFolder();
});

ipcMain.handle('select-download-folder', async () => {
  return await promptForDownloadFolder();
});

ipcMain.handle('print-labels', async (e, { shipmentIds, reprint }) => {
  try {
    let downloadFolder = getDownloadFolder();
    if (!downloadFolder) {
      downloadFolder = await promptForDownloadFolder();
    }
    if (!downloadFolder) {
      return { success: false, error: 'Download folder selection cancelled' };
    }

    const printService = require('./print-service');
    const { PDFDocument } = require('pdf-lib');
    const crypto = require('crypto');

    const batchId = new Date().toISOString().replace(/T/, '_').replace(/[:.]/g, '-').substring(0, 19) + '_' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const batchDir = path.join(downloadFolder, batchId);
    fs.mkdirSync(batchDir, { recursive: true });

    const labelEntries = [];

    for (const shipmentId of shipmentIds) {
      const res = await registryClient.printLabels([shipmentId], reprint);

      let pdfBuffer;
      if (Buffer.isBuffer(res)) {
        pdfBuffer = res;
      } else if (res && (res.url || res.pdfUrl)) {
        pdfBuffer = await registryClient.downloadFileBuffer(res.url || res.pdfUrl);
      } else if (typeof res === 'string' && res.startsWith('%PDF')) {
        pdfBuffer = Buffer.from(res, 'binary');
      } else {
        console.error(`[Main] Failed to generate label PDF for shipment ${shipmentId}`);
        continue;
      }

      const meta = registryClient.getShipmentMeta(shipmentId);
      let sku = 'UNKNOWN';
      let quantity = 1;
      let sellerPrice = 0;
      if (meta) {
        const spec = meta.shipmentContents?.shipmentGroupSpecs?.[0];
        if (spec?.listing?.product?.sku) sku = spec.listing.product.sku;
        if (spec?.quantity) quantity = spec.quantity;
        sellerPrice = meta.sellerPrice || 0;
      }

      labelEntries.push({ shipmentId, pdfBuffer, sku, quantity, sellerPrice });
    }

    if (labelEntries.length === 0) {
      fs.rmdirSync(batchDir, { recursive: true });
      return { success: false, error: 'No labels could be generated' };
    }

    const HIGHER_INVOICE_THRESHOLD = 2;
    const higherInvoice = labelEntries.filter(e => e.quantity >= HIGHER_INVOICE_THRESHOLD);
    const sortSku = labelEntries.filter(e => e.quantity < HIGHER_INVOICE_THRESHOLD);
    sortSku.sort((a, b) => a.sku.localeCompare(b.sku));

    const savedFiles = [];

    async function mergePdfs(entries, filename) {
      if (entries.length === 0) return;
      const merged = await PDFDocument.create();
      for (const entry of entries) {
        try {
          const src = await PDFDocument.load(entry.pdfBuffer);
          const pages = await merged.copyPages(src, src.getPageIndices());
          pages.forEach(p => merged.addPage(p));
        } catch (err) {
          console.error(`[Main] Failed to merge PDF for ${entry.shipmentId}:`, err.message);
        }
      }
      if (merged.getPageCount() > 0) {
        const bytes = await merged.save();
        const filePath = path.join(batchDir, filename);
        fs.writeFileSync(filePath, Buffer.from(bytes));
        savedFiles.push(filePath);
      }
    }

    if (higherInvoice.length > 0) {
      await mergePdfs(higherInvoice, 'HigherInvoice.pdf');
    }

    const remaining = higherInvoice.length > 0 ? sortSku : labelEntries;
    remaining.sort((a, b) => a.sku.localeCompare(b.sku));
    await mergePdfs(remaining, 'SortSku.pdf');

    const { shell } = require('electron');
    await shell.openPath(batchDir);

    for (const filePath of savedFiles) {
      try {
        await printService.print(filePath);
      } catch (err) {
        console.error(`[Main] Print failed for ${filePath}:`, err.message);
      }
    }

    return { success: true, count: labelEntries.length, batchDir, files: savedFiles.map(f => path.basename(f)) };
  } catch (err) {
    if (err.message === 'SESSION_EXPIRED') {
      mainWindow.webContents.send('session-expired');
      return { success: false, error: 'Session expired' };
    }
    console.error('[Main] Print labels failed:', err);
    return { success: false, error: err.message };
  }
});
