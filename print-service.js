const fs = require('fs');
const path = require('path');

class PrintService {
  constructor() {
    this.settingsPath = null;
    this.settings = { defaultPrinter: null, paperSize: '4x6' };
  }

  _getSettingsPath() {
    if (!this.settingsPath) {
      const { app } = require('electron');
      this.settingsPath = path.join(app.getPath('userData'), 'print-settings.json');
    }
    return this.settingsPath;
  }

  _loadSettings() {
    try {
      const settingsFile = this._getSettingsPath();
      if (fs.existsSync(settingsFile)) {
        this.settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      }
    } catch (e) {}
  }

  _saveSettings() {
    try {
      fs.writeFileSync(this._getSettingsPath(), JSON.stringify(this.settings, null, 2));
    } catch (e) {}
  }

  async print(filePath, options = {}) {
    this._loadSettings();

    const printerName = options.printer || this.settings.defaultPrinter;

    try {
      const pdfToPrinter = require('pdf-to-printer');

      const printOptions = {};
      if (printerName) {
        printOptions.printer = printerName;
      }

      await pdfToPrinter.print(filePath, printOptions);
      console.log(`[PrintService] Printed: ${filePath}`);
      return { success: true };
    } catch (err) {
      // If pdf-to-printer is not installed, fall back to Electron's print
      if (err.code === 'MODULE_NOT_FOUND') {
        console.log('[PrintService] pdf-to-printer not installed. Using fallback print dialog.');
        return this._fallbackPrint(filePath);
      }
      console.error('[PrintService] Print failed:', err.message);
      throw err;
    }
  }

  async getAvailablePrinters() {
    try {
      const pdfToPrinter = require('pdf-to-printer');
      const printers = await pdfToPrinter.getPrinters();
      return printers;
    } catch (err) {
      console.error('[PrintService] Cannot get printers:', err.message);
      return [];
    }
  }

  async setDefaultPrinter(printerName) {
    this._loadSettings();
    this.settings.defaultPrinter = printerName;
    this._saveSettings();
  }

  async _fallbackPrint(filePath) {
    // Fallback: open the PDF with the system default handler
    const { shell } = require('electron');
    await shell.openPath(filePath);
    return { success: true, fallback: true };
  }
}

module.exports = new PrintService();
