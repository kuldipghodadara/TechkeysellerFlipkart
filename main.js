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

function getDownloadFolder() { try { if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).downloadFolder || null; } catch {} return null; }
function saveDownloadFolder(p) { try { let d = {}; if (fs.existsSync(SETTINGS_FILE)) d = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); d.downloadFolder = p; fs.writeFileSync(SETTINGS_FILE, JSON.stringify(d, null, 2), 'utf8'); } catch {} }
async function promptForDownloadFolder() { const r = await dialog.showOpenDialog(mainWindow, { title: 'Select Label Download Folder', properties: ['openDirectory', 'createDirectory'] }); if (r.canceled || !r.filePaths.length) return null; saveDownloadFolder(r.filePaths[0]); return r.filePaths[0]; }
function getDiscoveryDir() { return path.join(app.getPath('userData'), 'discovery'); }

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1280, height: 860, minWidth: 1024, minHeight: 680, icon: path.join(__dirname, 'icon.ico'), webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true }, backgroundColor: '#ffffff' });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const regPath = path.join(getDiscoveryDir(), 'api-registry.json');
  if (fs.existsSync(regPath)) registryClient.loadRegistry(getDiscoveryDir());
}

app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// =============== Auto Updater ===============
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs', 'updater.log');
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.on('checking-for-update', () => mainWindow?.webContents.send('updater-event', { event: 'checking-for-update' }));
autoUpdater.on('update-available', (info) => mainWindow?.webContents.send('updater-event', { event: 'update-available', data: info, currentVersion: app.getVersion() }));
autoUpdater.on('update-not-available', (info) => mainWindow?.webContents.send('updater-event', { event: 'update-not-available', data: info }));
autoUpdater.on('error', (err) => mainWindow?.webContents.send('updater-event', { event: 'error', data: err.message }));
autoUpdater.on('download-progress', (p) => mainWindow?.webContents.send('updater-event', { event: 'download-progress', data: p }));
autoUpdater.on('update-downloaded', (info) => mainWindow?.webContents.send('updater-event', { event: 'update-downloaded', data: info, currentVersion: app.getVersion() }));
ipcMain.handle('check-for-updates', () => autoUpdater.checkForUpdates());
ipcMain.handle('install-update', () => autoUpdater.quitAndInstall(false, true));

// =============== Software Auth ===============
ipcMain.handle('auth-register', async (e, data) => { try { const r = await authService.register(data); if (r.success) activityLogger.log('register'); return r; } catch (err) { return { success: false, error: err.message }; } });
ipcMain.handle('auth-login', async (e, { mobileOrEmail, password }) => { try { const r = await authService.login(mobileOrEmail, password); if (r.success) activityLogger.log('login'); return r; } catch (err) { return { success: false, error: err.message }; } });
ipcMain.handle('auth-logout', () => { authService.logout(); return { success: true }; });

ipcMain.handle('auth-bootstrap', async () => { try { return await authService.bootstrap(); } catch (err) { return { authenticated: false, error: err.message }; } });
ipcMain.handle('auth-get-license', () => authService.getLicense());
ipcMain.handle('auth-get-plan', () => authService.getAssignedPlan());
ipcMain.handle('auth-update-profile', async (e, data) => { try { return await authService.updateProfile(data); } catch (err) { return { success: false, error: err.message }; } });

// License gate — checks active + cache freshness
function requireLicense() {
  if (authService.isCacheExpired()) {
    return { success: false, error: 'LICENSE_EXPIRED_CACHE', message: 'License verification required. Click Sync License or restart.' };
  }
  if (!authService.isLicenseActive()) {
    const lic = authService.getLicense();
    const msg = (!lic || lic.status !== 'active') ? 'Your account is inactive. Contact administrator.' : 'No credits remaining.';
    return { success: false, error: 'LICENSE_INACTIVE', message: msg };
  }
  return null;
}

// =============== Flipkart Direct Auth ===============
ipcMain.handle('fk-get-accounts', () => secureStorage.getAccounts());
ipcMain.handle('fk-add-account', async (e, { email, password, displayName }) => {
  const blocked = requireLicense();
  if (blocked) return { success: false, error: blocked.message };
  await secureStorage.saveAccount({ email, password, displayName });
  return secureStorage.getAccounts();
});
ipcMain.handle('fk-remove-account', async (e, accountId) => { await secureStorage.removeAccount(accountId); return secureStorage.getAccounts(); });

