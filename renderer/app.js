const API = window.electronAPI;
let refreshInterval = null;
let pendingAccountId = null;

// ========== Screen Management ==========
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`)?.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.nav-btn[data-view="${name}"]`)?.classList.add('active');
  const labels = { 'dashboard': 'Dashboard', 'to-accept': 'To Accept', 'to-pack': 'To Pack', 'pending-dispatch': 'Pending Dispatch', 'in-transit': 'In Transit', 'completed': 'Completed', 'upcoming': 'Upcoming', 'settings': 'Settings' };
  document.getElementById('page-heading').innerText = labels[name] || name;
  loadView(name);
}

function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.innerText = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => t.classList.remove('show'), 3500);
}

function fmtDate(d) { if (!d) return '-'; try { return new Date(d).toLocaleDateString(); } catch (e) { return d; } }

// ========== Account Picker ==========
async function renderAccounts() {
  const accounts = await API.fkGetAccounts();
  const list = document.getElementById('account-list');
  list.innerHTML = '';
  if (accounts.length === 0) {
    document.getElementById('accounts-status').innerText = 'No accounts saved. Add one to get started.';
    return;
  }
  document.getElementById('accounts-status').innerText = '';
  accounts.forEach(a => {
    const div = document.createElement('div');
    div.className = 'account-card';
    div.innerHTML = `<div class="account-avatar">${(a.displayName || a.email)[0].toUpperCase()}</div><div class="account-info"><div class="account-name">${a.displayName || a.email}</div><div class="account-email">${a.email}</div></div><button class="account-remove" data-id="${a.id}" title="Remove">&times;</button>`;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('account-remove')) return;
      loginAccount(a.id);
    });
    div.querySelector('.account-remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      await API.fkRemoveAccount(a.id);
      renderAccounts();
    });
    list.appendChild(div);
  });
}

document.getElementById('btn-show-add')?.addEventListener('click', () => {
  document.getElementById('add-account-form').style.display = 'block';
  document.getElementById('btn-show-add').style.display = 'none';
});

document.getElementById('btn-cancel-add')?.addEventListener('click', () => {
  document.getElementById('add-account-form').style.display = 'none';
  document.getElementById('btn-show-add').style.display = '';
});

document.getElementById('btn-save-account')?.addEventListener('click', async () => {
  const email = document.getElementById('new-acc-email').value.trim();
  const password = document.getElementById('new-acc-password').value;
  const name = document.getElementById('new-acc-name').value.trim();
  if (!email || !password) return showError('add-error', 'Email and password are required');
  await API.fkAddAccount(email, password, name);
  document.getElementById('new-acc-email').value = '';
  document.getElementById('new-acc-password').value = '';
  document.getElementById('new-acc-name').value = '';
  document.getElementById('add-account-form').style.display = 'none';
  document.getElementById('btn-show-add').style.display = '';
  const accounts = await API.fkGetAccounts();
  const latest = accounts[accounts.length - 1];
  if (latest) loginAccount(latest.id);
  else renderAccounts();
});

document.getElementById('btn-toggle-password')?.addEventListener('click', () => {
  const pwdInput = document.getElementById('new-acc-password');
  const icon = document.getElementById('eye-icon');
  if (pwdInput.type === 'password') {
    pwdInput.type = 'text';
    icon.innerHTML = '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>';
  } else {
    pwdInput.type = 'password';
    icon.innerHTML = '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>';
  }
});

