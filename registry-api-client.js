const { net } = require('electron');
const fs = require('fs');
const path = require('path');

class RegistryApiClient {
  constructor() {
    this.registry = null;
    this.graphqlOps = null;
    this.authTokens = { csrfToken: null, cookie: null };
    this.sellerConstants = {
      sellerId: null,
      locationId: null
    };
    this.ordersCache = new Map();
  }

  loadRegistry(discoveryDir) {
    const regPath = path.join(discoveryDir, 'api-registry.json');
    const gqlPath = path.join(discoveryDir, 'graphql-operations.json');

    if (!fs.existsSync(regPath)) {
      console.error('[RegistryClient] api-registry.json not found at', regPath);
      return false;
    }

    this.registry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    console.log(`[RegistryClient] Loaded registry: ${Object.keys(this.registry).length} entries`);

    if (fs.existsSync(gqlPath)) {
      this.graphqlOps = JSON.parse(fs.readFileSync(gqlPath, 'utf8'));
      console.log(`[RegistryClient] Loaded graphql ops: ${Object.keys(this.graphqlOps).length} operations`);
    }

    // Extract seller constants from GetStateCount variables
    const stateCount = this.registry['GetStateCount'] || this.graphqlOps?.['GetStateCount'];
    if (stateCount?.variables?.input?.params) {
      this.sellerConstants.sellerId = stateCount.variables.input.params.seller_id;
      this.sellerConstants.locationId = stateCount.variables.input.params.location_id;
      console.log(`[RegistryClient] Seller: ${this.sellerConstants.sellerId}, Location: ${this.sellerConstants.locationId}`);
    }

    return true;
  }

  setAuth(csrfToken, cookie) {
    this.authTokens.csrfToken = csrfToken;
    this.authTokens.cookie = cookie;
  }

