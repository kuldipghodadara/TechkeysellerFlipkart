const { createObjectCsvWriter } = require('csv-writer');
const flipkartApiClient = require('./flipkart-api-client');

class ExportService {
  async exportOrdersToCSV(filePath) {
    try {
      const orders = await flipkartApiClient.fetchCompletedOrders();
      if (!orders || orders.length === 0) {
        return { success: false, message: 'No orders available to export.' };
      }
      return await this._writeCSV(filePath, orders);
    } catch (error) {
      console.error('Failed to export CSV:', error);
      return { success: false, message: error.message };
    }
  }

  async exportInTransitOrdersToCSV(filePath) {
    try {
      const orders = await flipkartApiClient.fetchInTransitOrders();
      if (!orders || orders.length === 0) {
        return { success: false, message: 'No in-transit orders available to export.' };
      }
      return await this._writeCSV(filePath, orders);
    } catch (error) {
      console.error('Failed to export in-transit CSV:', error);
      return { success: false, message: error.message };
    }
  }

  async _writeCSV(filePath, orders) {
    try {

      const csvWriter = createObjectCsvWriter({
        path: filePath,
        header: [
          { id: 'order_id', title: 'Order ID' },
          { id: 'sku', title: 'SKU Name' },
          { id: 'quantity', title: 'Quantity' },
          { id: 'order_status', title: 'Status' },
          { id: 'dispatch_date', title: 'Dispatch Date' }
        ]
      });

      const records = orders.map(o => ({
        order_id: o.order_id,
        sku: o.sku,
        quantity: o.quantity,
        order_status: o.order_status,
        dispatch_date: new Date(o.dispatch_date).toLocaleDateString()
      }));

      await csvWriter.writeRecords(records);
      return { success: true, path: filePath };
    } catch (error) {
      console.error('Failed to export CSV:', error);
      return { success: false, message: error.message };
    }
  }
}

module.exports = new ExportService();
