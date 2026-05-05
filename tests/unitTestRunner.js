/**
 * Lightweight Unit Test Runner
 * 
 * Simple test harness for pure unit tests (no I/O, no external dependencies)
 * Handles test execution, result aggregation, and formatted reporting
 * Optionally saves results to JSON file in test-results/ directory
 * 
 * Usage:
 *   import { UnitTestRunner } from './unitTestRunner.js';
 *   
 *   const runner = new UnitTestRunner('My Test Suite', { saveResults: true });
 *   runner.test('test name', () => {
 *     assert.strictEqual(actual, expected);
 *   });
 *   runner.exit();
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class UnitTestRunner {
  constructor(suiteName, options = {}) {
    this.suiteName = suiteName;
    this.tests = [];
    this.startTime = Date.now();
    this.saveResults = options.saveResults ?? true;
    this.resultsDir = options.resultsDir || path.resolve(__dirname, '../test-results');
    this.maxStringLength = options.maxStringLength ?? 100;
  }

  /**
   * Add and execute a test
   * @param {string} name - Test name
   * @param {Function} testFn - Synchronous test function that throws on failure
   * @param {Object} options - Optional configuration
   * @param {string} options.category - Category/group for organizing output
   * @param {Object} options.output - Optional output data to include in results (e.g., actual vs expected)
   */
  test(name, testFn, options = {}) {
    const { category = null, output = null } = options;
    let error = null;
    let passed = false;
    let computedOutput = null;

    try {
      const result = testFn();
      if (result !== undefined) computedOutput = result;
      passed = true;
    } catch (err) {
      error = err.message || String(err);
    }

    this.tests.push({
      name,
      category,
      passed,
      error,
      output: output
        ? this.truncateOutput(output)
        : computedOutput !== null
          ? this.truncateOutput(computedOutput)
          : null,
      timestamp: Date.now(),
    });
  }

  /**
   * Truncate long text fields in output (>maxStringLength chars)
   */
  truncateOutput(obj) {
    if (typeof obj === 'string') {
      return obj.length > this.maxStringLength
        ? obj.substring(0, this.maxStringLength) + '...'
        : obj;
    }
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      return obj.map((item) => this.truncateOutput(item));
    }

    // Recursively truncate object properties
    const truncated = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        truncated[key] =
          value.length > this.maxStringLength
            ? value.substring(0, this.maxStringLength) + '...'
            : value;
      } else if (typeof value === 'object' && value !== null) {
        truncated[key] = this.truncateOutput(value);
      } else {
        truncated[key] = value;
      }
    }
    return truncated;
  }

  /**
   * Generate and display test report
   * @returns {boolean} true if all tests passed, false otherwise
   */
  report() {
    const duration = Date.now() - this.startTime;
    const passed = this.tests.filter((t) => t.passed).length;
    const total = this.tests.length;
    const allPassed = passed === total;

    // Group tests by category
    const categories = {};
    this.tests.forEach((test) => {
      const cat = test.category || 'Uncategorized';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(test);
    });

    // Print header
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${this.suiteName}`);
    console.log(`${'='.repeat(70)}\n`);

    // Print by category
    Object.entries(categories).forEach(([category, tests], idx) => {
      if (idx > 0) console.log();
      console.log(`📋 ${category}\n`);

      tests.forEach((test) => {
        const status = test.passed ? '✓' : '✗';
        const color = test.passed ? '\x1b[32m' : '\x1b[31m'; // Green or Red
        const reset = '\x1b[0m';
        console.log(`   ${color}${status}${reset} ${test.name}`);

        if (!test.passed) {
          console.log(`      ${color}Error: ${test.error}${reset}`);
        }

        // Print output if available
        if (test.output) {
          const outputStr = JSON.stringify(test.output, null, 2);
          const indentedOutput = outputStr
            .split('\n')
            .map((line) => '      ' + line)
            .join('\n');
          console.log(`${indentedOutput}`);
        }
      });
    });

    // Print summary
    console.log(`\n${'='.repeat(70)}`);
    const statusEmoji = allPassed ? '✅' : '❌';
    const statusText = allPassed ? 'All tests passed' : 'Some tests failed';
    console.log(
      `${statusEmoji} ${statusText} — ${passed}/${total} passed (${duration}ms)`
    );
    console.log(`${'='.repeat(70)}\n`);

    // Save results to JSON if enabled
    if (this.saveResults) {
      this.saveResultsToFile(duration, passed, total);
    }

    return allPassed;
  }

  /**
   * Save test results to JSON file
   */
  saveResultsToFile(duration, passed, total) {
    try {
      // Ensure test-results directory exists
      if (!fs.existsSync(this.resultsDir)) {
        fs.mkdirSync(this.resultsDir, { recursive: true });
      }

      // Generate filename from suite name (e.g., "SOAP Note Validator Unit Tests" -> "soapNoteValidator-unit-tests.json")
      const fileName = this.suiteName
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]/g, '') + '.json';
      const filePath = path.join(this.resultsDir, fileName);

      // Group results by category
      const resultsByCategory = {};
      this.tests.forEach((test) => {
        const cat = test.category || 'Uncategorized';
        if (!resultsByCategory[cat]) resultsByCategory[cat] = [];
        resultsByCategory[cat].push({
          name: test.name,
          passed: test.passed,
          error: test.error,
          output: test.output,
        });
      });

      const report = {
        suiteName: this.suiteName,
        timestamp: new Date().toISOString(),
        duration: `${duration}ms`,
        summary: {
          total,
          passed,
          failed: total - passed,
          passRate: ((passed / total) * 100).toFixed(1) + '%',
        },
        testsByCategory: resultsByCategory,
        allTests: this.tests.map((t) => ({
          name: t.name,
          category: t.category || 'Uncategorized',
          passed: t.passed,
          error: t.error,
          output: t.output,
        })),
      };

      fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
      console.log(`📁 Results saved: ${filePath}\n`);
    } catch (error) {
      console.error(`⚠️  Failed to save results: ${error.message}\n`);
    }
  }

  /**
   * Run report and exit with appropriate code
   */
  exit() {
    const allPassed = this.report();
    process.exit(allPassed ? 0 : 1);
  }
}