async function loginAccount(accountId) {
  pendingAccountId = accountId;
  document.getElementById('accounts-status').innerText = 'Checking session...';
  hideError('add-error');

  // Try restoring saved session for this account first
  const restored = await API.fkRestoreSession(accountId);
  if (restored.success) {
    document.getElementById('accounts-status').innerText = '';
    enterDashboard();
    return;
  }

  document.getElementById('accounts-status').innerText = 'Signing in...';
  const result = await API.fkLogin(accountId);
  document.getElementById('accounts-status').innerText = '';
  if (result.success && result.needsOtp) {
    showScreen('screen-otp');
    document.getElementById('otp-input').value = '';
    document.getElementById('otp-input').focus();
    hideError('otp-error');
    // Show where OTP was sent
    const info = result.otpInfo;
    if (info) {
      const parts = [];
      if (info.email) parts.push(info.email);
      if (info.mobile) parts.push(info.mobile);
      document.getElementById('otp-subtitle').innerText = 'OTP sent to ' + parts.join(' and ');
    } else {
      document.getElementById('otp-subtitle').innerText = 'Enter the OTP sent to your registered number';
    }
  } else {
    showError('add-error', result.error || 'Login failed');
  }
}

// ========== OTP ==========
document.getElementById('btn-verify-otp')?.addEventListener('click', verifyOtp);
document.getElementById('otp-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyOtp(); });
document.getElementById('btn-back-accounts')?.addEventListener('click', () => { showScreen('screen-accounts'); renderAccounts(); });

async function verifyOtp() {
  const otp = document.getElementById('otp-input').value.trim();
  if (!otp || otp.length < 4) return showError('otp-error', 'Enter a valid OTP');
  document.getElementById('otp-spinner').style.display = '';
  document.getElementById('btn-verify-otp').disabled = true;
  hideError('otp-error');

  const result = await API.fkVerifyOtp(pendingAccountId, otp);
  document.getElementById('otp-spinner').style.display = 'none';
  document.getElementById('btn-verify-otp').disabled = false;

  if (result.success) {
    console.log('[OTP SUCCESS]', { sellerId: result.sellerId, hasCsrf: result.hasCsrf });
    enterDashboard();
  } else {
    console.error('[OTP FAILED]', result);
    let errorMsg = result.error || 'OTP verification failed';
    if (result.debug) {
      errorMsg += ` (seller=${result.debug.sellerId}, login=${result.debug.isLogin})`;
    }
    showError('otp-error', errorMsg);
  }
}

// ========== Dashboard ==========
async function enterDashboard() {
  showScreen('screen-dashboard');
  showView('dashboard');
  setConnected(true);
  loadStats();
  startAutoRefresh();

  setTimeout(() => {
    API.checkForUpdates();
  }, 5000);

  const accounts = await API.fkGetAccounts();
  const current = accounts.find(a => a.id === pendingAccountId);
  if (current) {
    const el = document.getElementById('current-account-name');
    if (el) el.innerText = current.displayName || current.email;
  }
}

function setConnected(v) {
  const badge = document.getElementById('connection-status');
  badge.innerText = v ? 'Connected' : 'Disconnected';
  badge.className = 'status-badge' + (v ? ' online' : '');
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshInterval = setInterval(loadStats, 60000);
}

function stopAutoRefresh() {
  if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
}

// ========== Navigation ==========
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

document.querySelectorAll('.stat-card[data-nav]').forEach(card => {
  card.addEventListener('click', () => showView(card.dataset.nav));
});

document.getElementById('btn-switch-account')?.addEventListener('click', () => {
  stopAutoRefresh();
  API.fkLogout();
  setConnected(false);
  showScreen('screen-accounts');
  renderAccounts();
});

document.getElementById('btn-relogin')?.addEventListener('click', () => {
  document.getElementById('session-banner').style.display = 'none';
  stopAutoRefresh();
  showScreen('screen-accounts');
  renderAccounts();
});

document.getElementById('btn-export')?.addEventListener('click', async () => {
  const r = await API.exportOrders();
  if (r?.success) toast('Exported: ' + r.path);
  else if (r?.message !== 'Cancelled') toast(r?.message || 'Export failed', true);
});

API.onSessionExpired(() => {
  document.getElementById('session-banner').style.display = 'flex';
  setConnected(false);
  stopAutoRefresh();
});

// ========== Data Loaders ==========
async function loadView(name) {
  switch (name) {
    case 'dashboard': loadStats(); break;
    case 'to-accept': loadTableProgressive('to-accept', 'pendingToAccept', ['order_id', 'sku', 'product_title', 'quantity', 'seller_price', 'dispatch_date']); break;
    case 'to-pack': loadToPackSKUs(); break;
    case 'pending-dispatch': loadTableProgressive('pending-dispatch', 'pendingToDispatch', ['order_id', 'sku', 'quantity', 'dispatch_date', 'courier_partner']); break;
    case 'in-transit': loadTableProgressive('in-transit', 'inTransit', ['order_id', 'sku', 'order_status', 'quantity', 'courier_partner']); break;
    case 'completed': loadTableProgressive('completed', 'completed', ['order_id', 'sku', 'order_status', 'quantity', 'dispatch_date']); break;
    case 'upcoming': loadTableProgressive('upcoming', 'upcoming', ['order_id', 'sku', 'product_title', 'quantity', 'seller_price', 'dispatch_after_date']); break;
    case 'settings': loadSettings(); break;
  }
}

async function loadStats() {
  const stats = await API.getDashboardStats();
  if (!stats) return;
  document.getElementById('stat-to-accept').innerText = stats.toAccept;
  document.getElementById('stat-to-pack').innerText = stats.toPack;
  document.getElementById('stat-to-dispatch').innerText = stats.toDispatch;
  document.getElementById('stat-in-transit').innerText = stats.inTransit;
  document.getElementById('stat-upcoming').innerText = stats.upcoming;
  document.getElementById('stat-completed').innerText = stats.completed;
  document.getElementById('last-updated').innerText = 'Updated ' + new Date().toLocaleTimeString();
}

async function loadTableProgressive(viewId, status, fields) {
  const tbody = document.getElementById(`tbody-${viewId}`);
  const loader = document.getElementById(`loader-${viewId}`);
  tbody.innerHTML = '';
  if (loader) loader.style.display = '';

  let pageNum = 1;
  let hasMore = true;
  let total = 0;

  while (hasMore && pageNum <= 20) {
    const result = await API.getOrdersPage(status, pageNum, 500);
    if (!result || result.shipments.length === 0) break;

    result.shipments.forEach(item => {
      const mapped = mapShipment(item, status);
      const tr = document.createElement('tr');
      let html = fields.map(f => {
        let val = mapped[f];
        if (f === 'seller_price' && val) val = '₹' + val;
        if (f.includes('date')) val = fmtDate(val);
        if (f === 'order_status') return `<td><span class="badge badge-blue">${val || '-'}</span></td>`;
        return `<td>${val || '-'}</td>`;
      }).join('');

      if (viewId === 'to-accept') {
        html = `<td class="checkbox-cell" style="text-align: center;"><input type="checkbox" class="checkbox-to-accept-single" data-shipping-id="${mapped.shipping_id}"></td>` + html;
        html += `<td>
          <button class="btn btn-sm btn-primary btn-accept" data-shipping-id="${mapped.shipping_id}">Accept</button>
        </td>`;
      }

      tr.innerHTML = html;
      tbody.appendChild(tr);
    });

    hasMore = result.hasMore;
    total += result.shipments.length;
    if (loader) loader.innerHTML = `<div class="spinner"></div><span>Loaded ${total} orders...</span>`;
    pageNum++;
  }

  if (loader) loader.style.display = 'none';
  if (total === 0) {
    const colSpan = viewId === 'to-accept' ? fields.length + 2 : fields.length;
    tbody.innerHTML = `<tr><td colspan="${colSpan}" class="empty-state">No orders</td></tr>`;
  }

  if (viewId === 'to-accept') {
    const selectAllCheckbox = document.getElementById('checkbox-to-accept-select-all');
    if (selectAllCheckbox) selectAllCheckbox.checked = false;
    updateAcceptSelectionCount();
  }
}

function mapShipment(item, status) {
  let sku = '', title = '', qty = 1;
  if (item.shipmentContents?.shipmentGroupSpecs?.[0]) {
    const spec = item.shipmentContents.shipmentGroupSpecs[0];
    sku = spec.listing?.product?.sku || '';
    title = spec.listing?.product?.title || '';
    qty = spec.quantity || 1;
  }
  return {
    order_id: item.orderId || item.shippingId || '',
    sku,
    product_title: title,
    quantity: qty,
    order_status: item.completedStatus || item.trackingStatus || status,
    dispatch_date: item.dispatchByDate || '',
    dispatch_after_date: item.dispatchAfterDate || '',
    seller_price: item.sellerPrice || 0,
    courier_partner: item.tracking?.courierName || '',
    shipping_id: item.shippingId,
    group_id: item.groupId || '',
    is_label_printed: item.isLabelPrinted || false,
    raw_item: item
  };
}

let toPackOrdersCache = [];

async function loadToPackSKUs() {
  const summaryBody = document.getElementById('tbody-to-pack-summary');
  const detailsBody = document.getElementById('tbody-to-pack-details');
  const loader = document.getElementById('loader-to-pack');

  summaryBody.innerHTML = '<tr><td colspan="3" class="empty-state">Loading...</td></tr>';
  detailsBody.innerHTML = '<tr><td colspan="8" class="empty-state">Loading...</td></tr>';
  if (loader) {
    loader.style.display = '';
    loader.innerHTML = '<div class="spinner"></div><span>Loading to-pack data...</span>';
  }

  const result = await API.getToPackOrders();
  toPackOrdersCache = result || [];

  if (loader) loader.style.display = 'none';

  // 1. SKU Summary Computation
  const summary = {};
  toPackOrdersCache.forEach(item => {
    const mapped = mapShipment(item, 'pendingToPack');
    const sku = mapped.sku || 'UNKNOWN';
    if (!summary[sku]) {
      summary[sku] = { count: 0, orders: 0, printed: 0, unprinted: 0 };
    }
    summary[sku].count += mapped.quantity;
    summary[sku].orders++;
    if (mapped.is_label_printed) {
      summary[sku].printed++;
    } else {
      summary[sku].unprinted++;
    }
  });

  summaryBody.innerHTML = '';
  const skus = Object.keys(summary).sort();
  if (skus.length === 0) {
    summaryBody.innerHTML = '<tr><td colspan="3" class="empty-state">No orders</td></tr>';
  } else {
    skus.forEach(sku => {
      const s = summary[sku];
      const statusText = s.unprinted > 0 ?
        `<span class="badge badge-yellow">${s.unprinted} Label Pending</span>` :
        `<span class="badge badge-green">Ready to Dispatch</span>`;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td style="font-weight:600;color:var(--primary);">${sku}</td>
                      <td><span class="badge badge-blue">${s.count} (${s.orders} orders)</span></td>
                      <td>${statusText}</td>`;
      summaryBody.appendChild(tr);
    });
  }

  // 2. Render Detailed Order List
  detailsBody.innerHTML = '';
  if (toPackOrdersCache.length === 0) {
    detailsBody.innerHTML = '<tr><td colspan="8" class="empty-state">No orders to pack</td></tr>';
  } else {
    toPackOrdersCache.forEach(item => {
      const mapped = mapShipment(item, 'pendingToPack');
      const tr = document.createElement('tr');

      const labelBadge = mapped.is_label_printed ?
        `<span class="badge badge-green">Printed</span>` :
        `<span class="badge badge-yellow">Pending</span>`;

      const actionBtn = mapped.is_label_printed ?
        `<button class="btn btn-sm btn-primary btn-pack-rtd" data-shipping-id="${mapped.shipping_id}">Mark RTD</button>` :
        `<button class="btn btn-sm btn-outline btn-pack-print" data-shipping-id="${mapped.shipping_id}">Print Label</button>`;

      tr.innerHTML = `
        <td class="checkbox-cell"><input type="checkbox" class="checkbox-to-pack-single" data-shipping-id="${mapped.shipping_id}"></td>
        <td>${mapped.order_id}</td>
        <td style="font-weight:600;">${mapped.sku}</td>
        <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${mapped.product_title}">${mapped.product_title}</td>
        <td>${mapped.quantity}</td>
        <td>₹${mapped.seller_price}</td>
        <td>${labelBadge}</td>
        <td>${actionBtn}</td>
      `;
      detailsBody.appendChild(tr);
    });
  }

  // Reset checkboxes selection state
  document.getElementById('checkbox-to-pack-select-all').checked = false;
  updateSelectionCount();
}

function updateSelectionCount() {
  const checked = document.querySelectorAll('.checkbox-to-pack-single:checked');
  const count = checked.length;
  document.getElementById('to-pack-selected-count').innerText = `${count} selected`;

  const btnBulkPrint = document.getElementById('btn-bulk-print');
  const btnBulkRtd = document.getElementById('btn-bulk-rtd');

  if (count > 0) {
    btnBulkPrint.disabled = false;
    btnBulkRtd.disabled = false;
  } else {
    btnBulkPrint.disabled = true;
    btnBulkRtd.disabled = true;
  }
}

function updateAcceptSelectionCount() {
  const checked = document.querySelectorAll('.checkbox-to-accept-single:checked');
  const count = checked.length;
  const countEl = document.getElementById('to-accept-selected-count');
  if (countEl) countEl.innerText = `${count} selected`;

  const btnBulkAccept = document.getElementById('btn-bulk-accept');
  if (btnBulkAccept) {
    btnBulkAccept.disabled = count === 0;
  }
}

async function loadSettings() {
  const accounts = await API.fkGetAccounts();
  const el = document.getElementById('settings-accounts');
  el.innerHTML = accounts.map(a => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);"><div><strong>${a.displayName || a.email}</strong><br><span class="meta-text">${a.email} ${a.sellerId ? '/ ' + a.sellerId : ''}</span></div></div>`).join('') || '<p class="meta-text">No accounts</p>';

  const reg = await API.checkRegistry();
  document.getElementById('settings-registry').innerText = reg.exists ? `Registry active: ${reg.entryCount} APIs` : 'No registry found';

  // Load download folder path
  const folder = await API.getDownloadFolder();
  const input = document.getElementById('settings-download-folder');
  if (input) {
    input.value = folder || '';
  }
}

function showError(id, msg) { const el = document.getElementById(id); if (el) { el.innerText = msg; el.style.display = ''; } }
function hideError(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

// ========== Active Flipkart Event Handlers ==========

async function refreshAll() {
  await loadStats();
  const activeNavBtn = document.querySelector('.nav-btn.active');
  if (activeNavBtn) {
    const viewName = activeNavBtn.dataset.view;
    if (viewName) loadView(viewName);
  }
}

document.getElementById('tbody-to-accept')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-accept');
  if (!btn) return;
  const shippingId = btn.dataset.shippingId;
  btn.disabled = true;
  btn.innerText = 'Accepting...';
  try {
    const res = await API.acceptOrder([shippingId]);
    if (res && res.success) {
      toast('Order accepted successfully!');
      await refreshAll();
    } else {
      toast(res?.error || 'Failed to accept order', true);
      btn.disabled = false;
      btn.innerText = 'Accept';
    }
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
    btn.innerText = 'Accept';
  }
});

document.getElementById('tbody-to-pack-details')?.addEventListener('click', async (e) => {
  const btnPrint = e.target.closest('.btn-pack-print');
  const btnRtd = e.target.closest('.btn-pack-rtd');

  if (btnPrint) {
    const shippingId = btnPrint.dataset.shippingId;
    btnPrint.disabled = true;
    btnPrint.innerText = 'Printing...';
    try {
      const res = await API.printLabels([shippingId], false);
      if (res && res.success) {
        toast('Label printed successfully!');
        await refreshAll();
      } else {
        toast(res?.error || 'Failed to print label', true);
        btnPrint.disabled = false;
        btnPrint.innerText = 'Print Label';
      }
    } catch (err) {
      toast(err.message, true);
      btnPrint.disabled = false;
      btnPrint.innerText = 'Print Label';
    }
  }

  if (btnRtd) {
    const shippingId = btnRtd.dataset.shippingId;
    btnRtd.disabled = true;
    btnRtd.innerText = 'Marking RTD...';
    try {
      const res = await API.rtdOrders([shippingId]);
      if (res && res.success) {
        toast('Order marked as RTD!');
        await refreshAll();
      } else {
        toast(res?.error || 'Failed to mark RTD', true);
        btnRtd.disabled = false;
        btnRtd.innerText = 'Mark RTD';
      }
    } catch (err) {
      toast(err.message, true);
      btnRtd.disabled = false;
      btnRtd.innerText = 'Mark RTD';
    }
  }
});

document.getElementById('checkbox-to-pack-select-all')?.addEventListener('change', (e) => {
  const checked = e.target.checked;
  document.querySelectorAll('.checkbox-to-pack-single').forEach(cb => {
    cb.checked = checked;
  });
  updateSelectionCount();
});

document.getElementById('tbody-to-pack-details')?.addEventListener('change', (e) => {
  if (e.target.classList.contains('checkbox-to-pack-single')) {
    updateSelectionCount();
  }
});

document.getElementById('btn-bulk-print')?.addEventListener('click', async () => {
  const checked = document.querySelectorAll('.checkbox-to-pack-single:checked');
  const ids = Array.from(checked).map(cb => cb.dataset.shippingId);
  if (ids.length === 0) return;

  const btn = document.getElementById('btn-bulk-print');
  btn.disabled = true;
  const originalText = btn.innerText;
  btn.innerText = 'Printing Bulk...';

  try {
    const res = await API.printLabels(ids, false);
    if (res && res.success) {
      toast(`Successfully printed ${res.count} labels!`);
      await refreshAll();
    } else {
      toast(res?.error || 'Bulk print failed', true);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerText = originalText;
  }
});

document.getElementById('btn-bulk-rtd')?.addEventListener('click', async () => {
  const checked = document.querySelectorAll('.checkbox-to-pack-single:checked');
  const ids = Array.from(checked).map(cb => cb.dataset.shippingId);
  if (ids.length === 0) return;

  const btn = document.getElementById('btn-bulk-rtd');
  btn.disabled = true;
  const originalText = btn.innerText;
  btn.innerText = 'Marking RTD Bulk...';

  try {
    const res = await API.rtdOrders(ids);
    if (res && res.success) {
      toast(`Successfully marked ${ids.length} orders as RTD!`);
      await refreshAll();
    } else {
      toast(res?.error || 'Bulk RTD failed', true);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerText = originalText;
  }
});

document.getElementById('checkbox-to-accept-select-all')?.addEventListener('change', (e) => {
  const checked = e.target.checked;
  document.querySelectorAll('.checkbox-to-accept-single').forEach(cb => {
    cb.checked = checked;
  });
  updateAcceptSelectionCount();
});

document.getElementById('tbody-to-accept')?.addEventListener('change', (e) => {
  if (e.target.classList.contains('checkbox-to-accept-single')) {
    updateAcceptSelectionCount();
  }
});

document.getElementById('btn-bulk-accept')?.addEventListener('click', async () => {
  const checked = document.querySelectorAll('.checkbox-to-accept-single:checked');
  const ids = Array.from(checked).map(cb => cb.dataset.shippingId);
  if (ids.length === 0) return;

  const btn = document.getElementById('btn-bulk-accept');
  btn.disabled = true;
  const originalText = btn.innerText;
  btn.innerText = 'Accepting Selected...';

  try {
    const res = await API.acceptOrder(ids);
    if (res && res.success) {
      toast(`Successfully accepted ${ids.length} orders!`);
      await refreshAll();
    } else {
      toast(res?.error || 'Failed to accept orders', true);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerText = originalText;
    updateAcceptSelectionCount();
  }
});

document.getElementById('btn-select-download-folder')?.addEventListener('click', async () => {
  const folder = await API.selectDownloadFolder();
  if (folder) {
    const input = document.getElementById('settings-download-folder');
    if (input) input.value = folder;
    toast('Download folder updated successfully');
  }
});

// ========== Init ==========
(async function init() {
  showScreen('screen-accounts');
  renderAccounts();
  // No auto-API calls. User picks account first.
  // Session restore happens when user clicks an account.
})();

// ========== Auto Updater UI Logic ==========
API.onUpdaterEvent((payload) => {
  const { event, data } = payload;
  const banner = document.getElementById('updateBanner');
  const overlay = document.getElementById('updateOverlay');
  const title = document.getElementById('updateTitle');
  const msg = document.getElementById('updateMessage');
  const progressContainer = document.getElementById('updateProgressContainer');
  const progressBar = document.getElementById('updateProgressBar');
  const statusText = document.getElementById('updateStatusText');
  const btnAction = document.getElementById('btnUpdateAction');

  switch (event) {
    case 'checking-for-update':
      banner.classList.add('show');
      title.innerText = 'Checking for Updates';
      msg.innerText = 'Looking for a new version of Seller Dashboard...';
      progressContainer.style.display = 'none';
      statusText.innerText = 'Please wait...';
      btnAction.style.display = 'none';
      break;
    case 'update-available':
      if (!banner.classList.contains('show')) banner.classList.add('show');
      title.innerText = 'Update Available';
      msg.innerHTML = `Current Version: <b>${payload.currentVersion}</b><br>New Version: <b>${data.version}</b><br>Downloading update...`;
      progressContainer.style.display = 'block';
      statusText.innerText = 'Initializing download...';
      break;
    case 'download-progress':
      const speedMB = (data.bytesPerSecond / 1000000).toFixed(2);
      const transferredMB = (data.transferred / 1000000).toFixed(2);
      const totalMB = (data.total / 1000000).toFixed(2);
      const percent = data.percent.toFixed(1);

      progressBar.style.width = `${percent}%`;
      statusText.innerText = `${transferredMB} MB / ${totalMB} MB - ${speedMB} MB/s (${percent}%)`;
      break;
    case 'update-downloaded':
      banner.classList.add('show');
      overlay.style.display = 'block';
      title.innerText = 'Update Ready - Restart Required';
      msg.innerHTML = `Current Version: <b>${payload.currentVersion}</b><br>New Version: <b>${data.version}</b><br>The update has been successfully downloaded and is ready to install.`;
      progressContainer.style.display = 'none';
      statusText.innerText = 'Please restart to apply the update.';

      btnAction.style.display = 'block';
      btnAction.innerText = 'Restart Now';

      btnAction.onclick = () => {
        btnAction.innerText = 'Installing...';
        btnAction.disabled = true;
        API.installUpdate();
      };
      break;
    case 'update-not-available':
      if (banner.classList.contains('show')) {
        title.innerText = 'Up to Date';
        msg.innerText = 'You are running the latest version.';
        statusText.innerText = '';
        setTimeout(() => banner.classList.remove('show'), 3000);
      }
      break;
    case 'error':
      if (banner.classList.contains('show')) {
        statusText.innerText = 'Update failed: ' + data;
        setTimeout(() => banner.classList.remove('show'), 5000);
      }
      break;
  }
});
