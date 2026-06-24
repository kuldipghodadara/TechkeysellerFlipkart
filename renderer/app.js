const API = window.electronAPI;
let refreshInterval = null;
let pendingAccountId = null;
let currentLicense = null;

// ========== Utilities ==========
function showScreen(id) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); document.getElementById(id)?.classList.add('active'); }
function toast(msg, isError = false) { const t = document.getElementById('toast'); t.innerText = msg; t.className = 'toast' + (isError ? ' error' : ''); setTimeout(() => t.classList.add('show'), 10); setTimeout(() => t.classList.remove('show'), 3500); }
function fmtDate(d) { if (!d) return '-'; try { return new Date(d).toLocaleDateString(); } catch { return d; } }
function showError(id, msg) { const el = document.getElementById(id); if (el) { el.innerText = msg; el.style.display = ''; } }
function hideError(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
function togglePwdVis(inputId) { const i = document.getElementById(inputId); i.type = i.type === 'password' ? 'text' : 'password'; }

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`)?.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.nav-btn[data-view="${name}"]`)?.classList.add('active');
  const labels = { 'dashboard':'Dashboard','to-accept':'To Accept','to-pack':'To Pack','pending-dispatch':'Pending Dispatch','in-transit':'In Transit','completed':'Completed','upcoming':'Upcoming','profile':'Profile','plan':'Credits','settings':'Settings' };
  document.getElementById('page-heading').innerText = labels[name] || name;
  loadView(name);
}

// ========== License / Credit Gating ==========
function updateLicenseUI(lic) {
  currentLicense = lic;
  const badge = document.getElementById('plan-badge');
  const overlay = document.getElementById('plan-expired-overlay');
  const creditBar = document.getElementById('credit-status-bar');

  if (!lic) { if (badge) badge.style.display = 'none'; return; }

  // Credit counter in status bar
  if (creditBar) {
    creditBar.style.display = '';
    const rem = lic.remainingCredits || 0;
    creditBar.innerText = `Credits: ${rem}`;
    creditBar.className = 'credit-bar' + (rem > 1000 ? ' green' : rem > 100 ? ' orange' : ' red');
  }

  // Top badge
  if (badge) {
    badge.style.display = '';
    if (lic.active && lic.remainingCredits > 0) {
      badge.innerText = `${lic.remainingCredits} credits`;
      badge.className = 'status-badge online';
      badge.style.background = ''; badge.style.color = '';
    } else {
      badge.innerText = lic.status !== 'active' ? 'Account Inactive' : 'No Credits';
      badge.className = 'status-badge';
      badge.style.background = 'rgba(239,68,68,0.1)'; badge.style.color = 'var(--danger)';
    }
  }

  // Overlay locks entire Flipkart section
  const locked = !lic.active || lic.remainingCredits <= 0;
  if (overlay) {
    overlay.style.display = locked ? '' : 'none';
    const msg = document.getElementById('plan-expired-message');
    if (msg) msg.innerText = lic.status !== 'active' ? 'Your account is inactive. Contact administrator.' : 'No credits remaining.';
  }

  // Lock/unlock Add Account + Flipkart Login entry points
  const addBtn = document.getElementById('btn-show-add');
  const saveBtn = document.getElementById('btn-save-account');
  if (addBtn) { addBtn.disabled = locked; addBtn.style.opacity = locked ? '0.4' : ''; }
  if (saveBtn) { saveBtn.disabled = locked; }
}

// Listen for real-time credit updates pushed from main process after label download
API.onLicenseUpdated((lic) => {
  if (!lic) return;
  updateLicenseUI(lic);
  // Refresh plan card on dashboard instantly
  API.authGetPlan().then(plan => updateDashboardPlanCard(lic, plan));
  // If plan view is currently visible, refresh its numbers
  const planView = document.getElementById('view-plan');
  if (planView?.classList.contains('active')) loadPlanView();
});

// Hard-lock all Flipkart features (expired cache, blocked, no credits)
function lockFlipcart(msg) {
  const overlay = document.getElementById('plan-expired-overlay');
  if (overlay) { overlay.style.display = ''; }
  const m = document.getElementById('plan-expired-message');
  if (m) m.innerText = msg;
  const badge = document.getElementById('plan-badge');
  if (badge) { badge.style.display = ''; badge.innerText = 'Locked'; badge.className = 'status-badge'; badge.style.background = 'rgba(239,68,68,0.1)'; badge.style.color = 'var(--danger)'; }
  toast(msg, true);
}

