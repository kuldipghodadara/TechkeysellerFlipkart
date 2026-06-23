const flipkartApiClient = require('./flipkart-api-client');
const labelDownloadService = require('./label-download-service');
const pdfMergeService = require('./pdf-merge-service');
const rtdService = require('./rtd-service');

class LabelPrinter {
  async generateSortedPDFs(rootFolder) {
    return await this._orchestrate('generate', rootFolder);
  }

  async printSortedPDFs(rootFolder) {
    return await this._orchestrate('print', rootFolder);
  }

  async printAndRTD(rootFolder) {
    return await this._orchestrate('printAndRTD', rootFolder);
  }

  async _orchestrate(mode, rootFolder) {
    try {
      // 1. Fetch To Pack orders
      const orders = await flipkartApiClient.fetchToPackOrders();
      if (!orders || orders.length === 0) {
        return { success: false, message: 'No orders in To Pack status' };
      }

      console.log(`[LabelPrinter] Processing ${orders.length} orders...`);

      // 2. Download labels for all orders
      const labelResults = await labelDownloadService.downloadLabelsForOrders(orders);

      const successfulLabels = labelResults.filter(l => l.pdfBuffer !== null);
      if (successfulLabels.length === 0) {
        return { success: false, message: 'Failed to download any labels. Ensure Labels API is discovered.' };
      }

      console.log(`[LabelPrinter] Downloaded ${successfulLabels.length}/${orders.length} labels`);

      // 3. Generate sorted PDFs (handles SKU sorting and qty separation internally)
      const pdfResult = await pdfMergeService.generateSortedPDFs(orders, labelResults, rootFolder);

      if (!pdfResult.success) {
        return { success: false, message: pdfResult.message || 'PDF generation failed' };
      }

      // 4. Print if requested
      if (mode === 'print' || mode === 'printAndRTD') {
        try {
          const printService = require('./print-service');
          if (pdfResult.skuSortedPath) {
            await printService.print(pdfResult.skuSortedPath);
          }
          if (pdfResult.highQuantityPath) {
            await printService.print(pdfResult.highQuantityPath);
          }
          console.log('[LabelPrinter] Print completed');
        } catch (printErr) {
          console.error('[LabelPrinter] Print failed:', printErr.message);
          // Continue even if print fails - PDFs are still generated
        }
      }

      // 5. RTD if requested
      let rtdCount = 0;
      if (mode === 'printAndRTD') {
        const orderIds = orders.map(o => o.order_id);
        const rtdResults = await rtdService.processRTD(orderIds);
        rtdCount = rtdResults.filter(r => r.status === 'Success').length;
        console.log(`[LabelPrinter] RTD completed: ${rtdCount}/${orderIds.length}`);
      }

      return {
        success: true,
        subfolder: pdfResult.subfolder,
        skuSortedPath: pdfResult.skuSortedPath,
        highQuantityPath: pdfResult.highQuantityPath,
        pages: pdfResult.totalPages,
        skuSortedCount: pdfResult.skuSortedCount,
        highQtyCount: pdfResult.highQtyCount,
        rtdCount
      };
    } catch (err) {
      console.error('[LabelPrinter] Workflow error:', err);
      return { success: false, message: err.message };
    }
  }
}

module.exports = new LabelPrinter();
