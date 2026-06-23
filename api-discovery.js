const { session } = require('electron');
const fs = require('fs');
const path = require('path');

class ApiDiscovery {
  constructor() {
    this.isRecording = false;
    this.interceptorAttached = false;
    this.debuggerAttached = false;
    this.sellerView = null;

    this.authTokens = { csrfToken: null, bearerToken: null, cookie: null };

    // Capture stores
    this.capturedRequests = [];
    this.graphqlOperations = {};
    this.restEndpoints = {};
    this.capturedHeaders = {};
    this.responseSamples = {};
    this.statusValues = new Set();
    this.filterValues = new Set();
    this.sortValues = new Set();
    this.paginationPatterns = {};

    // Pending response captures keyed by requestId
    this._pendingRequests = {};
  }

  attachInterceptor() {
    if (this.interceptorAttached) return;
    this.interceptorAttached = true;

    const ses = session.fromPartition('persist:flipkart-session');
    const filter = { urls: ['*://seller.flipkart.com/*', '*://api.flipkart.net/*'] };

    ses.webRequest.onBeforeRequest(filter, (details, callback) => {
      if (details.method === 'POST' && details.uploadData && details.uploadData[0] && details.uploadData[0].bytes) {
        const bodyStr = details.uploadData[0].bytes.toString();
        const lowerUrl = details.url.toLowerCase();

        if (this.isRecording) {
          this._recordRequest(details.url, details.method, bodyStr, lowerUrl);
        }
      }

      if (this.isRecording && details.method === 'GET') {
        const lowerUrl = details.url.toLowerCase();
        if (!lowerUrl.match(/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico|map|json)(\?|$)/)) {
          this._recordGetRequest(details.url);
        }
      }

      callback({});
    });

    ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      const { requestHeaders, url } = details;
      const lowerUrl = url.toLowerCase();