// ========== Software Auth ==========
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('auth-form-login').style.display = tab.dataset.tab === 'login' ? '' : 'none';
    document.getElementById('auth-form-register').style.display = tab.dataset.tab === 'register' ? '' : 'none';
    hideError('login-error'); hideError('register-error');
  });
});

document.getElementById('btn-auth-login')?.addEventListener('click', async () => {
  const m = document.getElementById('login-mobile-email').value.trim(), p = document.getElementById('login-password').value;
  if (!m || !p) return showError('login-error', 'All fields required');
  hideError('login-error');
  const btn = document.getElementById('btn-auth-login'); btn.disabled = true; btn.innerText = 'Signing in...';
  try { const r = await API.authLogin(m, p); if (r.success) { updateLicenseUI(r.license); proceedToFlipkartAccounts(); } else showError('login-error', r.error || 'Login failed'); }
  catch (err) { showError('login-error', err.message); }
  btn.disabled = false; btn.innerText = 'Login';
});
document.getElementById('login-password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('btn-auth-login')?.click(); });

document.getElementById('btn-auth-register')?.addEventListener('click', async () => {
  const mob = document.getElementById('reg-mobile').value.trim(), sn = document.getElementById('reg-seller-name').value.trim(), gst = document.getElementById('reg-gst').value.trim(), em = document.getElementById('reg-email').value.trim(), pw = document.getElementById('reg-password').value, cpw = document.getElementById('reg-confirm-password').value;
  if (!mob || !sn || !em || !pw || !cpw) return showError('register-error', 'Fill all required fields');
  if (pw.length < 6) return showError('register-error', 'Password min 6 chars');
  if (pw !== cpw) return showError('register-error', 'Passwords do not match');
  hideError('register-error');
  const btn = document.getElementById('btn-auth-register'); btn.disabled = true; btn.innerText = 'Creating...';
  try { const r = await API.authRegister({ mobile: mob, sellerName: sn, gstNumber: gst, email: em, password: pw, confirmPassword: cpw }); if (r.success) { updateLicenseUI(r.license); toast('Account created! 50 credits available.'); proceedToFlipkartAccounts(); } else showError('register-error', r.error || 'Failed'); }
  catch (err) { showError('register-error', err.message); }
  btn.disabled = false; btn.innerText = 'Create Account';
});

function proceedToFlipkartAccounts() { showScreen('screen-accounts'); renderAccounts(); }

document.getElementById('btn-software-logout')?.addEventListener('click', async () => { await API.authLogout(); await API.fkLogout(); stopAutoRefresh(); currentLicense = null; showScreen('screen-auth'); });

// ========== Flipkart Account Picker ==========
async function renderAccounts() {
  const accounts = await API.fkGetAccounts();
  const list = document.getElementById('account-list'); list.innerHTML = '';
  if (!accounts.length) { document.getElementById('accounts-status').innerText = 'No accounts saved. Add one to get started.'; return; }
  document.getElementById('accounts-status').innerText = '';
  accounts.forEach(a => {
    const div = document.createElement('div'); div.className = 'account-card';
    div.innerHTML = `<div class="account-avatar">${(a.displayName||a.email)[0].toUpperCase()}</div><div class="account-info"><div class="account-name">${a.displayName||a.email}</div><div class="account-email">${a.email}</div></div><button class="account-remove" data-id="${a.id}">&times;</button>`;
    div.addEventListener('click', (e) => { if (e.target.classList.contains('account-remove')) return; loginAccount(a.id); });
    div.querySelector('.account-remove').addEventListener('click', async (e) => { e.stopPropagation(); await API.fkRemoveAccount(a.id); renderAccounts(); });
    list.appendChild(div);
  });
}

document.getElementById('btn-show-add')?.addEventListener('click', () => {
  if (currentLicense && (!currentLicense.active || currentLicense.remainingCredits <= 0)) { toast('License inactive. Cannot add accounts.', true); return; }
  document.getElementById('add-account-form').style.display = 'block'; document.getElementById('btn-show-add').style.display = 'none';
});
document.getElementById('btn-cancel-add')?.addEventListener('click', () => { document.getElementById('add-account-form').style.display = 'none'; document.getElementById('btn-show-add').style.display = ''; });
document.getElementById('btn-save-account')?.addEventListener('click', async () => {
  if (currentLicense && (!currentLicense.active || currentLicense.remainingCredits <= 0)) { toast('License inactive. Cannot add accounts.', true); return; }
  const email = document.getElementById('new-acc-email').value.trim(), password = document.getElementById('new-acc-password').value, name = document.getElementById('new-acc-name').value.trim();
  if (!email || !password) return showError('add-error', 'Email and password required');
  const result = await API.fkAddAccount(email, password, name);
  if (result?.error) { showError('add-error', result.error); return; }
  document.getElementById('new-acc-email').value = ''; document.getElementById('new-acc-password').value = ''; document.getElementById('new-acc-name').value = '';
  document.getElementById('add-account-form').style.display = 'none'; document.getElementById('btn-show-add').style.display = '';
  const accs = await API.fkGetAccounts(); const latest = accs[accs.length - 1]; if (latest) loginAccount(latest.id); else renderAccounts();
});
document.getElementById('btn-toggle-password')?.addEventListener('click', () => togglePwdVis('new-acc-password'));

async function loginAccount(accountId) {
  if (currentLicense && (!currentLicense.active || currentLicense.remainingCredits <= 0)) {
    toast(currentLicense.status !== 'active' ? 'Account inactive. Contact administrator.' : 'No credits remaining.', true);
    return;
  }
  pendingAccountId = accountId;
  document.getElementById('accounts-status').innerText = 'Checking session...'; hideError('add-error');
  const restored = await API.fkRestoreSession(accountId);
  if (restored.success) { document.getElementById('accounts-status').innerText = ''; enterDashboard(); return; }
  document.getElementById('accounts-status').innerText = 'Signing in...';
  const result = await API.fkLogin(accountId);
  document.getElementById('accounts-status').innerText = '';
  if (result.success && result.needsOtp) { showScreen('screen-otp'); document.getElementById('otp-input').value = ''; document.getElementById('otp-input').focus(); hideError('otp-error'); const i = result.otpInfo; if (i) { const p = []; if (i.email) p.push(i.email); if (i.mobile) p.push(i.mobile); document.getElementById('otp-subtitle').innerText = 'OTP sent to ' + p.join(' and '); } }
  else showError('add-error', result.error || 'Login failed');
}

// ========== OTP ==========
document.getElementById('btn-verify-otp')?.addEventListener('click', verifyOtp);
document.getElementById('otp-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyOtp(); });
document.getElementById('btn-back-accounts')?.addEventListener('click', () => { showScreen('screen-accounts'); renderAccounts(); });
async function verifyOtp() {
  const otp = document.getElementById('otp-input').value.trim();
  if (!otp || otp.length < 4) return showError('otp-error', 'Enter valid OTP');
  document.getElementById('otp-spinner').style.display = ''; document.getElementById('btn-verify-otp').disabled = true; hideError('otp-error');
  const r = await API.fkVerifyOtp(pendingAccountId, otp);
  document.getElementById('otp-spinner').style.display = 'none'; document.getElementById('btn-verify-otp').disabled = false;
  if (r.success) enterDashboard(); else showError('otp-error', r.error || 'OTP failed');
}

// ========== Dashboard ==========
async function enterDashboard() {
  showScreen('screen-dashboard'); showView('dashboard'); setConnected(true); loadStats(); startAutoRefresh();
  setTimeout(() => API.checkForUpdates(), 5000);
  const accs = await API.fkGetAccounts();
  const cur = accs.find(a => a.id === pendingAccountId);
  if (cur) { const el = document.getElementById('current-account-name'); if (el) el.innerText = cur.displayName || cur.email; }
}

function setConnected(v) { const b = document.getElementById('connection-status'); b.innerText = v ? 'Connected' : 'Disconnected'; b.className = 'status-badge' + (v ? ' online' : ''); }
function startAutoRefresh() { stopAutoRefresh(); refreshInterval = setInterval(loadStats, 60000); }
function stopAutoRefresh() { if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; } }

// ========== Nav ==========
document.querySelectorAll('.nav-btn').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));
document.querySelectorAll('.stat-card[data-nav]').forEach(c => c.addEventListener('click', () => showView(c.dataset.nav)));
document.getElementById('btn-switch-account')?.addEventListener('click', () => { stopAutoRefresh(); API.fkLogout(); setConnected(false); showScreen('screen-accounts'); renderAccounts(); });
document.getElementById('btn-relogin')?.addEventListener('click', () => { document.getElementById('session-banner').style.display = 'none'; stopAutoRefresh(); showScreen('screen-accounts'); renderAccounts(); });
document.getElementById('btn-export')?.addEventListener('click', async () => { const r = await API.exportOrders(); if (r?.success) toast('Exported: ' + r.path); else if (r?.message !== 'Cancelled') toast(r?.message || 'Export failed', true); });
API.onSessionExpired(() => { document.getElementById('session-banner').style.display = 'flex'; setConnected(false); stopAutoRefresh(); });

