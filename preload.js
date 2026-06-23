const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Software Auth (License)
  login: (email, password) => ipcRenderer.invoke('auth-login', { email, password }),
  register: (name, email, mobile, password) => ipcRenderer.invoke('auth-register', { name, email, mobile, password }),
  logout: () => ipcRenderer.invoke('auth-logout'),
  checkAuth: () => ipcRenderer.invoke('auth-check'),

  // Flipkart Direct Auth
  fkGetAccounts: () => ipcRenderer.invoke('fk-get-accounts'),
  fkAddAccount: (email, password, displayName) => ipcRenderer.invoke('fk-add-account', { email, password, displayName }),
  fkRemoveAccount: (accountId) => ipcRenderer.invoke('fk-remove-account', accountId),
  fkLogin: (accountId) => ipcRenderer.invoke('fk-login', accountId),
  fkVerifyOtp: (accountId, otp) => ipcRenderer.invoke('fk-verify-otp', { accountId, otp }),
  fkRestoreSession: (accountId) => ipcRenderer.invoke('fk-restore-session', accountId),
  fkLogout: () => ipcRenderer.invoke('fk-logout'),

  // Session events
  onSessionExpired: (callback) => ipcRenderer.on('session-expired', () => callback()),

  // Orders & Stats
  getDashboardStats: () => ipcRenderer.invoke('get-dashboard-stats'),
  getOrders: () => ipcRenderer.invoke('get-orders'),
  getToPackOrders: () => ipcRenderer.invoke('get-to-pack-orders'),
  getInTransitOrders: () => ipcRenderer.invoke('get-in-transit-orders'),
  getCompletedOrders: () => ipcRenderer.invoke('get-completed-orders'),
  getUpcomingOrders: () => ipcRenderer.invoke('get-upcoming-orders'),
  getPendingDispatch: () => ipcRenderer.invoke('get-pending-dispatch'),
  getOrdersPage: (status, pageNum, pageSize) => ipcRenderer.invoke('get-orders-page', { status, pageNum, pageSize }),

  // Export
  exportOrders: () => ipcRenderer.invoke('export-orders'),

  // Registry
  checkRegistry: () => ipcRenderer.invoke('check-registry'),

  // Active Flipkart APIs
  acceptOrder: (shipmentIds) => ipcRenderer.invoke('accept-order', { shipmentIds }),
  printLabels: (shipmentIds, reprint) => ipcRenderer.invoke('print-labels', { shipmentIds, reprint }),
  rtdOrders: (shipmentIds) => ipcRenderer.invoke('rtd-orders', { shipmentIds }),
  getDownloadFolder: () => ipcRenderer.invoke('get-download-folder'),
  selectDownloadFolder: () => ipcRenderer.invoke('select-download-folder'),
  getOTC: () => ipcRenderer.invoke('get-otc'),

  // Auto Updater
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdaterEvent: (callback) => ipcRenderer.on('updater-event', (e, payload) => callback(payload))
});