ipcMain.handle('fk-login', async (e, accountId) => {
  try {
    try { await authService.bootstrap(); } catch {}
    const blocked = requireLicense();
    if (blocked) return { success: false, error: blocked.message };
    const account = await secureStorage.getAccountWithCredentials(accountId);
    if (!account || !account.password) return { success: false, error: 'No credentials found' };
    flipkartAuth.clearSession(); registryClient.setAuth(null, null); registryClient.sellerConstants.sellerId = null; registryClient.sellerConstants.locationId = null; currentAccountId = null;
    await flipkartAuth.checkState(account.email);
    const loginResult = await flipkartAuth.login(account.email, account.password);
    const loginBody = loginResult.body || {};
    if (loginResult.statusCode !== 200) { flipkartAuth.clearSession(); return { success: false, error: loginBody.message || `Login failed (HTTP ${loginResult.statusCode})` }; }
    const otpData = loginBody.mfa?.otp;
    if (!otpData) { flipkartAuth.clearSession(); const m = loginBody.message || loginBody.error || ''; const MAP = { 'Show_CAPTCHA': 'Too many attempts. Wait or login via seller.flipkart.com.', 'Username and password do not match': 'Incorrect email or password.' }; return { success: false, error: MAP[m] || m || 'Login failed' }; }
    return { success: true, needsOtp: true, accountId, otpInfo: { email: otpData.email?.user_id, mobile: otpData.mobile?.user_id, expiry: otpData.email?.expiry_date || otpData.mobile?.expiry_date } };
  } catch (err) { flipkartAuth.clearSession(); return { success: false, error: err.message }; }
});

ipcMain.handle('fk-verify-otp', async (e, { accountId, otp }) => {
  try {
    const result = await flipkartAuth.verifyOtp(otp);
    if (!result._verified) { flipkartAuth.clearSession(); registryClient.setAuth(null, null); return { success: false, error: result.body?.message || 'OTP failed' }; }
    const session = flipkartAuth.extractSessionData(); const sellerData = result._sellerData || {};
    if (!session.sellerId) { flipkartAuth.clearSession(); registryClient.setAuth(null, null); return { success: false, error: 'sellerId missing' }; }
    registryClient.setAuth(session.csrfToken, session.cookieStr); registryClient.sellerConstants.sellerId = session.sellerId;
    const locationId = await registryClient.fetchLocation();
    const displayName = sellerData.displayName || sellerData.businessName || sellerData.name || null;
    secureStorage.saveSession(accountId, { cookies: session.cookies, csrfToken: session.csrfToken, sellerId: session.sellerId, locationId });
    const account = await secureStorage.getAccountWithCredentials(accountId);
    if (account) await secureStorage.saveAccount({ email: account.email, password: account.password, displayName: displayName || account.displayName, sellerId: session.sellerId });
    currentAccountId = accountId; secureStorage.setLastActiveAccountId(accountId); activityLogger.log('flipkart-login');
    return { success: true, sellerId: session.sellerId, hasCsrf: !!session.csrfToken };
  } catch (err) { flipkartAuth.clearSession(); registryClient.setAuth(null, null); return { success: false, error: err.message }; }
});