// ========== Sync License (manual refresh button) ==========
document.getElementById('btn-sync-license')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-sync-license'); btn.disabled = true; btn.innerText = 'Syncing...';
  const r = await API.authBootstrap();
  btn.disabled = false; btn.innerText = 'Sync License';
  if (r.authenticated === false) { stopAutoRefresh(); showScreen('screen-auth'); showError('login-error', r.error || 'Session expired'); return; }
  if (r.license) {
    updateLicenseUI(r.license);
    updateDashboardPlanCard(r.license, r.assignedPlan);
    if (r.validated) toast('License verified!');
    else if (r.expired) { lockFlipcart(r.error || 'Cache expired. Connect to internet.'); return; }
    else toast('License synced (cached)');
  }
  if (r.user) {
    document.getElementById('profile-seller-name').innerText = r.user.sellerName || '-';
    document.getElementById('profile-mobile').innerText = r.user.mobile || '-';
    document.getElementById('profile-gst').innerText = r.user.gstNumber || '-';
    document.getElementById('profile-email').innerText = r.user.email || '-';
    document.getElementById('profile-created').innerText = fmtDate(r.user.createdAt);
  }
});

// ========== Data Loaders ==========
async function loadView(name) {
  switch (name) {
    case 'dashboard': loadStats(); break;
    case 'to-accept': loadTableProgressive('to-accept', 'pendingToAccept', ['order_id','sku','product_title','quantity','seller_price','dispatch_date']); break;
    case 'to-pack': loadToPackSKUs(); break;
    case 'pending-dispatch': loadPendingDispatch(); break;
    case 'in-transit': loadTableProgressive('in-transit', 'inTransit', ['order_id','sku','order_status','quantity','courier_partner']); break;
    case 'completed': loadTableProgressive('completed', 'completed', ['order_id','sku','order_status','quantity','dispatch_date']); break;
    case 'upcoming': loadTableProgressive('upcoming', 'upcoming', ['order_id','sku','product_title','quantity','seller_price','dispatch_after_date']); break;
    case 'profile': loadProfile(); break;
    case 'plan': loadPlanView(); break;
    case 'settings': loadSettings(); break;
  }
}

