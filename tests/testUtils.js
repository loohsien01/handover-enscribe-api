/**
 * Test utilities for Fastify API testing
 * Handles HTTP requests, result logging, and reporting
 */
import fs from 'fs';
import path from 'path';
import { getApiBaseUrl } from './testConfig.js';

function parseJsonSafe(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/**
 * Make HTTP request to Fastify server
 */
export async function makeRequest(method, url, options = {}) {
  const { headers = {}, body = null, expectedStatus = null, timeoutMs } = options;

  try {
    // Only set Content-Type if there's a body
    const requestHeaders = body 
      ? { 'Content-Type': 'application/json', ...headers }
      : headers;

    const signal =
      timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? AbortSignal.timeout(timeoutMs)
        : undefined;

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : null,
      signal,
    });

    const data = await response.json().catch(() => ({}));

    return {
      status: response.statusCode || response.status,
      headers: Object.fromEntries(response.headers || []),
      body: data,
      ok: response.ok,
      passed: expectedStatus ? response.status === expectedStatus : response.ok,
    };
  } catch (error) {
    return {
      status: null,
      headers: {},
      body: { error: error.message },
      ok: false,
      passed: false,
    };
  }
}

/**
 * Make multipart/form-data request to Fastify server
 */
export async function makeMultipartRequest(method, url, options = {}) {
  const { headers = {}, filePart = null, fields = {}, expectedStatus = null } = options;

  try {
    const formData = new FormData();

    if (filePart) {
      const blob = new Blob([filePart.buffer], { type: filePart.contentType || 'application/octet-stream' });
      formData.append(filePart.fieldName || 'file', blob, filePart.filename || 'upload.bin');
    }

    Object.entries(fields || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        formData.append(key, String(value));
      }
    });

    const response = await fetch(url, {
      method,
      headers,
      body: formData,
    });

    const rawText = await response.text();
    const data = parseJsonSafe(rawText);

    return {
      status: response.statusCode || response.status,
      headers: Object.fromEntries(response.headers || []),
      body: data,
      ok: response.ok,
      passed: expectedStatus ? response.status === expectedStatus : response.ok,
    };
  } catch (error) {
    return {
      status: null,
      headers: {},
      body: { error: error.message },
      ok: false,
      passed: false,
    };
  }
}

/**
 * Test case executor
 */
export class TestRunner {
  constructor(testName, baseUrl = null) {
    this.testName = testName;
    // Use provided baseUrl, or fall back to getApiBaseUrl() for configurable endpoint support
    this.baseUrl = baseUrl || getApiBaseUrl();
    this.results = [];
    this.startTime = new Date();
  }

  /**
   * Add a test case
   * @param {string} name - Test name
   * @param {object} config - Test configuration
   * @param {number} config.testNumber - (Optional) Explicit test number for tracking skipped tests
   */
  async test(name, config) {
    const {
      method,
      endpoint,
      body,
      headers,
      expectedStatus,
      expectedFields,
      customValidator,
      onSuccess,
      testNumber,
      /** Called synchronously before fetch (use for progress logs when a request may hang). */
      onBeforeRequest,
      /** Abort request after this many ms (e.g. Bedrock completions). */
      timeoutMs,
    } = config;

    const url = `${this.baseUrl}${endpoint}`;
    if (typeof onBeforeRequest === 'function') {
      try {
        onBeforeRequest({ name, method, url, body, headers });
      } catch (e) {
        console.error(`[TestRunner] onBeforeRequest error for "${name}":`, e?.message || e);
      }
    }
    const response = await makeRequest(method, url, { body, headers, expectedStatus, timeoutMs });

    // Check status and expected fields
    let passed = response.passed &&
      (!expectedFields ||
        expectedFields.every((field) => {
          const keys = field.split('.');
          let value = response.body;
          for (const key of keys) {
            value = value?.[key];
          }
          return value !== undefined && value !== null;
        }));

    // Apply custom validator if provided (always call it to get message even on failure)
    let customMessage = '';
    if (customValidator) {
      const validationResult = customValidator(response.body, response);
      if (passed) {
        // Only update passed status if test already passed
        passed = passed && validationResult.passed;
      }
      customMessage = validationResult.message || '';
    }

    const result = {
      name,
      passed,
      endpoint,
      method,
      status: response.status,
      expectedStatus,
      body: response.body,
      customMessage,
      testNumber: testNumber || null,
      timestamp: new Date().toISOString(),
    };

    this.results.push(result);

    // Call onSuccess callback if test passed and callback provided
    if (passed && onSuccess && typeof onSuccess === 'function') {
      try {
        onSuccess(response.body);
      } catch (error) {
        console.error(`Error in onSuccess callback for test "${name}":`, error.message);
      }
    }

    return result;
  }

