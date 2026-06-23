const apiDiscovery = require('./api-discovery');
const flipkartApiClient = require('./flipkart-api-client');

class LabelDownloadService {
  async downloadLabel(shipmentId) {
    const { apis } = apiDiscovery.getDiscoveredData();

    if (!apis.labelsUrl) {
      throw new Error('Labels API not discovered. Use "Discover Labels" in Settings.');
    }

    let payload = null;
    if (apis.labelsPayload) {
      try {
        const parsed = JSON.parse(apis.labelsPayload);
        // Mutate the payload to target this specific shipment
        this._injectShipmentId(parsed, shipmentId);
        payload = JSON.stringify(parsed);
      } catch (e) {
        // Use regex replacement as fallback
        payload = apis.labelsPayload.replace(/["'][A-Z0-9_-]+["']/g, (match) => {
          if (match.includes('OD') || match.includes('shipment')) {
            return `"${shipmentId}"`;
          }
          return match;
        });
      }
    }

    const buffer = await flipkartApiClient.makeRawRequest('POST', apis.labelsUrl, payload);

    // Check if response is a PDF (starts with %PDF)
    if (buffer.length > 4 && buffer.slice(0, 4).toString() === '%PDF') {
      return buffer;
    }

    // If response is JSON, it might contain a URL to the actual PDF
    try {
      const jsonResponse = JSON.parse(buffer.toString());
      if (jsonResponse.url || jsonResponse.labelUrl || jsonResponse.pdfUrl) {
        const pdfUrl = jsonResponse.url || jsonResponse.labelUrl || jsonResponse.pdfUrl;
        return await flipkartApiClient.makeRawRequest('GET', pdfUrl, null);
      }
      if (jsonResponse.data && jsonResponse.data.url) {
        return await flipkartApiClient.makeRawRequest('GET', jsonResponse.data.url, null);
      }
      throw new Error('Label response is JSON but no PDF URL found');
    } catch (e) {
      // If it's not valid JSON either, return the raw buffer (might be binary PDF with different header)
      if (buffer.length > 100) {
        return buffer;
      }
      throw new Error(`Failed to get label for ${shipmentId}: ${e.message}`);
    }
  }

  async downloadLabelsForOrders(orders) {
    const results = [];

    for (const order of orders) {
      try {
        const pdfBuffer = await this.downloadLabel(order.order_id);
        results.push({
          orderId: order.order_id,
          sku: order.sku,
          quantity: order.quantity,
          pdfBuffer
        });
      } catch (err) {
        console.error(`Failed to download label for ${order.order_id}:`, err.message);
        results.push({
          orderId: order.order_id,
          sku: order.sku,
          quantity: order.quantity,
          pdfBuffer: null,
          error: err.message
        });
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    return results;
  }

  _injectShipmentId(obj, shipmentId) {
    for (const key in obj) {
      if (typeof obj[key] === 'string') {
        // Replace shipment/order ID fields
        if (key.toLowerCase().includes('shipment') || key.toLowerCase().includes('orderid') || key === 'id') {
          obj[key] = shipmentId;
        }
      } else if (Array.isArray(obj[key])) {
        // If it's an array of IDs, replace with our single ID
        if (obj[key].length > 0 && typeof obj[key][0] === 'string') {
          obj[key] = [shipmentId];
        } else {
          obj[key].forEach(item => {
            if (typeof item === 'object' && item !== null) {
              this._injectShipmentId(item, shipmentId);
            }
          });
        }
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        this._injectShipmentId(obj[key], shipmentId);
      }
    }
  }
}

module.exports = new LabelDownloadService();
