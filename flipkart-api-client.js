const { net } = require('electron');
const apiDiscovery = require('./api-discovery');

class FlipkartApiClient {
  constructor() {
  }

  makeRequest(method, url, payloadStr, headersOverride = {}) {
    return new Promise((resolve, reject) => {
      const { tokens } = apiDiscovery.getDiscoveredData();
      
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://seller.flipkart.com',
        'Referer': 'https://seller.flipkart.com/',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        ...headersOverride
      };

      if (tokens.bearerToken) headers['Authorization'] = tokens.bearerToken;
      if (tokens.csrfToken) {
          headers['fk-csrf-token'] = tokens.csrfToken;
          headers['X-CSRF-TOKEN'] = tokens.csrfToken;
      }
      if (tokens.cookie) headers['Cookie'] = tokens.cookie;

      const request = net.request({
        method: method,
        url: url,
        headers: headers
      });

      if (method === 'POST' && payloadStr) {
        request.write(payloadStr);
      }

      request.on('response', (response) => {
        let body = '';
        response.on('data', (chunk) => body += chunk.toString());
        response.on('end', () => {
          if (response.statusCode === 401 || response.statusCode === 403) {
            console.error(`[API] Session expired (HTTP ${response.statusCode})`);
            reject(new Error('SESSION_EXPIRED'));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            // Check for GraphQL-level auth errors
            if (parsed.errors && parsed.errors.length > 0) {
              const authErr = parsed.errors.find(e =>
                (e.message || '').toLowerCase().includes('unauthorized') ||
                (e.message || '').toLowerCase().includes('unauthenticated') ||
                (e.extensions && e.extensions.code === 'UNAUTHENTICATED'));
              if (authErr) {
                console.error(`[API] GraphQL auth error: ${authErr.message}`);
                reject(new Error('SESSION_EXPIRED'));
                return;
              }
            }
            resolve(parsed);
          } catch (e) {
            console.error('Failed to parse API response:', body.substring(0, 200));
            reject(e);
          }
        });
      });

      request.on('error', reject);
      request.end();
    });
  }

  async fetchLiveStats() {
    const { apis } = apiDiscovery.getDiscoveredData();
    if (!apis.graphqlUrl || !apis.graphqlStatsPayload) {
      console.log('Cannot fetch stats: GraphQL endpoint or payload not yet discovered.');
      return this._getEmptyStats();
    }

    try {
      const data = await this.makeRequest('POST', apis.graphqlUrl, apis.graphqlStatsPayload);
      
      let countData = {};
      try {
        countData = data.data.shipmentStatesCountAndBreakdown.shipmentStatesCountMetrics.shipmentStatesCount;
      } catch (e) {
        console.log('Error traversing GraphQL response for stats', e);
        return this._getEmptyStats();
      }

      return {
        toAccept: countData.pendingToAccept || 0,
        toPack: countData.pendingToPack || 0,
        toDispatch: (countData.pendingToDispatch || 0) + (countData.pendingRTD || 0),
        inTransit: countData.inTransit || 0,
        upcoming: countData.upcoming || 0,
        completed: countData.completed || 0
      };

    } catch (err) {
      console.error('Failed to fetch live stats', err);
      return this._getEmptyStats();
    }
  }

  _mutatePayload(originalPayloadStr, targetStatuses, targetTab, pageNum = 1) {
    try {
      let payload = JSON.parse(originalPayloadStr);
      
      const traverse = (obj) => {
        for (let key in obj) {
          if (typeof obj[key] === 'string') {
            const val = obj[key].toUpperCase();
            if (val === 'APPROVED' || val === 'PACKING' || val === 'FORM_GENERATED' || val === 'NEW' || val === 'ACTIVE') {
              obj[key] = targetStatuses[0];
            } else if (obj[key] === 'toPack' || obj[key] === 'pendingToDispatch' || obj[key] === 'upcoming' || obj[key] === 'active') {
              obj[key] = targetTab;
            } else if (key === 'status') {
              // Sometimes status is just the direct key
              obj[key] = targetTab;
            }
          } else if (Array.isArray(obj[key])) {
            let hasActive = obj[key].some(v => typeof v === 'string' && ['APPROVED', 'PACKING', 'FORM_GENERATED', 'NEW', 'ACTIVE'].includes(v.toUpperCase()));
            if (hasActive) {
              obj[key] = targetStatuses;
            } else {
              traverse(obj[key]);
            }
          } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            traverse(obj[key]);
          }

          if (key === 'pageSize' || key === 'limit' || key === 'count' || key === 'size') {
            obj[key] = 50; // Use a safe chunk size
          }
          if (key === 'pageNum' || key === 'page' || key === 'pageNo') {
            obj[key] = pageNum;
          }
        }
      };

      traverse(payload);
      return JSON.stringify(payload);
    } catch (e) {
      let p = originalPayloadStr;
      p = p.replace(/APPROVED|PACKING|FORM_GENERATED|NEW|ACTIVE/g, targetStatuses[0]);
      p = p.replace(/toPack|pendingToDispatch/g, targetTab);
      p = p.replace(/"pageSize":\s*\d+/g, '"pageSize":50');
      p = p.replace(/"pageNum":\s*\d+/g, `"pageNum":${pageNum}`);
      return p;
    }
  }

  _extractShipments(data) {
    let shipments = [];
    if (data && data.data && data.data.filteredShipmentGroups && data.data.filteredShipmentGroups.shipmentGroups) {
      data.data.filteredShipmentGroups.shipmentGroups.forEach(group => {
        if (group.shipments) shipments = shipments.concat(group.shipments);
      });
    } else {
      function findShipmentsArray(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (Array.isArray(obj) && obj.length > 0 && (obj[0].orderId || obj[0].shipmentId || obj[0].orderItems)) return obj;
        if (obj.shipments && Array.isArray(obj.shipments)) return obj.shipments;
        if (obj.orders && Array.isArray(obj.orders)) return obj.orders;
        for (let key in obj) {
          if (typeof obj[key] === 'object') {
            let res = findShipmentsArray(obj[key]);
            if (res) return res;
          }
        }
        return null;
      }
      shipments = findShipmentsArray(data) || [];
    }
    return shipments;
  }

  _mapShipment(item, defaultStatus) {
    let sku = 'UNKNOWN';
    let quantity = 1;
    
    // GraphQL extraction
    if (item.shipmentContents && item.shipmentContents.shipmentGroupSpecs && item.shipmentContents.shipmentGroupSpecs[0]) {
      const spec = item.shipmentContents.shipmentGroupSpecs[0];
      if (spec.listing && spec.listing.product && spec.listing.product.sku) sku = spec.listing.product.sku;
      if (spec.quantity) quantity = spec.quantity;
    } 
    // REST extraction
    else {
      sku = item.sku || item.fsn || (item.orderItems && item.orderItems[0] ? item.orderItems[0].sku : 'UNKNOWN');
      quantity = item.quantity || (item.orderItems && item.orderItems[0] ? item.orderItems[0].quantity : 1);
    }

    return {
      order_id: item.orderId || item.shipmentId || item.id || `UNKNOWN_${Date.now()}`,
      sku: sku,
      quantity: quantity,
      order_status: item.completedStatus || item.trackingStatus || item.status || item.orderStatus || defaultStatus,
      dispatch_date: item.dispatchDate || item.dispatchByDate || item.creationTime || new Date().toISOString()
    };
  }

  async fetchCompletedOrders() {
    const { apis } = apiDiscovery.getDiscoveredData();
    if (!apis.ordersUrl || !apis.ordersPayload) {
      console.log('Cannot fetch completed orders: API endpoint not yet discovered.');
      return [];
    }

    try {
      let allShipments = [];
      let pageNum = 1;
      let hasMore = true;

      while (hasMore && pageNum <= 20) { // Max 20 pages (1000 orders) to prevent infinite loop
        const modifiedPayload = this._mutatePayload(apis.ordersPayload, ['COMPLETED'], 'completed', pageNum);
        const data = await this.makeRequest('POST', apis.ordersUrl, modifiedPayload);
        
        const shipments = this._extractShipments(data);
        if (shipments.length === 0) break;
        
        allShipments = allShipments.concat(shipments);

        if (data && data.data && data.data.filteredShipmentGroups && data.data.filteredShipmentGroups.pageInfo) {
          hasMore = data.data.filteredShipmentGroups.pageInfo.hasMore;
        } else {
          // If not GraphQL or no pageInfo, stop after first page to be safe
          hasMore = false;
        }
        pageNum++;
      }

      return allShipments.map(item => this._mapShipment(item, 'COMPLETED'));
    } catch (err) {
      console.error('Failed to fetch completed orders', err);
      return [];
    }
  }

  async fetchInTransitOrders() {
    const { apis } = apiDiscovery.getDiscoveredData();
    if (!apis.ordersUrl || !apis.ordersPayload) {
      console.log('Cannot fetch in-transit orders: API endpoint not yet discovered.');
      return [];
    }

    try {
      let allShipments = [];
      let pageNum = 1;
      let hasMore = true;

      while (hasMore && pageNum <= 20) { // Max 20 pages
        const modifiedPayload = this._mutatePayload(apis.ordersPayload, ['SHIPPED', 'IN_TRANSIT', 'DISPATCHED'], 'inTransit', pageNum);
        const data = await this.makeRequest('POST', apis.ordersUrl, modifiedPayload);
        
        const shipments = this._extractShipments(data);
        if (shipments.length === 0) break;
        
        allShipments = allShipments.concat(shipments);

        if (data && data.data && data.data.filteredShipmentGroups && data.data.filteredShipmentGroups.pageInfo) {
          hasMore = data.data.filteredShipmentGroups.pageInfo.hasMore;
        } else {
          hasMore = false;
        }
        pageNum++;
      }

      return allShipments.map(item => this._mapShipment(item, 'IN_TRANSIT'));
    } catch (err) {
      console.error('Failed to fetch in-transit orders', err);
      return [];
    }
  }

  async fetchActiveOrders() {
    const { apis } = apiDiscovery.getDiscoveredData();
    if (!apis.ordersUrl || !apis.ordersPayload) {
      console.log('Cannot fetch active orders: API not yet discovered.');
      return [];
    }

    try {
      let allShipments = [];
      let pageNum = 1;
      let hasMore = true;

      while (hasMore && pageNum <= 20) {
        const modifiedPayload = this._mutatePayload(apis.ordersPayload, ['NEW', 'APPROVED', 'ACTIVE'], 'active', pageNum);
        const data = await this.makeRequest('POST', apis.ordersUrl, modifiedPayload);

        const shipments = this._extractShipments(data);
        if (shipments.length === 0) break;

        allShipments = allShipments.concat(shipments);

        if (data && data.data && data.data.filteredShipmentGroups && data.data.filteredShipmentGroups.pageInfo) {
          hasMore = data.data.filteredShipmentGroups.pageInfo.hasMore;
        } else {
          hasMore = false;
        }
        pageNum++;
      }

      return allShipments.map(item => this._mapShipmentFull(item, 'ACTIVE'));
    } catch (err) {
      console.error('Failed to fetch active orders', err);
      return [];
    }
  }

  async fetchLiveOrders() {
    // fetchLiveOrders now fetches ACTIVE status orders, not raw replay
    return this.fetchActiveOrders();
  }

  _mapShipmentFull(item, defaultStatus) {
    let sku = 'UNKNOWN_SKU';
    let quantity = 1;
    let productTitle = 'Unknown Product';

    if (item.shipmentContents && item.shipmentContents.shipmentGroupSpecs && item.shipmentContents.shipmentGroupSpecs[0]) {
      const spec = item.shipmentContents.shipmentGroupSpecs[0];
      if (spec.listing && spec.listing.product) {
        sku = spec.listing.product.sku || sku;
        productTitle = spec.listing.product.title || productTitle;
      }
      if (spec.quantity) quantity = spec.quantity;
    } else {
      sku = item.sku || item.fsn || (item.orderItems && item.orderItems[0] ? item.orderItems[0].sku : sku);
      productTitle = item.title || item.productTitle || (item.orderItems && item.orderItems[0] ? item.orderItems[0].title : productTitle);
      quantity = item.quantity || (item.orderItems && item.orderItems[0] ? item.orderItems[0].quantity : 1);
    }

    return {
      order_id: item.orderId || item.shipmentId || item.id || `UNKNOWN_${Date.now()}_${Math.random()}`,
      sku,
      product_title: productTitle,
      quantity,
      customer_city: item.city || item.customerCity || (item.dispatchLocation ? item.dispatchLocation.city : ''),
      courier_partner: item.courier || item.deliveryPartner || (item.logisticPartner ? item.logisticPartner.name : ''),
      tracking_number: item.trackingId || item.awb || (item.logisticPartner ? item.logisticPartner.trackingId : ''),
      order_status: item.completedStatus || item.trackingStatus || item.status || item.orderStatus || defaultStatus,
      dispatch_date: item.dispatchDate || item.dispatchByDate || item.creationTime || new Date().toISOString(),
      warehouse: item.locationId || item.warehouseId || ''
    };
  }

  makeRawRequest(method, url, payloadStr, headersOverride = {}) {
    return new Promise((resolve, reject) => {
      const { tokens } = apiDiscovery.getDiscoveredData();

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://seller.flipkart.com',
        'Referer': 'https://seller.flipkart.com/',
        'Accept': '*/*',
        ...headersOverride
      };

      if (tokens.bearerToken) headers['Authorization'] = tokens.bearerToken;
      if (tokens.csrfToken) {
        headers['fk-csrf-token'] = tokens.csrfToken;
        headers['X-CSRF-TOKEN'] = tokens.csrfToken;
      }
      if (tokens.cookie) headers['Cookie'] = tokens.cookie;

      if (payloadStr) {
        headers['Content-Type'] = 'application/json';
      }

      const request = net.request({ method, url, headers });

      if (method === 'POST' && payloadStr) {
        request.write(payloadStr);
      }

      request.on('response', (response) => {
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

  async fetchToPackOrders() {
    const { apis } = apiDiscovery.getDiscoveredData();
    if (!apis.ordersUrl || !apis.ordersPayload) {
      console.log('Cannot fetch to-pack orders: API endpoint not yet discovered.');
      return [];
    }

    try {
      let allShipments = [];
      let pageNum = 1;
      let hasMore = true;

      while (hasMore && pageNum <= 20) {
        const modifiedPayload = this._mutatePayload(apis.ordersPayload, ['APPROVED', 'FORM_GENERATED', 'PACKING'], 'toPack', pageNum);
        const data = await this.makeRequest('POST', apis.ordersUrl, modifiedPayload);

        const shipments = this._extractShipments(data);
        if (shipments.length === 0) break;

        allShipments = allShipments.concat(shipments);

        if (data && data.data && data.data.filteredShipmentGroups && data.data.filteredShipmentGroups.pageInfo) {
          hasMore = data.data.filteredShipmentGroups.pageInfo.hasMore;
        } else {
          hasMore = false;
        }
        pageNum++;
      }

      return allShipments.map(item => this._mapShipment(item, 'TO_PACK'));
    } catch (err) {
      console.error('Failed to fetch to-pack orders', err);
      return [];
    }
  }

  _getEmptyStats() {
    return {
      toAccept: 0, toPack: 0, toDispatch: 0, inTransit: 0, upcoming: 0, completed: 0
    };
  }
}

module.exports = new FlipkartApiClient();