async function loadStats() {
  const s = await API.getDashboardStats(); if (!s) return;
  document.getElementById('stat-to-accept').innerText = s.toAccept;
  document.getElementById('stat-to-pack').innerText = s.toPack;
  document.getElementById('stat-to-dispatch').innerText = s.toDispatch;
  document.getElementById('stat-in-transit').innerText = s.inTransit;
  document.getElementById('stat-upcoming').innerText = s.upcoming;
  document.getElementById('stat-completed').innerText = s.completed;
  document.getElementById('last-updated').innerText = 'Updated ' + new Date().toLocaleTimeString();
}

async function loadTableProgressive(viewId, status, fields) {
  const tbody = document.getElementById(`tbody-${viewId}`), loader = document.getElementById(`loader-${viewId}`);
  tbody.innerHTML = ''; if (loader) loader.style.display = '';
  let pg = 1, more = true, tot = 0;
  while (more && pg <= 20) {
    const r = await API.getOrdersPage(status, pg, 500); if (!r || !r.shipments.length) break;
    r.shipments.forEach(item => {
      const m = mapShipment(item, status); const tr = document.createElement('tr');
      let html = fields.map(f => { let v = m[f]; if (f === 'seller_price' && v) v = '₹'+v; if (f.includes('date')) v = fmtDate(v); if (f === 'order_status') return `<td><span class="badge badge-blue">${v||'-'}</span></td>`; return `<td>${v||'-'}</td>`; }).join('');
      if (viewId === 'to-accept') html = `<td class="checkbox-cell"><input type="checkbox" class="checkbox-to-accept-single" data-shipping-id="${m.shipping_id}"></td>` + html + `<td><button class="btn btn-sm btn-primary btn-accept" data-shipping-id="${m.shipping_id}">Accept</button></td>`;
      tr.innerHTML = html; tbody.appendChild(tr);
    });
    more = r.hasMore; tot += r.shipments.length;
    if (loader) loader.innerHTML = `<div class="spinner"></div><span>Loaded ${tot}...</span>`;
    pg++;
  }
  if (loader) loader.style.display = 'none';
  if (!tot) { const cs = viewId === 'to-accept' ? fields.length+2 : fields.length; tbody.innerHTML = `<tr><td colspan="${cs}" class="empty-state">No orders</td></tr>`; }
  if (viewId === 'to-accept') { const cb = document.getElementById('checkbox-to-accept-select-all'); if (cb) cb.checked = false; updateAcceptSelectionCount(); }
}

