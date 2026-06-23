const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

class PdfMergeService {
  createTimestampedSubfolder(rootFolder) {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
    const folderName = `Flipkart_${dateStr}_${timeStr}`;
    const fullPath = path.join(rootFolder, folderName);

    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }

    return fullPath;
  }

  async generateSortedPDFs(orders, labelResults, rootFolder) {
    try {
      const subfolder = this.createTimestampedSubfolder(rootFolder);

      // Separate orders: qty=1 (SKU sorted) vs qty>1 (high quantity)
      const singleQtyLabels = [];
      const highQtyLabels = [];

      for (const label of labelResults) {
        if (!label.pdfBuffer) continue;
        if (label.quantity > 1) {
          highQtyLabels.push(label);
        } else {
          singleQtyLabels.push(label);
        }
      }

      // Sort single-quantity labels by SKU ascending
      singleQtyLabels.sort((a, b) => (a.sku || '').localeCompare(b.sku || ''));

      let skuSortedPath = null;
      let highQuantityPath = null;
      let totalPages = 0;

      // Generate SKU_Sorted_Labels.pdf
      if (singleQtyLabels.length > 0) {
        const result = await this._mergePDFBuffers(
          singleQtyLabels.map(l => l.pdfBuffer),
          path.join(subfolder, 'SKU_Sorted_Labels.pdf')
        );
        skuSortedPath = result.path;
        totalPages += result.pages;
      }

      // Generate High_Quantity_Orders.pdf
      if (highQtyLabels.length > 0) {
        const result = await this._mergePDFBuffers(
          highQtyLabels.map(l => l.pdfBuffer),
          path.join(subfolder, 'High_Quantity_Orders.pdf')
        );
        highQuantityPath = result.path;
        totalPages += result.pages;
      }

      return {
        success: true,
        subfolder,
        skuSortedPath,
        highQuantityPath,
        totalPages,
        skuSortedCount: singleQtyLabels.length,
        highQtyCount: highQtyLabels.length
      };
    } catch (err) {
      console.error('Error generating sorted PDFs:', err);
      return { success: false, message: err.message };
    }
  }

  async _mergePDFBuffers(buffers, outputPath) {
    const mergedPdf = await PDFDocument.create();
    let pages = 0;

    for (const buffer of buffers) {
      try {
        const pdf = await PDFDocument.load(buffer);
        const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        copiedPages.forEach(page => {
          mergedPdf.addPage(page);
          pages++;
        });
      } catch (err) {
        console.warn('Skipping invalid PDF buffer:', err.message);
      }
    }

    const mergedBytes = await mergedPdf.save();
    fs.writeFileSync(outputPath, mergedBytes);
    console.log(`Merged PDF saved: ${outputPath} (${pages} pages)`);

    return { path: outputPath, pages };
  }

  // Legacy method for backward compatibility
  async mergeLabels(sortedLabelFiles, rootFolder) {
    try {
      const mergedPdf = await PDFDocument.create();
      let totalPages = 0;

      for (const label of sortedLabelFiles) {
        if (!fs.existsSync(label.path)) continue;

        const pdfBytes = fs.readFileSync(label.path);
        const pdf = await PDFDocument.load(pdfBytes);
        const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        copiedPages.forEach(page => {
          mergedPdf.addPage(page);
          totalPages++;
        });
      }

      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const timeStr = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
      const fileName = `${dateStr}_${timeStr}_Sorted_Labels.pdf`;
      const finalPath = path.join(rootFolder, fileName);

      const mergedPdfBytes = await mergedPdf.save();
      fs.writeFileSync(finalPath, mergedPdfBytes);

      return { success: true, finalPath, totalPages };
    } catch (err) {
      console.error('Error merging PDFs:', err);
      return { success: false, error: err.message };
    }
  }
}

module.exports = new PdfMergeService();
