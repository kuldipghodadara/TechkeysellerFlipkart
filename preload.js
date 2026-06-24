const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Software Auth
  authRegister: (data) => ipcRenderer.invoke('auth-register', data),
  authLogin: (mobileOrEmail, password) => ipcRenderer.invoke('auth-login', { mobileOrEmail, password }),
  authLogout: () => ipcRenderer.invoke('auth-logout'),
  authBootstrap: () => ipcRenderer.invoke('auth-bootstrap'),
  authGetLicense: () => ipcRenderer.invoke('auth-get-license'),
  authGetPlan: () => ipcRenderer.invoke('auth-get-plan'),
  authUpdateProfile: (data) => ipcRenderer.invoke('auth-update-profile', data),

  // License update event (pushed from main after credit deduction)
  onLicenseUpdated: (cb) => ipcRenderer.on('license-updated', (e, lic) => cb(lic)),

  // Flipkart Direct Auth
  fkGetAccounts: () => ipcRenderer.invoke('fk-get-accounts'),
  fkAddAccount: (email, password, displayName) => ipcRenderer.invoke('fk-add-account', { email, password, displayName }),
  fkRemoveAccount: (accountId) => ipcRenderer.invoke('fk-remove-account', accountId),
  fkLogin: (accountId) => ipcRenderer.invoke('fk-login', accountId),
  fkVerifyOtp: (accountId, otp) => ipcRenderer.invoke('fk-verify-otp', { accountId, otp }),
  fkRestoreSession: (accountId) => ipcRenderer.invoke('fk-restore-session', accountId),
  fkLogout: () => ipcRenderer.invoke('fk-logout'),
  onSessionExpired: (cb) => ipcRenderer.on('session-expired', () => cb()),

  // Orders
  getDashboardStats: () => ipcRenderer.invoke('get-dashboard-stats'),
  getOrders: () => ipcRenderer.invoke('get-orders'),
  getToPackOrders: () => ipcRenderer.invoke('get-to-pack-orders'),
  getInTransitOrders: () => ipcRenderer.invoke('get-in-transit-orders'),
  getCompletedOrders: () => ipcRenderer.invoke('get-completed-orders'),
  getUpcomingOrders: () => ipcRenderer.invoke('get-upcoming-orders'),
  getPendingDispatch: () => ipcRenderer.invoke('get-pending-dispatch'),
  getOrdersPage: (status, pageNum, pageSize) => ipcRenderer.invoke('get-orders-page', { status, pageNum, pageSize }),
  exportOrders: () => ipcRenderer.invoke('export-orders'),
  checkRegistry: () => ipcRenderer.invoke('check-registry'),

  // Flipkart Actions
  acceptOrder: (shipmentIds) => ipcRenderer.invoke('accept-order', { shipmentIds }),
  printLabels: (shipmentIds, reprint) => ipcRenderer.invoke('print-labels', { shipmentIds, reprint }),
  rtdOrders: (shipmentIds) => ipcRenderer.invoke('rtd-orders', { shipmentIds }),
  getDownloadFolder: () => ipcRenderer.invoke('get-download-folder'),
  selectDownloadFolder: () => ipcRenderer.invoke('select-download-folder'),
  getOTC: () => ipcRenderer.invoke('get-otc'),

  // Updater
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdaterEvent: (cb) => ipcRenderer.on('updater-event', (e, p) => cb(p))
});