function mapShipment(item, status) {
  let sku = '', title = '', qty = 1;
  if (item.shipmentContents?.shipmentGroupSpecs?.[0]) { const sp = item.shipmentContents.shipmentGroupSpecs[0]; sku = sp.listing?.product?.sku || ''; title = sp.listing?.product?.title || ''; qty = sp.quantity || 1; }
  return { order_id: item.orderId||item.shippingId||'', sku, product_title: title, quantity: qty, order_status: item.completedStatus||item.trackingStatus||status, dispatch_date: item.dispatchByDate||'', dispatch_after_date: item.dispatchAfterDate||'', seller_price: item.sellerPrice||0, courier_partner: item.tracking?.courierName||'', shipping_id: item.shippingId, group_id: item.groupId||'', is_label_printed: item.isLabelPrinted||false, tracking_number: item.tracking?.trackingId||'-', raw_item: item };
}

let toPackOrdersCache = [];
async function loadToPackSKUs() {
  const sb = document.getElementById('tbody-to-pack-summary'), db2 = document.getElementById('tbody-to-pack-details'), ld = document.getElementById('loader-to-pack');
  sb.innerHTML = '<tr><td colspan="3" class="empty-state">Loading...</td></tr>'; db2.innerHTML = '<tr><td colspan="8" class="empty-state">Loading...</td></tr>';
  if (ld) { ld.style.display = ''; ld.innerHTML = '<div class="spinner"></div><span>Loading...</span>'; }
  toPackOrdersCache = await API.getToPackOrders() || []; if (ld) ld.style.display = 'none';
  const sum = {};
  toPackOrdersCache.forEach(i => { const m = mapShipment(i, 'pendingToPack'); const s = m.sku||'UNKNOWN'; if (!sum[s]) sum[s] = { c:0,o:0,p:0,u:0 }; sum[s].c += m.quantity; sum[s].o++; if (m.is_label_printed) sum[s].p++; else sum[s].u++; });
  sb.innerHTML = ''; const skus = Object.keys(sum).sort();
  if (!skus.length) sb.innerHTML = '<tr><td colspan="3" class="empty-state">No orders</td></tr>';
  else skus.forEach(sk => { const s = sum[sk]; const st = s.u > 0 ? `<span class="badge badge-yellow">${s.u} Pending</span>` : `<span class="badge badge-green">Ready</span>`; const tr = document.createElement('tr'); tr.innerHTML = `<td style="font-weight:600;color:var(--primary);">${sk}</td><td><span class="badge badge-blue">${s.c} (${s.o})</span></td><td>${st}</td>`; sb.appendChild(tr); });
  db2.innerHTML = '';
  if (!toPackOrdersCache.length) db2.innerHTML = '<tr><td colspan="8" class="empty-state">No orders</td></tr>';
  else toPackOrdersCache.forEach(i => { const m = mapShipment(i, 'pendingToPack'); const tr = document.createElement('tr'); const lb = m.is_label_printed ? '<span class="badge badge-green">Printed</span>' : '<span class="badge badge-yellow">Pending</span>'; const ab = m.is_label_printed ? `<button class="btn btn-sm btn-primary btn-pack-rtd" data-shipping-id="${m.shipping_id}">RTD</button>` : `<button class="btn btn-sm btn-outline btn-pack-print" data-shipping-id="${m.shipping_id}">Print</button>`; tr.innerHTML = `<td class="checkbox-cell"><input type="checkbox" class="checkbox-to-pack-single" data-shipping-id="${m.shipping_id}"></td><td>${m.order_id}</td><td style="font-weight:600;">${m.sku}</td><td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${m.product_title}">${m.product_title}</td><td>${m.quantity}</td><td>₹${m.seller_price}</td><td>${lb}</td><td>${ab}</td>`; db2.appendChild(tr); });
  document.getElementById('checkbox-to-pack-select-all').checked = false; updateSelectionCount();
}