ipcMain.handle('fk-restore-session', async (e, accountId) => {
  const id = accountId || secureStorage.getLastActiveAccountId(); if (!id) return { success: false };
  const session = secureStorage.getSession(id); if (!session?.cookies) return { success: false };
  flipkartAuth.setCookies(session.cookies);
  if (await flipkartAuth.validateSession(session.cookies)) {
    const cs = Object.entries(session.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    registryClient.setAuth(session.csrfToken, cs);
    if (session.sellerId) registryClient.sellerConstants.sellerId = session.sellerId;
    if (session.locationId) registryClient.sellerConstants.locationId = session.locationId;
    else { const loc = await registryClient.fetchLocation(); if (loc) secureStorage.saveSession(id, { ...session, locationId: loc }); }
    currentAccountId = id;
    return { success: true, accountId: id, sellerId: session.sellerId };
  }
  return { success: false };
});

ipcMain.handle('fk-logout', () => { flipkartAuth.clearSession(); registryClient.setAuth(null, null); registryClient.sellerConstants.sellerId = null; registryClient.sellerConstants.locationId = null; currentAccountId = null; activityLogger.log('flipkart-logout'); return { success: true }; });

// =============== Orders & Stats ===============
function wrapApi(fn) { return async (...args) => { try { return await fn(...args); } catch (err) { if (err.message === 'SESSION_EXPIRED') { mainWindow.webContents.send('session-expired'); return null; } if (err.message === 'NO_AUTH') return null; return null; } }; }

ipcMain.handle('get-dashboard-stats', wrapApi(() => registryClient.fetchDashboardStats()));
ipcMain.handle('get-orders', wrapApi(() => registryClient.fetchToAccept()));
ipcMain.handle('get-to-pack-orders', wrapApi(() => registryClient.fetchToPack()));
ipcMain.handle('get-in-transit-orders', wrapApi(() => registryClient.fetchInTransit()));
ipcMain.handle('get-completed-orders', wrapApi(() => registryClient.fetchCompleted()));
ipcMain.handle('get-upcoming-orders', wrapApi(() => registryClient.fetchUpcoming()));
ipcMain.handle('get-pending-dispatch', wrapApi(() => registryClient.fetchPendingDispatch()));
ipcMain.handle('get-orders-page', wrapApi(async (e, { status, pageNum, pageSize }) => registryClient.fetchOrders(status, pageNum, pageSize || 20)));
ipcMain.handle('get-otc', wrapApi(() => registryClient.fetchOTC()));

// =============== Export (NO credit deduction) ===============
ipcMain.handle('export-orders', async () => {
  const blocked = requireLicense(); if (blocked) return { success: false, message: blocked.message };
  const { filePath } = await dialog.showSaveDialog(mainWindow, { title: 'Export Orders to CSV', defaultPath: 'orders_export.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (!filePath) return { success: false, message: 'Cancelled' };
  try {
    const orders = await registryClient.fetchCompleted(); if (!orders?.length) return { success: false, message: 'No orders' };
    const { createObjectCsvWriter } = require('csv-writer');
    await createObjectCsvWriter({ path: filePath, header: [{ id: 'order_id', title: 'Order ID' },{ id: 'sku', title: 'SKU' },{ id: 'product_title', title: 'Product' },{ id: 'quantity', title: 'Qty' },{ id: 'seller_price', title: 'Price' },{ id: 'order_status', title: 'Status' },{ id: 'dispatch_date', title: 'Dispatch Date' },{ id: 'courier_partner', title: 'Courier' }] }).writeRecords(orders);
    return { success: true, path: filePath };
  } catch (err) { return { success: false, message: err.message }; }
});

ipcMain.handle('check-registry', () => { const p = path.join(getDiscoveryDir(), 'api-registry.json'); const e = fs.existsSync(p); let c = 0; if (e) try { c = Object.keys(JSON.parse(fs.readFileSync(p, 'utf8'))).length; } catch {} return { exists: e, entryCount: c }; });

// =============== Accept & RTD (NO credit deduction — credits only on label download) ===============
ipcMain.handle('accept-order', wrapApi(async (e, { shipmentIds }) => {
  const blocked = requireLicense(); if (blocked) return blocked;
  return await registryClient.acceptOrders(shipmentIds);
}));

ipcMain.handle('rtd-orders', wrapApi(async (e, { shipmentIds }) => {
  const blocked = requireLicense(); if (blocked) return blocked;
  return await registryClient.rtdOrders(shipmentIds);
}));

ipcMain.handle('get-download-folder', () => getDownloadFolder());
ipcMain.handle('select-download-folder', async () => await promptForDownloadFolder());

// =============== Print Labels (ONLY place credits are deducted) ===============
ipcMain.handle('print-labels', async (e, { shipmentIds, reprint }) => {
  const blocked = requireLicense(); if (blocked) return blocked;
  try {
    let downloadFolder = getDownloadFolder();
    if (!downloadFolder) downloadFolder = await promptForDownloadFolder();
    if (!downloadFolder) return { success: false, error: 'No folder' };

    const printService = require('./print-service');
    const { PDFDocument } = require('pdf-lib');
    const crypto = require('crypto');

    const batchId = new Date().toISOString().replace(/T/, '_').replace(/[:.]/g, '-').substring(0, 19) + '_' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const batchDir = path.join(downloadFolder, batchId);
    fs.mkdirSync(batchDir, { recursive: true });

    const entries = [];
    for (const sid of shipmentIds) {
      console.log(`[LABEL] Fetching label for shipment: ${sid}`);
      let buf;
      try {
        const res = await registryClient.printLabels([sid], reprint);
        if (Buffer.isBuffer(res)) {
          buf = res;
        } else if (res?.url || res?.pdfUrl) {
          buf = await registryClient.downloadFileBuffer(res.url || res.pdfUrl);
        } else if (typeof res === 'string' && res.startsWith('%PDF')) {
          buf = Buffer.from(res, 'binary');
        } else {
          console.error(`[LABEL] Unexpected response type for ${sid}: ${typeof res}`);
          continue;
        }
      } catch (printErr) {
        console.error(`[LABEL] Print API error for ${sid}: ${printErr.message}`);
        continue;
      }

      if (!buf || buf.length === 0) {
        console.error(`[LABEL] Empty buffer for ${sid}`);
        continue;
      }

      console.log(`[LABEL] PDF buffer received for ${sid}: ${buf.length} bytes`);

      const meta = registryClient.getShipmentMeta(sid);
      let sku = 'UNKNOWN', qty = 1, price = 0;
      if (meta) {
        const sp = meta.shipmentContents?.shipmentGroupSpecs?.[0];
        if (sp?.listing?.product?.sku) sku = sp.listing.product.sku;
        if (sp?.quantity) qty = sp.quantity;
        price = meta.sellerPrice || 0;
      }
      entries.push({ shipmentId: sid, pdfBuffer: buf, sku, quantity: qty, sellerPrice: price });
    }

    if (!entries.length) {
      console.error('[LABEL] No valid label entries. Removing empty batch folder.');
      try { fs.rmSync(batchDir, { recursive: true, force: true }); } catch {}
      return { success: false, error: 'No labels could be generated. Check Flipkart session.' };
    }

    console.log(`[LABEL] ${entries.length} labels fetched. Merging PDFs...`);

    const hi = entries.filter(e => e.quantity >= 2);
    const sk = entries.filter(e => e.quantity < 2);
    sk.sort((a, b) => a.sku.localeCompare(b.sku));

    const saved = [];

    async function merge(list, name) {
      if (!list.length) return;
      const merged = await PDFDocument.create();
      for (const entry of list) {
        try {
          const src = await PDFDocument.load(entry.pdfBuffer);
          const pages = await merged.copyPages(src, src.getPageIndices());
          pages.forEach(p => merged.addPage(p));
        } catch (mergeErr) {
          console.error(`[LABEL] Failed to merge PDF for ${entry.shipmentId}: ${mergeErr.message}`);
        }
      }
      if (merged.getPageCount() > 0) {
        const filePath = path.join(batchDir, name);
        const bytes = await merged.save();
        fs.writeFileSync(filePath, Buffer.from(bytes));
        console.log(`[LABEL] Saved ${name}: ${filePath} (${bytes.length} bytes)`);
        saved.push(filePath);
      }
    }

    if (hi.length) await merge(hi, 'HigherInvoice.pdf');
    const remaining = hi.length ? sk : entries;
    remaining.sort((a, b) => a.sku.localeCompare(b.sku));
    await merge(remaining, 'SortSku.pdf');

    // Validate saved files exist and are non-empty
    const validFiles = [];
    for (const f of saved) {
      if (!fs.existsSync(f)) {
        console.error(`[LABEL] VALIDATION FAIL: File missing: ${f}`);
        continue;
      }
      const size = fs.statSync(f).size;
      if (size <= 0) {
        console.error(`[LABEL] VALIDATION FAIL: Empty file: ${f} (${size} bytes)`);
        continue;
      }
      console.log(`[LABEL] VALIDATED: ${path.basename(f)} — ${size} bytes`);
      validFiles.push(f);
    }

    if (!validFiles.length) {
      console.error('[LABEL] No valid PDF files after merge. Aborting. No credits deducted.');
      try { fs.rmSync(batchDir, { recursive: true, force: true }); } catch {}
      return { success: false, error: 'Label PDF generation failed. No credits deducted.' };
    }

    // Open folder
    require('electron').shell.openPath(batchDir);

    // Auto-print
    for (const f of validFiles) {
      try { await printService.print(f); } catch (printErr) {
        console.error(`[LABEL] Print failed for ${path.basename(f)}: ${printErr.message}`);
      }
    }

    // Deduct credits ONLY here, ONLY after validated PDF save
    const creditsBefore = authService.getLicense()?.remainingCredits || 0;
    console.log(`[CREDIT] Before deduction: ${creditsBefore} credits. Deducting ${entries.length} for ${entries.length} shipments.`);

    await authService.deductCredit(entries.length);

    const creditsAfter = authService.getLicense()?.remainingCredits || 0;
    console.log(`[CREDIT] After deduction: ${creditsAfter} credits. Deducted: ${creditsBefore - creditsAfter}`);

    mainWindow?.webContents.send('license-updated', authService.getLicense());

    console.log(`[LABEL] COMPLETE: ${entries.length} shipments, ${validFiles.length} files, ${entries.length} credits deducted.`);

    return {
      success: true,
      count: entries.length,
      batchDir,
      files: validFiles.map(f => path.basename(f)),
      creditsDeducted: entries.length,
      creditsRemaining: creditsAfter
    };
  } catch (err) {
    if (err.message === 'SESSION_EXPIRED') {
      mainWindow.webContents.send('session-expired');
      return { success: false, error: 'Session expired' };
    }
    console.error('[LABEL] Fatal error:', err.message);
    return { success: false, error: err.message };
  }
});