  /**
   * Add a multipart test case
   * @param {string} name - Test name
   * @param {object} config - Multipart test configuration
   */
  async testMultipart(name, config) {
    const {
      method = 'POST',
      endpoint,
      headers,
      filePart,
      fields,
      expectedStatus,
      expectedFields,
      customValidator,
      onSuccess,
      testNumber,
    } = config;

    const url = `${this.baseUrl}${endpoint}`;
    const response = await makeMultipartRequest(method, url, {
      headers,
      filePart,
      fields,
      expectedStatus,
    });

    let passed = response.passed &&
      (!expectedFields ||
        expectedFields.every((field) => {
          const keys = field.split('.');
          let value = response.body;
          for (const key of keys) {
            value = value?.[key];
          }
          return value !== undefined && value !== null;
        }));

    let customMessage = '';
    if (customValidator) {
      const validationResult = customValidator(response.body, response);
      if (passed) {
        passed = passed && validationResult.passed;
      }
      customMessage = validationResult.message || '';
    }

    const result = {
      name,
      passed,
      endpoint,
      method,
      status: response.status,
      expectedStatus,
      body: response.body,
      customMessage,
      testNumber: testNumber || null,
      timestamp: new Date().toISOString(),
    };

    this.results.push(result);

    if (passed && onSuccess && typeof onSuccess === 'function') {
      try {
        onSuccess(response.body);
      } catch (error) {
        console.error(`Error in onSuccess callback for multipart test "${name}":`, error.message);
      }
    }

    return result;
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    const total = this.results.length;
    const passed = this.results.filter((r) => r.passed).length;
    const failed = total - passed;
    const duration = new Date() - this.startTime;

    return {
      total,
      passed,
      failed,
      passRate: total > 0 ? ((passed / total) * 100).toFixed(2) + '%' : '0%',
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Save results to file
   */
  saveResults(filename = null) {
    const dir = path.resolve(process.cwd(), 'test-results');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const outputFile = path.join(
      dir,
      filename || `${this.testName}-${timestamp}.json`
    );

    const summary = this.getSummary();
    const output = {
      testSuite: this.testName,
      summary,
      results: this.results,
    };

    const jsonReplacer = (_, value) =>
      typeof value === 'bigint' ? Number(value) : value;
    fs.writeFileSync(outputFile, JSON.stringify(output, jsonReplacer, 2));
    return outputFile;
  }

  /**
   * Print results to console
   * @param {number} totalTests - Total tests planned (including skipped ones), optional
   */
  printResults(totalTests = null) {
    const summary = this.getSummary();
    const testNumberMap = new Map();

    // Build map of executed test numbers
    this.results.forEach((result) => {
      if (result.testNumber) {
        testNumberMap.set(result.testNumber, result);
      }
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Test Suite: ${this.testName}`);
    console.log(`${'='.repeat(60)}\n`);

    let passCount = 0;
    let failCount = 0;
    let skipCount = 0;

    // If explicit test numbers provided, show all tests including skipped
    let resultsToShow = [];
    if (totalTests) {
      // Get the highest test number from explicit numbering
      const numberedResults = this.results.filter(r => r.testNumber);
      const maxTestNum = numberedResults.length > 0 ? Math.max(...numberedResults.map(r => r.testNumber)) : 0;
      const targetMax = Math.max(maxTestNum, totalTests);

      for (let i = 1; i <= targetMax; i++) {
        if (testNumberMap.has(i)) {
          resultsToShow.push({ testNumber: i, result: testNumberMap.get(i) });
        } else {
          resultsToShow.push({ testNumber: i, result: null }); // Skipped test
        }
      }
    } else {
      // Prefer explicit result.testNumber when set (matches saved JSON); else array order 1..n
      this.results.forEach((result, index) => {
        const displayNum =
          result.testNumber != null && result.testNumber !== ''
            ? result.testNumber
            : index + 1;
        resultsToShow.push({ testNumber: displayNum, result });
      });
    }

    resultsToShow.forEach(({ testNumber, result }) => {
      if (!result) {
        console.log(`⊘ Test ${testNumber}: SKIPPED (dependency not met)\n`);
        skipCount++;
      } else {
        const label = String(testNumber);

        if (result.skipped) {
          console.log(`⏭️  Test ${label} (skipped): ${result.name}`);
          if (result.customMessage) {
            console.log(`   ${result.customMessage}`);
          }
          skipCount++;
          console.log();
          return;
        }

        const status = result.passed ? '✅' : '❌';
        console.log(`${status} Test ${label}: ${result.name}`);

        if (result.customMessage) {
          console.log(`   ${result.customMessage}`);
        }

        const responseBody = result.body || result.fullResponse || {};
        const responseStr = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
        const truncated = responseStr.substring(0, 500);

        if (!result.passed) {
          console.log(`   Expected: ${result.expectedStatus} | Got: ${result.status}`);
          failCount++;
        } else {
          passCount++;
        }
        console.log(`   Response: ${truncated}${responseStr.length > 500 ? '...' : ''}`);
        console.log(); // Double space
      }
    });

    console.log(`${'-'.repeat(60)}`);
    console.log(`Total Executed: ${summary.total} | Passed: ${passCount} | Failed: ${failCount} | Skipped: ${skipCount}`);
    console.log(`Pass Rate: ${summary.passRate} | Duration: ${summary.duration}`);
    console.log(`${'='.repeat(60)}\n`);
  }
}