function updateSelectionCount() { const c = document.querySelectorAll('.checkbox-to-pack-single:checked').length; document.getElementById('to-pack-selected-count').innerText = `${c} selected`; document.getElementById('btn-bulk-print').disabled = c === 0; document.getElementById('btn-bulk-rtd').disabled = c === 0; }
function updateAcceptSelectionCount() { const c = document.querySelectorAll('.checkbox-to-accept-single:checked').length; const el = document.getElementById('to-accept-selected-count'); if (el) el.innerText = `${c} selected`; const btn = document.getElementById('btn-bulk-accept'); if (btn) btn.disabled = c === 0; }

// ========== Profile & Credits Views (no API call — reads cached data) ==========
async function loadProfile() {
  const r = await API.authBootstrap(); // use bootstrap for freshest data
  if (r.user) {
    document.getElementById('profile-seller-name').innerText = r.user.sellerName || '-';
    document.getElementById('profile-mobile').innerText = r.user.mobile || '-';
    document.getElementById('profile-gst').innerText = r.user.gstNumber || '-';
    document.getElementById('profile-email').innerText = r.user.email || '-';
    document.getElementById('profile-created').innerText = fmtDate(r.user.createdAt);
  }
  if (r.license) { updateLicenseUI(r.license); updateDashboardPlanCard(r.license, r.assignedPlan); }
}

async function loadPlanView() {
  const lic = await API.authGetLicense();
  const plan = await API.authGetPlan();
  if (lic) {
    document.getElementById('plan-type').innerText = plan?.planName || (lic.active ? 'Credit Plan' : 'Inactive');
    document.getElementById('plan-status').innerHTML = lic.active ? '<span class="badge badge-green">Active</span>' : '<span class="badge" style="background:rgba(239,68,68,0.1);color:var(--danger);">Inactive</span>';
    document.getElementById('plan-total-credits').innerText = lic.totalCredits || 0;
    document.getElementById('plan-used-credits').innerText = lic.usedCredits || 0;
    document.getElementById('plan-remaining-credits').innerText = lic.remainingCredits || 0;
    const priceEl = document.getElementById('plan-price');
    const cpoEl = document.getElementById('plan-cost-per-order');
    if (priceEl) priceEl.innerText = plan?.price ? `Rs. ${plan.price}` : '-';
    if (cpoEl) cpoEl.innerText = plan?.costPerOrder ? `Rs. ${plan.costPerOrder}` : '-';
    document.getElementById('plan-warning').style.display = lic.active ? 'none' : '';
    updateLicenseUI(lic);
  }
}

function updateDashboardPlanCard(lic, plan) {
  const card = document.getElementById('dashboard-plan-card');
  if (!card) return;
  card.style.display = '';
  const name = card.querySelector('.plan-card-name');
  const rem = card.querySelector('.plan-card-remaining');
  const cpo = card.querySelector('.plan-card-cpo');
  const st = card.querySelector('.plan-card-status');
  if (name) name.innerText = plan?.planName || 'No Plan';
  if (rem) rem.innerText = lic?.remainingCredits || 0;
  if (cpo) cpo.innerText = plan?.costPerOrder ? `Rs. ${plan.costPerOrder}` : '-';
  if (st) { st.innerText = lic?.active ? 'Active' : 'Inactive'; st.className = 'plan-card-status badge ' + (lic?.active ? 'badge-green' : 'badge-yellow'); }
}

async function loadSettings() {
  const accs = await API.fkGetAccounts();
  document.getElementById('settings-accounts').innerHTML = accs.map(a => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);"><div><strong>${a.displayName||a.email}</strong><br><span class="meta-text">${a.email} ${a.sellerId ? '/ '+a.sellerId : ''}</span></div></div>`).join('') || '<p class="meta-text">No accounts</p>';
  const reg = await API.checkRegistry(); document.getElementById('settings-registry').innerText = reg.exists ? `Registry: ${reg.entryCount} APIs` : 'No registry';
  const folder = await API.getDownloadFolder(); const inp = document.getElementById('settings-download-folder'); if (inp) inp.value = folder || '';
}