  _makeGetRequest(url) {
    return new Promise((resolve, reject) => {
      const headers = {
        'accept': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'x-client-id': 'SD',
        'x-internal-env-type': 'WEB',
        'Origin': 'https://seller.flipkart.com',
        'Referer': 'https://seller.flipkart.com/index.html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Encoding': 'identity'
      };

      if (this.sellerConstants.sellerId) headers['x-user-id'] = this.sellerConstants.sellerId;
      if (this.authTokens.csrfToken) {
        headers['fk-csrf-token'] = this.authTokens.csrfToken;
      }
      if (this.authTokens.cookie) {
        headers['Cookie'] = this.authTokens.cookie;
      }

      if (!this.authTokens.csrfToken && !this.authTokens.cookie) {
        reject(new Error('NO_AUTH'));
        return;
      }

      console.log(`[RegistryClient] GET ${url} csrf:${this.authTokens.csrfToken ? this.authTokens.csrfToken.substring(0, 10) + '...' : 'none'} cookie:${!!this.authTokens.cookie}`);

      const request = net.request({ method: 'GET', url });
      Object.entries(headers).forEach(([k, v]) => {
        try { request.setHeader(k, v); } catch (e) {}
      });

      request.on('response', (response) => {
        const statusCode = response.statusCode;
        console.log(`[RegistryClient] Response ${statusCode} encoding:${response.headers['content-encoding'] || 'none'}`);

        if (statusCode === 401 || statusCode === 403) {
          reject(new Error('SESSION_EXPIRED'));
          return;
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const buf = Buffer.concat(chunks);
          let bodyStr = buf.toString('utf8');

          try {
            const parsed = JSON.parse(bodyStr);
            resolve(parsed);
          } catch (e) {
            console.error(`[RegistryClient] GET JSON parse failed. Status:${statusCode} Length:${bodyStr.length} First100:${bodyStr.substring(0, 100)}`);
            reject(new Error('Invalid JSON response'));
          }
        });
      });

      request.on('error', (err) => {
        console.error('[RegistryClient] GET Request error:', err.message);
        reject(err);
      });
      request.end();
    });
  }

  async fetchLocation() {
    try {
      const url = 'https://seller.flipkart.com/napi/get-locations?locationType=pickup&include=state';
      const data = await this._makeGetRequest(url);
      const locations = data?.result?.multiLocationList;
      if (locations && locations.length > 0) {
        const activeLoc = locations.find(loc => loc.state === 'ACTIVE') || locations[0];
        if (activeLoc && activeLoc.locationId) {
          this.sellerConstants.locationId = activeLoc.locationId;
          console.log(`[RegistryClient] Resolved location: ${this.sellerConstants.locationId} (${activeLoc.locationName || ''})`);
          return this.sellerConstants.locationId;
        }
      }
      console.warn('[RegistryClient] No locations found in get-locations response:', data);
    } catch (err) {
      console.error('[RegistryClient] Failed to fetch locations:', err.message);
    }
    return null;
  }

  // === Core request method using registry templates ===

  _makeRequest(url, payload, isRaw = false) {
    return new Promise((resolve, reject) => {
      const headers = {
        'content-type': 'application/json',
        'accept': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'x-client-id': 'SD',
        'x-internal-env-type': 'WEB',
        'Origin': 'https://seller.flipkart.com',
        'Referer': 'https://seller.flipkart.com/index.html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Encoding': 'identity'
      };

      if (this.sellerConstants.sellerId) headers['x-user-id'] = this.sellerConstants.sellerId;
      if (this.sellerConstants.locationId) headers['x-location-id'] = this.sellerConstants.locationId;
      if (this.authTokens.csrfToken) {
        headers['fk-csrf-token'] = this.authTokens.csrfToken;
      }
      if (this.authTokens.cookie) {
        headers['Cookie'] = this.authTokens.cookie;
      }

      if (!this.authTokens.csrfToken && !this.authTokens.cookie) {
        reject(new Error('NO_AUTH'));
        return;
      }

      console.log(`[RegistryClient] POST ${url} csrf:${this.authTokens.csrfToken ? this.authTokens.csrfToken.substring(0, 10) + '...' : 'none'} cookie:${!!this.authTokens.cookie}`);

      const request = net.request({ method: 'POST', url });
      Object.entries(headers).forEach(([k, v]) => {
        try { request.setHeader(k, v); } catch (e) {}
      });
      request.write(payload);

      request.on('response', (response) => {
        const statusCode = response.statusCode;
        console.log(`[RegistryClient] Response ${statusCode} encoding:${response.headers['content-encoding'] || 'none'}`);

        if (statusCode === 401 || statusCode === 403) {
          reject(new Error('SESSION_EXPIRED'));
          return;
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const buf = Buffer.concat(chunks);
          const contentType = (response.headers['content-type'] || '').toLowerCase();
          
          if (isRaw || contentType.includes('pdf')) {
            resolve(buf);
            return;
          }

          const encoding = (response.headers['content-encoding'] || '').toLowerCase();

          let bodyStr;
          if (encoding === 'gzip') {
            try { bodyStr = require('zlib').gunzipSync(buf).toString('utf8'); }
            catch (e) { bodyStr = buf.toString('utf8'); }
          } else if (encoding === 'deflate') {
            try { bodyStr = require('zlib').inflateSync(buf).toString('utf8'); }
            catch (e) { bodyStr = buf.toString('utf8'); }
          } else if (encoding === 'br') {
            try { bodyStr = require('zlib').brotliDecompressSync(buf).toString('utf8'); }
            catch (e) { bodyStr = buf.toString('utf8'); }
          } else {
            bodyStr = buf.toString('utf8');
          }

          try {
            const parsed = JSON.parse(bodyStr);
            if (parsed.errors?.some(e => e.extensions?.code === 'UNAUTHENTICATED')) {
              reject(new Error('SESSION_EXPIRED'));
              return;
            }
            resolve(parsed);
          } catch (e) {
            console.error(`[RegistryClient] JSON parse failed. Status:${statusCode} Length:${bodyStr.length} First100:${bodyStr.substring(0, 100)}`);
            reject(new Error('Invalid JSON response'));
          }
        });
      });

      request.on('error', (err) => {
        console.error('[RegistryClient] Request error:', err.message);
        reject(err);
      });
      request.end();
    });
  }

  // === Dashboard Stats ===

  async fetchDashboardStats() {
    const op = this._getOp('GetStateCount');
    if (!op) return this._emptyStats();

    const payload = this._buildPayload(op, {
      'input.status': 'pendingToAccept'
    });

    try {
      const data = await this._makeRequest(op.url, payload);
      const counts = data?.data?.shipmentStatesCountAndBreakdown?.shipmentStatesCountMetrics?.shipmentStatesCount;
      if (!counts) return this._emptyStats();

      return {
        toAccept: counts.pendingToAccept || 0,
        toPack: counts.pendingToPack || 0,
        toDispatch: (counts.pendingToDispatch || 0) + (counts.pendingRTD || 0),
        inTransit: counts.inTransit || 0,
        upcoming: counts.upcoming || 0,
        completed: counts.completed || 0
      };
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') throw err;
      console.error('[RegistryClient] Stats fetch failed:', err.message);
      return this._emptyStats();
    }
  }

  // === Order Fetching ===

  async fetchOrders(status, pageNum = 1, pageSize = 20) {
    const op = this._getOp('GetShipmentListByOrderId');
    if (!op) return { shipments: [], hasMore: false, total: 0 };

    const variables = JSON.parse(JSON.stringify(op.variables));
    variables.input.status = status;
    variables.input.paginationInput = { pageNum, pageSize };
    variables.input.timestamp = new Date().toISOString();

    if (this.sellerConstants.sellerId) {
      variables.input.shipmentParams.seller_id = this.sellerConstants.sellerId;
    }
    if (this.sellerConstants.locationId) {
      variables.input.shipmentParams.location_id = this.sellerConstants.locationId;
    }

    const payload = JSON.stringify({
      operationName: op.operationName,
      variables,
      query: op.query
    });

    const data = await this._makeRequest(op.url, payload);
    const groups = data?.data?.filteredShipmentGroups;
    if (!groups) return { shipments: [], hasMore: false, total: 0 };

    let shipments = [];
    if (groups.shipmentGroups) {
      groups.shipmentGroups.forEach(g => {
        if (g.shipments) {
          g.shipments.forEach(s => {
            if (!s.groupId && g.groupId) s.groupId = g.groupId;
            if (!s.packagingPolicy && g.packagingPolicy) s.packagingPolicy = g.packagingPolicy;
            if (!s.channelOfSale && g.channelOfSale) s.channelOfSale = g.channelOfSale;
            this.ordersCache.set(s.shippingId, s);
          });
          shipments = shipments.concat(g.shipments);
        }
      });
    }

    return {
      shipments,
      hasMore: groups.pageInfo?.hasMore || false,
      total: groups.pageInfo?.total || 0
    };
  }

  async fetchAllOrders(status) {
    let all = [];
    let pageNum = 1;
    let hasMore = true;

    while (hasMore && pageNum <= 20) {
      const result = await this.fetchOrders(status, pageNum, 50);
      if (result.shipments.length === 0) break;
      all = all.concat(result.shipments);
      hasMore = result.hasMore;
      pageNum++;
    }

    return all.map(s => this._mapShipment(s, status));
  }

  // === Convenience methods for each status ===

  async fetchToAccept() { return this.fetchAllOrders('pendingToAccept'); }
  async fetchToPack() { return this.fetchAllOrders('pendingToPack'); }
  async fetchPendingDispatch() { return this.fetchAllOrders('pendingToDispatch'); }
  async fetchInTransit() { return this.fetchAllOrders('inTransit'); }
  async fetchCompleted() { return this.fetchAllOrders('completed'); }
  async fetchUpcoming() { return this.fetchAllOrders('upcoming'); }

  // === Order Detail ===

  async fetchOrderDetail(shipmentId) {
    const op = this._getOp('content_by_id');
    if (!op) return null;

    const variables = {
      input: {
        viewType: { shipmentDetails: true },
        shipmentParams: {
          seller_id: this.sellerConstants.sellerId,
          shipment_id: shipmentId,
          location_id: this.sellerConstants.locationId
        }
      }
    };

    const payload = JSON.stringify({
      operationName: 'content_by_id',
      variables,
      query: op.query
    });

    const data = await this._makeRequest(op.url, payload);
    const groups = data?.data?.filteredShipmentGroups?.shipmentGroups;
    if (!groups || !groups[0]?.shipments?.[0]) return null;
    return groups[0].shipments[0];
  }

  // === Helpers ===

  _getOp(name) {
    return this.graphqlOps?.[name] || this.registry?.[name] || null;
  }

  _buildPayload(op, overrides = {}) {
    const variables = JSON.parse(JSON.stringify(op.variables || {}));
    for (const [path, value] of Object.entries(overrides)) {
      this._setNestedValue(variables, path, value);
    }

    if (variables.input?.params) {
      if (this.sellerConstants.sellerId) {
        variables.input.params.seller_id = this.sellerConstants.sellerId;
      }
      if (this.sellerConstants.locationId) {
        variables.input.params.location_id = this.sellerConstants.locationId;
      }
    }

    return JSON.stringify({
      operationName: op.operationName,
      variables,
      query: op.query
    });
  }

  _setNestedValue(obj, path, value) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) current[keys[i]] = {};
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
  }

  _mapShipment(item, defaultStatus) {
    let sku = 'UNKNOWN';
    let quantity = 1;
    let productTitle = '';
    let primaryImageUrl = '';

    if (item.shipmentContents?.shipmentGroupSpecs?.[0]) {
      const spec = item.shipmentContents.shipmentGroupSpecs[0];
      if (spec.listing?.product) {
        sku = spec.listing.product.sku || sku;
        productTitle = spec.listing.product.title || '';
        primaryImageUrl = spec.listing.product.primaryImageUrl || '';
      }
      if (spec.quantity) quantity = spec.quantity;
    }

    return {
      order_id: item.orderId || item.shippingId || 'UNKNOWN',
      shipping_id: item.shippingId,
      sku,
      product_title: productTitle,
      primary_image_url: primaryImageUrl,
      quantity,
      order_status: item.completedStatus || item.trackingStatus || defaultStatus,
      dispatch_date: item.dispatchByDate || '',
      dispatch_after_date: item.dispatchAfterDate || '',
      creation_time: item.creationTime || '',
      seller_price: item.sellerPrice || 0,
      courier_partner: item.tracking?.courierName || '',
      tracking_number: item.tracking?.trackingId || '',
      is_large: item.isLarge || false,
      location_id: item.locationId || '',
      dispatch_service_tier: item.dispatchServiceTier || '',
      shipment_type: item.shipmentType || '',
      channel: item.channelOfSale || '',
      payment_mode: item.paymentMode || '',
      group_id: item.groupId || '',
      is_label_printed: item.isLabelPrinted || false,
      raw_item: item
    };
  }

  // === Discovered APIs Integration ===

  async downloadFileBuffer(url) {
    return new Promise((resolve, reject) => {
      const request = net.request({ method: 'GET', url });
      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve(Buffer.concat(chunks));
        });
      });
      request.on('error', reject);
      request.end();
    });
  }

  async acceptOrders(shipmentIds) {
    const op = this._getOp('AcceptOrders');
    if (!op) throw new Error('AcceptOrders mutation not in registry');

    const groups = [];
    for (const id of shipmentIds) {
      let s = this.ordersCache.get(id);
      if (!s) {
        s = await this.fetchOrderDetail(id);
      }
      if (!s) {
        throw new Error(`Shipment ${id} not found`);
      }

      const pkg = s.shipmentContents?.packages?.[0] || {};
      const dims = pkg.dimensions || {};

      groups.push({
        group_id: s.groupId,
        sub_group_index: s.subGroupIndex !== undefined ? s.subGroupIndex : 0,
        size: s.subShipmentCount || 1,
        dimensions: [
          {
            length: dims.length || 10,
            breadth: dims.breadth || 10,
            height: dims.height || 10,
            weight: dims.weight || 0.5,
            external_sub_shipment_id: pkg.packageId || `PKG_${s.shippingId}`,
            volumetric_weight: Math.ceil(((dims.length || 10) * (dims.breadth || 10) * (dims.height || 10)) / 5000) || 1
          }
        ],
        max_price: s.sellerPrice || 0,
        min_price: s.sellerPrice || 0,
        channel_of_sale: s.channelOfSale || 'FLIPKART',
        packaging_policy: s.packagingPolicy || 'DEFAULT',
        dispatch_by_date: s.dispatchByDate || new Date(Date.now() + 86400000).toISOString()
      });
    }

    const variables = {
      view_name: 'group_shipment',
      timestamp: new Date().toISOString(),
      filters: {},
      groups,
      shipments: [],
      location_id: this.sellerConstants.locationId
    };

    const payload = JSON.stringify({
      operationName: 'AcceptOrders',
      variables,
      query: op.query
    });

    const res = await this._makeRequest(op.url, payload);
    const acceptRes = res?.data?.sfs_revampedOrderShipmentsPackV4;
    if (acceptRes?.error_message) {
      throw new Error(acceptRes.error_message);
    }
    return { success: true, response: acceptRes };
  }

  async rtdOrders(shipmentIds) {
    const op = this._getOp('MarkRTD');
    if (!op) throw new Error('MarkRTD mutation not in registry');

    const groups = [];
    for (const id of shipmentIds) {
      let s = this.ordersCache.get(id);
      if (!s) {
        s = await this.fetchOrderDetail(id);
      }
      if (!s) {
        throw new Error(`Shipment ${id} not found`);
      }

      groups.push({
        group_id: s.groupId,
        sub_group_index: s.subGroupIndex !== undefined ? s.subGroupIndex : 0,
        dispatch_by_date: s.dispatchByDate || new Date(Date.now() + 86400000).toISOString(),
        channel_of_sale: s.channelOfSale || 'FLIPKART',
        packaging_policy: s.packagingPolicy || 'DEFAULT',
        size: s.subShipmentCount || 1
      });
    }

    const variables = {
      view_name: 'group_shipment',
      timestamp: new Date().toISOString(),
      override_label_print: false,
      filters: {},
      groups,
      shipments: [],
      location_id: this.sellerConstants.locationId
    };

    const payload = JSON.stringify({
      operationName: 'MarkRTD',
      variables,
      query: op.query
    });

    const res = await this._makeRequest(op.url, payload);
    const rtdRes = res?.data?.sfs_revampedOrderShipmentsGroupRTD;
    if (rtdRes?.error_message) {
      throw new Error(rtdRes.error_message);
    }
    return { success: true, response: rtdRes };
  }

  async printLabels(shipmentIds, reprint = false) {
    const groups = [];
    for (const id of shipmentIds) {
      let s = this.ordersCache.get(id);
      if (!s) {
        s = await this.fetchOrderDetail(id);
      }
      if (!s) {
        throw new Error(`Shipment ${id} not found`);
      }

      groups.push({
        group_id: s.groupId,
        sub_group_index: s.subGroupIndex !== undefined ? s.subGroupIndex : 0,
        shipment_count: s.subShipmentCount || 1,
        price_range: {
          min_price: s.sellerPrice || 0,
          max_price: s.sellerPrice || 0
        },
        channel_of_sale: s.channelOfSale || 'FLIPKART',
        packaging_policy: s.packagingPolicy || 'DEFAULT',
        dispatch_by_date: s.dispatchByDate || new Date(Date.now() + 86400000).toISOString()
      });
    }

    const payload = {
      timestamp: new Date().toISOString(),
      status: reprint ? 'pendingRTD' : 'pendingLabel',
      view: 'group_shipment',
      shipment_ids: [],
      groups,
      location_id: this.sellerConstants.locationId,
      seller_id: this.sellerConstants.sellerId,
      printer_setting: {}
    };

    const url = `https://seller.flipkart.com/napi/my-orders/revamped-orders-print?reprint=${reprint}`;
    return await this._makeRequest(url, JSON.stringify(payload), true);
  }

  _emptyStats() {
    return { toAccept: 0, toPack: 0, toDispatch: 0, inTransit: 0, upcoming: 0, completed: 0 };
  }
}

module.exports = new RegistryApiClient();