      if (lowerUrl.match(/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico|map)(\?|$)/)) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }

      // Always extract auth
      const csrf = requestHeaders['X-CSRF-TOKEN'] || requestHeaders['x-csrf-token'] ||
                   requestHeaders['X-Csrf-Token'] || requestHeaders['fk-csrf-token'] ||
                   requestHeaders['Fk-Csrf-Token'] || requestHeaders['FK-CSRF-TOKEN'];
      if (csrf) {
        if (!this.authTokens.csrfToken) console.log('[Discovery] ✅ CSRF token captured');
        this.authTokens.csrfToken = csrf;
      }

      const auth = requestHeaders['Authorization'] || requestHeaders['authorization'];
      if (auth) {
        if (!this.authTokens.bearerToken) console.log('[Discovery] ✅ Bearer token captured');
        this.authTokens.bearerToken = auth;
      }

      if (requestHeaders['Cookie']) {
        if (!this.authTokens.cookie) console.log(`[Discovery] ✅ Cookies captured (${requestHeaders['Cookie'].length} chars)`);
        this.authTokens.cookie = requestHeaders['Cookie'];
      }

      if (this.isRecording) {
        const urlKey = new URL(url).pathname;
        this.capturedHeaders[urlKey] = { ...requestHeaders };
      }

      callback({ requestHeaders: details.requestHeaders });
    });

    console.log('[Discovery] Network interceptor attached.');
  }

  // --- CDP debugger for response body capture ---

  attachDebugger(webContents) {
    this.sellerView = webContents;
  }

  _startDebugger() {
    if (!this.sellerView || this.debuggerAttached) return;

    try {
      this.sellerView.debugger.attach('1.3');
      this.debuggerAttached = true;
      this.sellerView.debugger.sendCommand('Network.enable');

      this.sellerView.debugger.on('message', (event, method, params) => {
        if (!this.isRecording) return;

        if (method === 'Network.requestWillBeSent') {
          const url = params.request.url || '';
          if (url.includes('seller.flipkart.com') || url.includes('api.flipkart.net')) {
            this._pendingRequests[params.requestId] = {
              url,
              method: params.request.method,
              timestamp: new Date().toISOString()
            };
          }
        }

        if (method === 'Network.responseReceived') {
          const pending = this._pendingRequests[params.requestId];
          if (pending) {
            pending.statusCode = params.response.status;
            pending.mimeType = params.response.mimeType;

            // Capture response body for API calls
            if (pending.mimeType && pending.mimeType.includes('json')) {
              this.sellerView.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
                .then(result => {
                  this._processResponse(pending.url, result.body, pending);
                })
                .catch(() => {});
            }
          }
        }

        if (method === 'Network.loadingFinished') {
          delete this._pendingRequests[params.requestId];
        }
      });

      console.log('[Discovery] CDP debugger attached for response capture.');
    } catch (e) {
      console.error('[Discovery] Debugger attach failed:', e.message);
    }
  }

  _stopDebugger() {
    if (!this.sellerView || !this.debuggerAttached) return;
    try {
      this.sellerView.debugger.detach();
    } catch (e) {}
    this.debuggerAttached = false;
    this._pendingRequests = {};
    console.log('[Discovery] CDP debugger detached.');
  }

  _processResponse(url, bodyStr, meta) {
    try {
      const data = JSON.parse(bodyStr);
      const urlPath = new URL(url).pathname;

      // Store response sample keyed by URL path or GraphQL operation
      let key = urlPath;
      // Find the matching request to get the operationName
      const matchingReq = [...this.capturedRequests].reverse().find(r => r.url === url && r.operationName);
      if (matchingReq) {
        key = matchingReq.operationName;
        // Attach response to the captured request
        matchingReq.responseBody = bodyStr.length > 50000 ? bodyStr.substring(0, 50000) + '...[truncated]' : bodyStr;
        matchingReq.responseStatus = meta.statusCode;
      }

      // Store latest response sample per key
      this.responseSamples[key] = {
        url,
        statusCode: meta.statusCode,
        body: bodyStr.length > 50000 ? bodyStr.substring(0, 50000) + '...[truncated]' : bodyStr,
        structure: this._extractStructure(data),
        capturedAt: meta.timestamp
      };

      // Extract Flipkart-specific metadata from responses
      this._extractMetadata(data);

      console.log(`[Discovery] Response captured: ${key} (${meta.statusCode}, ${bodyStr.length} chars)`);
    } catch (e) {}
  }

  _extractMetadata(data) {
    // Deep-traverse to find status values, filter values, sort values, pagination
    const traverse = (obj, path) => {
      if (!obj || typeof obj !== 'object') return;

      for (const key of Object.keys(obj)) {
        const val = obj[key];
        const fullPath = path ? `${path}.${key}` : key;

        if (typeof val === 'string') {
          const lower = key.toLowerCase();
          if (lower.includes('status') || lower === 'state' || lower === 'shipmentstatus' || lower === 'orderstatus') {
            this.statusValues.add(val);
          }
          if (lower.includes('filter') || lower.includes('filterby') || lower === 'tab' || lower === 'tabname') {
            this.filterValues.add(val);
          }
          if (lower.includes('sort') || lower.includes('orderby') || lower.includes('sortby')) {
            this.sortValues.add(val);
          }
        }

        if (typeof val === 'number') {
          const lower = key.toLowerCase();
          if (lower.includes('page') || lower.includes('offset') || lower.includes('limit') || lower.includes('size') || lower.includes('total') || lower.includes('count') || lower === 'hasmore' || lower === 'hasnext') {
            this.paginationPatterns[fullPath] = val;
          }
        }

        if (typeof val === 'boolean') {
          const lower = key.toLowerCase();
          if (lower === 'hasmore' || lower === 'hasnext' || lower === 'hasnextpage' || lower === 'haspreviouspage') {
            this.paginationPatterns[fullPath] = val;
          }
        }

        if (Array.isArray(val)) {
          // Check if array of status strings
          const lower = key.toLowerCase();
          if (lower.includes('status') || lower.includes('states') || lower.includes('filter')) {
            val.forEach(v => { if (typeof v === 'string') this.statusValues.add(v); });
          }
          val.forEach((item, i) => {
            if (typeof item === 'object' && item !== null) traverse(item, `${fullPath}[${i}]`);
          });
        } else if (typeof val === 'object' && val !== null) {
          traverse(val, fullPath);
        }
      }
    };

    traverse(data, '');
  }

  _extractStructure(data, depth = 0) {
    if (depth > 4) return '...';
    if (data === null) return 'null';
    if (Array.isArray(data)) {
      if (data.length === 0) return '[]';
      return [this._extractStructure(data[0], depth + 1)];
    }
    if (typeof data === 'object') {
      const result = {};
      const keys = Object.keys(data);
      for (const key of keys.slice(0, 20)) {
        result[key] = this._extractStructure(data[key], depth + 1);
      }
      if (keys.length > 20) result['...'] = `${keys.length - 20} more keys`;
      return result;
    }
    return typeof data;
  }

  // --- Recording control ---

  _recordRequest(url, method, bodyStr, lowerUrl) {
    const entry = {
      id: Date.now() + '_' + Math.random().toString(36).substring(2, 8),
      url,
      method,
      timestamp: new Date().toISOString(),
      requestPayload: bodyStr,
      type: 'unknown',
      responseBody: null,
      responseStatus: null
    };

    if (lowerUrl.includes('graphql')) {
      entry.type = 'graphql';
      try {
        const parsed = JSON.parse(bodyStr);
        const ops = Array.isArray(parsed) ? parsed : [parsed];
        for (const op of ops) {
          const opName = op.operationName || 'unnamed_' + Date.now();
          entry.operationName = opName;
          entry.variables = op.variables || {};
          entry.query = op.query || null;

          this.graphqlOperations[opName] = {
            url,
            operationName: opName,
            query: op.query || null,
            variables: op.variables || {},
            payload: JSON.stringify(op),
            capturedAt: entry.timestamp
          };

          // Extract status/filter/sort/pagination from variables
          if (op.variables) this._extractMetadata(op.variables);

          console.log(`[Discovery] GraphQL: "${opName}" | vars: ${JSON.stringify(op.variables || {}).substring(0, 200)}`);
        }
      } catch (e) {
        entry.operationName = 'unparseable';
      }
    } else {
      entry.type = 'rest';
      const urlKey = new URL(url).pathname;
      this.restEndpoints[urlKey] = {
        url,
        method,
        payload: bodyStr,
        capturedAt: entry.timestamp
      };
      // Extract metadata from REST payloads too
      try { this._extractMetadata(JSON.parse(bodyStr)); } catch (e) {}
      console.log(`[Discovery] REST: ${method} ${urlKey}`);
    }

    this.capturedRequests.push(entry);
  }

  _recordGetRequest(url) {
    const urlKey = new URL(url).pathname;
    if (!this.restEndpoints[urlKey]) {
      this.restEndpoints[urlKey] = {
        url,
        method: 'GET',
        payload: null,
        capturedAt: new Date().toISOString()
      };
    }
    this.capturedRequests.push({
      id: Date.now() + '_' + Math.random().toString(36).substring(2, 8),
      url,
      method: 'GET',
      timestamp: new Date().toISOString(),
      type: 'rest'
    });
  }

  startRecording() {
    this.isRecording = true;
    this.capturedRequests = [];
    this.graphqlOperations = {};
    this.restEndpoints = {};
    this.capturedHeaders = {};
    this.responseSamples = {};
    this.statusValues = new Set();
    this.filterValues = new Set();
    this.sortValues = new Set();
    this.paginationPatterns = {};
    this._pendingRequests = {};
    this._startDebugger();
    console.log('[Discovery] === RECORDING STARTED ===');
  }

  stopRecording() {
    this.isRecording = false;
    this._stopDebugger();
    console.log(`[Discovery] === RECORDING STOPPED === ${this.capturedRequests.length} requests, ${Object.keys(this.graphqlOperations).length} GraphQL ops, ${Object.keys(this.restEndpoints).length} REST endpoints, ${Object.keys(this.responseSamples).length} responses`);
  }

  getRecordingStats() {
    return {
      isRecording: this.isRecording,
      totalRequests: this.capturedRequests.length,
      graphqlOps: Object.keys(this.graphqlOperations).length,
      restEndpoints: Object.keys(this.restEndpoints).length,
      responseSamples: Object.keys(this.responseSamples).length,
      statusValues: this.statusValues.size,
      hasAuth: !!(this.authTokens.csrfToken || this.authTokens.cookie),
      operationNames: Object.keys(this.graphqlOperations)
    };
  }

  // --- Save discovery output ---

  saveDiscovery(outputDir) {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const write = (name, data) => fs.writeFileSync(path.join(outputDir, name), JSON.stringify(data, null, 2), 'utf8');
    const writeMd = (name, text) => fs.writeFileSync(path.join(outputDir, name), text, 'utf8');

    // 1. API Registry
    const registry = this._buildRegistry();
    write('api-registry.json', registry);

    // 2. GraphQL operations
    write('graphql-operations.json', this.graphqlOperations);

    // 3. REST endpoints
    write('rest-endpoints.json', this.restEndpoints);

    // 4. Request samples (full payloads, chronological)
    write('request-samples.json', this.capturedRequests);

    // 5. Response samples
    write('response-samples.json', this.responseSamples);

    // 6. Auth tokens
    write('auth-tokens.json', {
      csrfToken: this.authTokens.csrfToken || null,
      bearerToken: this.authTokens.bearerToken ? '[PRESENT]' : null,
      cookieNames: this.authTokens.cookie ? this.authTokens.cookie.split(';').map(c => c.trim().split('=')[0]) : [],
      headers: this.capturedHeaders
    });

    // 7. Status mapping
    write('status-mapping.json', {
      statusValues: [...this.statusValues].sort(),
      filterValues: [...this.filterValues].sort(),
      sortValues: [...this.sortValues].sort(),
      paginationPatterns: this.paginationPatterns
    });

    // 8. Category-specific API files
    write('sku-related-apis.json', this._filterByKeywords(['sku', 'listing', 'product', 'catalog', 'inventory', 'fsn']));
    write('label-related-apis.json', this._filterByKeywords(['label', 'print', 'shipping', 'manifest', 'invoice', 'pdf']));
    write('rtd-related-apis.json', this._filterByKeywords(['rtd', 'dispatch', 'ready', 'handover', 'pickup']));

    // 9. Discovery Report
    writeMd('Discovery_Report.md', this._buildReport(registry));

    // 10. Workflow Map
    writeMd('WORKFLOW_MAP.md', this._buildWorkflowMap());

    const result = {
      outputDir,
      registryEntries: Object.keys(registry).length,
      totalRequests: this.capturedRequests.length,
      graphqlOps: Object.keys(this.graphqlOperations).length,
      restEndpoints: Object.keys(this.restEndpoints).length,
      responseSamples: Object.keys(this.responseSamples).length,
      statusValues: this.statusValues.size,
      filterValues: this.filterValues.size
    };

    console.log(`[Discovery] Saved to ${outputDir}:`, result);
    return result;
  }

  _filterByKeywords(keywords) {
    const result = { graphql: {}, rest: {} };

    for (const [name, op] of Object.entries(this.graphqlOperations)) {
      const searchStr = (name + ' ' + (op.query || '') + ' ' + JSON.stringify(op.variables || {})).toLowerCase();
      if (keywords.some(k => searchStr.includes(k))) {
        result.graphql[name] = op;
        if (this.responseSamples[name]) result.graphql[name].responseSample = this.responseSamples[name];
      }
    }

    for (const [urlPath, ep] of Object.entries(this.restEndpoints)) {
      const searchStr = (urlPath + ' ' + (ep.payload || '')).toLowerCase();
      if (keywords.some(k => searchStr.includes(k))) {
        result.rest[urlPath] = ep;
        if (this.responseSamples[urlPath]) result.rest[urlPath].responseSample = this.responseSamples[urlPath];
      }
    }

    return result;
  }

  _buildRegistry() {
    const registry = {};

    for (const [opName, data] of Object.entries(this.graphqlOperations)) {
      const headerKey = new URL(data.url).pathname;
      registry[opName] = {
        type: 'graphql',
        name: opName,
        purpose: this._guessPurpose(opName),
        url: data.url,
        method: 'POST',
        operationName: opName,
        query: data.query,
        variables: data.variables,
        payloadTemplate: data.payload,
        headers: this.capturedHeaders[headerKey] || {},
        responseSample: this.responseSamples[opName] ? this.responseSamples[opName].structure : null,
        capturedAt: data.capturedAt
      };
    }

    for (const [urlPath, data] of Object.entries(this.restEndpoints)) {
      const key = 'REST_' + urlPath.replace(/\//g, '_').replace(/^_/, '');
      if (!registry[key]) {
        registry[key] = {
          type: 'rest',
          name: key,
          purpose: this._guessPurpose(urlPath),
          url: data.url,
          method: data.method,
          payloadTemplate: data.payload,
          headers: this.capturedHeaders[urlPath] || {},
          responseSample: this.responseSamples[urlPath] ? this.responseSamples[urlPath].structure : null,
          capturedAt: data.capturedAt
        };
      }
    }

    return registry;
  }

  _guessPurpose(name) {
    const l = name.toLowerCase();
    if (l.includes('statecount') || l.includes('dashboard') || l.includes('count')) return 'Dashboard Stats';
    if (l.includes('accept')) return 'Accept Order';
    if (l.includes('label') || l.includes('print')) return 'Label Download/Print';
    if (l.includes('rtd') || l.includes('dispatch') || l.includes('handover')) return 'Ready To Dispatch';
    if (l.includes('shipment') || l.includes('order')) return 'Order/Shipment Data';
    if (l.includes('return')) return 'Returns';
    if (l.includes('cancel')) return 'Cancellations';
    if (l.includes('invoice')) return 'Invoice';
    if (l.includes('manifest')) return 'Manifest';
    if (l.includes('listing') || l.includes('catalog') || l.includes('product')) return 'Product/Listing';
    if (l.includes('inventory')) return 'Inventory';
    if (l.includes('payment') || l.includes('settlement')) return 'Payments';
    if (l.includes('search')) return 'Search';
    if (l.includes('notification')) return 'Notifications';
    if (l.includes('performance') || l.includes('metric')) return 'Performance Metrics';
    if (l.includes('config') || l.includes('setting')) return 'Configuration';
    return 'Other';
  }

  _buildReport(registry) {
    let md = '# Flipkart Seller API Discovery Report\n\n';
    md += `**Generated**: ${new Date().toISOString()}\n\n`;

    md += '## Summary\n\n';
    md += `| Metric | Count |\n|--------|-------|\n`;
    md += `| Total Requests Captured | ${this.capturedRequests.length} |\n`;
    md += `| GraphQL Operations | ${Object.keys(this.graphqlOperations).length} |\n`;
    md += `| REST Endpoints | ${Object.keys(this.restEndpoints).length} |\n`;
    md += `| Response Samples | ${Object.keys(this.responseSamples).length} |\n`;
    md += `| Unique Status Values | ${this.statusValues.size} |\n`;
    md += `| Unique Filter Values | ${this.filterValues.size} |\n`;
    md += `| Pagination Patterns | ${Object.keys(this.paginationPatterns).length} |\n`;
    md += `| CSRF Token | ${this.authTokens.csrfToken ? 'Captured' : 'Missing'} |\n`;
    md += `| Bearer Token | ${this.authTokens.bearerToken ? 'Captured' : 'Missing'} |\n`;
    md += `| Cookies | ${this.authTokens.cookie ? 'Captured' : 'Missing'} |\n\n`;

    md += '## Status Values Found\n\n';
    md += '```\n' + [...this.statusValues].sort().join('\n') + '\n```\n\n';

    md += '## Filter Values Found\n\n';
    md += '```\n' + [...this.filterValues].sort().join('\n') + '\n```\n\n';

    md += '## Pagination Patterns\n\n';
    md += '```json\n' + JSON.stringify(this.paginationPatterns, null, 2) + '\n```\n\n';

    // Group by purpose
    const grouped = {};
    for (const [name, entry] of Object.entries(registry)) {
      const purpose = entry.purpose || 'Other';
      if (!grouped[purpose]) grouped[purpose] = [];
      grouped[purpose].push({ name, ...entry });
    }

    md += '## APIs by Category\n\n';
    for (const [purpose, apis] of Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]))) {
      md += `### ${purpose}\n\n`;
      for (const api of apis) {
        md += `#### ${api.name}\n\n`;
        md += `- **URL**: \`${api.url}\`\n`;
        md += `- **Method**: ${api.method}\n`;
        md += `- **Type**: ${api.type}\n`;
        if (api.operationName) md += `- **GraphQL Operation**: \`${api.operationName}\`\n`;
        md += `- **Required Tokens**: CSRF, Cookie${api.headers?.['Authorization'] ? ', Bearer' : ''}\n`;

        if (api.variables && Object.keys(api.variables).length > 0) {
          md += `- **Variables**:\n\`\`\`json\n${JSON.stringify(api.variables, null, 2).substring(0, 500)}\n\`\`\`\n`;
        }
        if (api.payloadTemplate) {
          md += `- **Request Body** (template):\n\`\`\`json\n${api.payloadTemplate.substring(0, 800)}\n\`\`\`\n`;
        }
        if (api.query) {
          md += `- **GraphQL Query**:\n\`\`\`graphql\n${api.query.substring(0, 600)}\n\`\`\`\n`;
        }
        if (api.responseSample) {
          md += `- **Response Structure**:\n\`\`\`json\n${JSON.stringify(api.responseSample, null, 2).substring(0, 600)}\n\`\`\`\n`;
        }
        md += '\n';
      }
    }

    md += '## Chronological Request Log\n\n';
    md += '| # | Time | Method | Type | Operation / Path | Response |\n';
    md += '|---|------|--------|------|------------------|----------|\n';
    this.capturedRequests.forEach((req, i) => {
      const label = req.operationName || (() => { try { return new URL(req.url).pathname; } catch (e) { return req.url; } })();
      md += `| ${i + 1} | ${req.timestamp.split('T')[1]?.split('.')[0] || ''} | ${req.method} | ${req.type} | ${label} | ${req.responseStatus || '-'} |\n`;
    });

    return md;
  }

  _buildWorkflowMap() {
    let md = '# Flipkart Seller Workflow Map\n\n';
    md += `**Generated**: ${new Date().toISOString()}\n\n`;
    md += 'This document maps the seller workflow to discovered APIs.\n\n';

    const workflows = [
      { name: 'Dashboard', keywords: ['dashboard', 'statecount', 'count', 'metric', 'home'] },
      { name: 'Accept Order', keywords: ['accept', 'approve', 'confirm'] },
      { name: 'To Pack', keywords: ['topack', 'packing', 'pack', 'form_generated'] },
      { name: 'Label Download', keywords: ['label', 'print', 'shipping-label'] },
      { name: 'Invoice', keywords: ['invoice'] },
      { name: 'Manifest', keywords: ['manifest'] },
      { name: 'Ready To Dispatch', keywords: ['rtd', 'dispatch', 'handover', 'pickup', 'ready'] },
      { name: 'In Transit', keywords: ['transit', 'shipped', 'tracking'] },
      { name: 'Completed / Delivered', keywords: ['completed', 'delivered'] },
      { name: 'Returns', keywords: ['return', 'rto', 'reverse'] },
      { name: 'Cancelled', keywords: ['cancel'] },
      { name: 'Search / Filter', keywords: ['search', 'filter', 'query'] },
      { name: 'Pagination', keywords: ['page', 'offset', 'cursor', 'next'] },
      { name: 'Listings / Products', keywords: ['listing', 'product', 'catalog', 'sku', 'fsn'] },
      { name: 'Inventory', keywords: ['inventory', 'stock'] },
      { name: 'Payments', keywords: ['payment', 'settlement', 'payout'] },
    ];

    md += '## Workflow Sequence\n\n';
    md += '```\n';
    md += 'Dashboard (stats)\n';
    md += '    |\n';
    md += '    v\n';
    md += 'Accept Order\n';
    md += '    |\n';
    md += '    v\n';
    md += 'To Pack\n';
    md += '    |\n';
    md += '    v\n';
    md += 'Download Label + Invoice\n';
    md += '    |\n';
    md += '    v\n';
    md += 'Ready To Dispatch (RTD)\n';
    md += '    |\n';
    md += '    v\n';
    md += 'In Transit\n';
    md += '    |\n';
    md += '    v\n';
    md += 'Completed / Delivered\n';
    md += '```\n\n';

    md += '## API Mapping\n\n';
    for (const wf of workflows) {
      md += `### ${wf.name}\n\n`;
      let found = false;

      for (const [opName, op] of Object.entries(this.graphqlOperations)) {
        const searchStr = (opName + ' ' + (op.query || '') + ' ' + JSON.stringify(op.variables || {})).toLowerCase();
        if (wf.keywords.some(k => searchStr.includes(k))) {
          md += `- **GraphQL**: \`${opName}\` → \`${op.url}\`\n`;
          if (op.variables && Object.keys(op.variables).length > 0) {
            md += `  - Variables: \`${JSON.stringify(op.variables).substring(0, 200)}\`\n`;
          }
          found = true;
        }
      }

      for (const [urlPath, ep] of Object.entries(this.restEndpoints)) {
        if (wf.keywords.some(k => urlPath.toLowerCase().includes(k))) {
          md += `- **REST**: \`${ep.method} ${urlPath}\` → \`${ep.url}\`\n`;
          found = true;
        }
      }

      if (!found) md += `- *No APIs discovered for this step. Visit this page during discovery.*\n`;
      md += '\n';
    }

    return md;
  }

  // --- Load saved registry ---

  loadRegistry(registryPath) {
    try {
      if (fs.existsSync(registryPath)) {
        const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        console.log(`[Discovery] Loaded registry: ${Object.keys(data).length} entries`);
        return data;
      }
    } catch (e) {
      console.error(`[Discovery] Failed to load registry: ${e.message}`);
    }
    return null;
  }

  // --- Auth ---

  getAuthTokens() { return this.authTokens; }

  resetTokens() {
    this.authTokens = { csrfToken: null, bearerToken: null, cookie: null };
  }
}

module.exports = new ApiDiscovery();