// ========== Pending Dispatch with OTC ==========
async function loadPendingDispatch() {
  loadTableProgressive('pending-dispatch', 'pendingToDispatch', ['order_id','sku','quantity','dispatch_date','courier_partner','tracking_number']);
  const otcBanner = document.getElementById('otc-banner'), otcValue = document.getElementById('otc-value');
  if (otcBanner) otcBanner.style.display = 'none';
  try { const d = await API.getOTC(); if (d && !d.has_error && d.otc_details?.length > 0) { if (otcValue) otcValue.innerText = d.otc_details.map(x => `${x.type}: ${x.otc}`).join(' | '); if (otcBanner) otcBanner.style.display = ''; } else if (d?.has_error) { if (otcValue) otcValue.innerText = d.error_code === 'OTC_UNAVAILABLE' ? 'No pickup scheduled' : (d.error_code || 'Unavailable'); if (otcBanner) otcBanner.style.display = ''; } } catch {}
}

// ========== Flipkart Event Handlers ==========
async function refreshAll() { await loadStats(); const btn = document.querySelector('.nav-btn.active'); if (btn?.dataset.view) loadView(btn.dataset.view); }

document.getElementById('tbody-to-accept')?.addEventListener('click', async (e) => { const btn = e.target.closest('.btn-accept'); if (!btn) return; btn.disabled = true; btn.innerText = 'Accepting...'; try { const r = await API.acceptOrder([btn.dataset.shippingId]); if (r?.success) { toast('Accepted!'); await refreshAll(); } else { toast(r?.error === 'LICENSE_INACTIVE' ? r.message : (r?.error||'Failed'), true); btn.disabled = false; btn.innerText = 'Accept'; } } catch (err) { toast(err.message, true); btn.disabled = false; btn.innerText = 'Accept'; } });

document.getElementById('tbody-to-pack-details')?.addEventListener('click', async (e) => {
  const bp = e.target.closest('.btn-pack-print'), br = e.target.closest('.btn-pack-rtd');
  if (bp) { bp.disabled = true; bp.innerText = 'Printing...'; try { const r = await API.printLabels([bp.dataset.shippingId], false); if (r?.success) { toast(`Printed! (${r.creditsDeducted} credit used, ${r.creditsRemaining} left)`); await refreshAll(); } else { toast(r?.message||r?.error||'Failed', true); bp.disabled = false; bp.innerText = 'Print'; } } catch (err) { toast(err.message, true); bp.disabled = false; bp.innerText = 'Print'; } }
  if (br) { br.disabled = true; br.innerText = 'RTD...'; try { const r = await API.rtdOrders([br.dataset.shippingId]); if (r?.success) { toast('RTD!'); await refreshAll(); } else { toast(r?.message||r?.error||'Failed', true); br.disabled = false; br.innerText = 'RTD'; } } catch (err) { toast(err.message, true); br.disabled = false; br.innerText = 'RTD'; } }
});

document.getElementById('checkbox-to-pack-select-all')?.addEventListener('change', (e) => { document.querySelectorAll('.checkbox-to-pack-single').forEach(cb => cb.checked = e.target.checked); updateSelectionCount(); });
document.getElementById('tbody-to-pack-details')?.addEventListener('change', (e) => { if (e.target.classList.contains('checkbox-to-pack-single')) updateSelectionCount(); });
document.getElementById('btn-to-pack-select-all')?.addEventListener('click', () => { document.querySelectorAll('.checkbox-to-pack-single').forEach(cb => cb.checked = true); document.getElementById('checkbox-to-pack-select-all').checked = true; updateSelectionCount(); });
document.getElementById('btn-to-pack-deselect-all')?.addEventListener('click', () => { document.querySelectorAll('.checkbox-to-pack-single').forEach(cb => cb.checked = false); document.getElementById('checkbox-to-pack-select-all').checked = false; updateSelectionCount(); });

document.getElementById('btn-bulk-print')?.addEventListener('click', async () => { const ids = [...document.querySelectorAll('.checkbox-to-pack-single:checked')].map(c => c.dataset.shippingId); if (!ids.length) return; const btn = document.getElementById('btn-bulk-print'); btn.disabled = true; const ot = btn.innerText; btn.innerText = 'Printing...'; try { const r = await API.printLabels(ids, false); if (r?.success) { toast(`Printed ${r.count} labels! (${r.creditsDeducted} credits used, ${r.creditsRemaining} left)`); await refreshAll(); } else toast(r?.message||r?.error||'Failed', true); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; btn.innerText = ot; } });
document.getElementById('btn-bulk-rtd')?.addEventListener('click', async () => { const ids = [...document.querySelectorAll('.checkbox-to-pack-single:checked')].map(c => c.dataset.shippingId); if (!ids.length) return; const btn = document.getElementById('btn-bulk-rtd'); btn.disabled = true; const ot = btn.innerText; btn.innerText = 'RTD...'; try { const r = await API.rtdOrders(ids); if (r?.success) { toast(`RTD ${ids.length}!`); await refreshAll(); } else toast(r?.message||r?.error||'Failed', true); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; btn.innerText = ot; } });

