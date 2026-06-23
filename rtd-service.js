const apiDiscovery = require('./api-discovery');
const flipkartApiClient = require('./flipkart-api-client');

class RtdService {
  async processRTD(orderIds) {
    console.log(`[RTD] Starting RTD for ${orderIds.length} orders...`);
    const { apis, tokens } = apiDiscovery.getDiscoveredData();

    if (!tokens.csrfToken && !tokens.cookie) {
      console.error('[RTD] No authentication tokens available');
      return orderIds.map(id => ({ orderId: id, status: 'Failed', error: 'No auth tokens' }));
    }

    if (!apis.rtdUrl) {
      console.error('[RTD] RTD API not discovered. Use "Discover Labels & RTD" in Settings.');
      return orderIds.map(id => ({ orderId: id, status: 'Failed', error: 'RTD API not discovered' }));
    }

    const results = [];

    for (const orderId of orderIds) {
      try {
        const payload = this._buildRTDPayload(orderId);
        const response = await flipkartApiClient.makeRequest('POST', apis.rtdUrl, payload);

        if (response && (response.success || response.status === 'SUCCESS' || !response.error)) {
          console.log(`[RTD] Success: ${orderId}`);
          results.push({ orderId, status: 'Success' });
        } else {
          const errMsg = response?.error || response?.message || 'Unknown error';
          console.error(`[RTD] Failed for ${orderId}: ${errMsg}`);
          results.push({ orderId, status: 'Failed', error: errMsg });
        }
      } catch (err) {
        console.error(`[RTD] Exception for ${orderId}:`, err.message);
        results.push({ orderId, status: 'Failed', error: err.message });
      }

      // Small delay between RTD calls to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
    }

    const successCount = results.filter(r => r.status === 'Success').length;
    console.log(`[RTD] Complete: ${successCount}/${orderIds.length} successful`);
    return results;
  }

  _buildRTDPayload(orderId) {
    const { apis } = apiDiscovery.getDiscoveredData();

    if (apis.rtdPayload) {
      try {
        const payload = JSON.parse(apis.rtdPayload);
        this._injectOrderId(payload, orderId);
        return JSON.stringify(payload);
      } catch (e) {
        // Regex fallback
        return apis.rtdPayload.replace(/["'][A-Z0-9_-]+["']/g, (match) => {
          if (match.length > 10 && (match.includes('OD') || match.includes('SHP'))) {
            return `"${orderId}"`;
          }
          return match;
        });
      }
    }

    // Fallback: construct minimal payload
    return JSON.stringify({
      shipmentIds: [orderId],
      action: 'RTD'
    });
  }

  _injectOrderId(obj, orderId) {
    for (const key in obj) {
      if (typeof obj[key] === 'string') {
        if (key.toLowerCase().includes('shipment') || key.toLowerCase().includes('orderid') || key === 'id') {
          obj[key] = orderId;
        }
      } else if (Array.isArray(obj[key])) {
        if (obj[key].length > 0 && typeof obj[key][0] === 'string') {
          obj[key] = [orderId];
        } else {
          obj[key].forEach(item => {
            if (typeof item === 'object' && item !== null) {
              this._injectOrderId(item, orderId);
            }
          });
        }
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        this._injectOrderId(obj[key], orderId);
      }
    }
  }
}

module.exports = new RtdService();