document.getElementById('checkbox-to-accept-select-all')?.addEventListener('change', (e) => { document.querySelectorAll('.checkbox-to-accept-single').forEach(cb => cb.checked = e.target.checked); updateAcceptSelectionCount(); });
document.getElementById('tbody-to-accept')?.addEventListener('change', (e) => { if (e.target.classList.contains('checkbox-to-accept-single')) updateAcceptSelectionCount(); });
document.getElementById('btn-bulk-accept')?.addEventListener('click', async () => { const ids = [...document.querySelectorAll('.checkbox-to-accept-single:checked')].map(c => c.dataset.shippingId); if (!ids.length) return; const btn = document.getElementById('btn-bulk-accept'); btn.disabled = true; const ot = btn.innerText; btn.innerText = 'Accepting...'; try { const r = await API.acceptOrder(ids); if (r?.success) { toast(`Accepted ${ids.length}!`); await refreshAll(); } else toast(r?.message||r?.error||'Failed', true); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; btn.innerText = ot; updateAcceptSelectionCount(); } });
document.getElementById('btn-select-download-folder')?.addEventListener('click', async () => { const f = await API.selectDownloadFolder(); if (f) { document.getElementById('settings-download-folder').value = f; toast('Folder updated'); } });

// ========== Init: ONE API call on startup ==========
(async function init() {
  const r = await API.authBootstrap();
  if (r.authenticated === false) {
    const msg = r.reason === 'blocked' ? 'Your account has been blocked.' : r.reason === 'deleted' ? 'Account not found.' : r.reason === 'suspended' ? 'Account suspended.' : null;
    showScreen('screen-auth');
    if (msg) showError('login-error', msg);
    return;
  }
  updateLicenseUI(r.license);
  updateDashboardPlanCard(r.license, r.assignedPlan);

  // Cache expired (>24h) and server unreachable — lock Flipkart features
  if (r.expired) {
    proceedToFlipkartAccounts();
    lockFlipcart(r.error || 'License cache expired. Connect to internet and restart.');
    return;
  }

  proceedToFlipkartAccounts();
})();

// ========== Auto Updater ==========
API.onUpdaterEvent((payload) => {
  const { event, data } = payload;
  const banner = document.getElementById('updateBanner'), overlay = document.getElementById('updateOverlay'), title = document.getElementById('updateTitle'), msg = document.getElementById('updateMessage'), pc = document.getElementById('updateProgressContainer'), pb = document.getElementById('updateProgressBar'), st = document.getElementById('updateStatusText'), ba = document.getElementById('btnUpdateAction');
  switch (event) {
    case 'checking-for-update': banner.classList.add('show'); title.innerText = 'Checking...'; msg.innerText = 'Looking for updates...'; pc.style.display = 'none'; st.innerText = ''; ba.style.display = 'none'; break;
    case 'update-available': banner.classList.add('show'); title.innerText = 'Update Available'; msg.innerHTML = `New: <b>${data.version}</b>`; pc.style.display = 'block'; break;
    case 'download-progress': pb.style.width = `${data.percent.toFixed(1)}%`; st.innerText = `${(data.transferred/1e6).toFixed(1)}/${(data.total/1e6).toFixed(1)} MB`; break;
    case 'update-downloaded': banner.classList.add('show'); overlay.style.display = 'block'; title.innerText = 'Restart Required'; pc.style.display = 'none'; st.innerText = ''; ba.style.display = 'block'; ba.innerText = 'Restart Now'; ba.onclick = () => { ba.innerText = 'Installing...'; ba.disabled = true; API.installUpdate(); }; break;
    case 'update-not-available': if (banner.classList.contains('show')) { title.innerText = 'Up to Date'; setTimeout(() => banner.classList.remove('show'), 2000); } break;
    case 'error': if (banner.classList.contains('show')) { st.innerText = 'Error: '+data; setTimeout(() => banner.classList.remove('show'), 4000); } break;
  }
});
