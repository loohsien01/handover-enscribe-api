/**
 * Master Test Runner
 * Executes all test suites and generates consolidated report
 */
import fs from 'fs';
import path from 'path';
import { getApiBaseUrl } from './testConfig.js';
import { runAuthTests } from './auth.test.js';
import { runDotPhrasesTests } from './dot-phrases.test.js';
import { runNovaChatSessionsTests } from './nova-chat-sessions.test.js';
import { runUserProfileTests } from './user-profile.test.js';
import { runBillingOrgTests } from './billing-org.test.js';
import { runPatientEncounterTests } from './patient-encounters.test.js';
import { runRecordingsTests } from './recordings.test.js';
import { runTranscriptsTests } from './transcripts.test.js';
import { runSoapNotesTests } from './soap-notes.test.js';
import { runNotesTests } from './notes.test.js';
import { runNoteTemplateSectionsTests } from './note-template-sections.test.js';
import { runNoteTemplateTests } from './note-templates.test.js';
import { runAwsTests } from './aws.test.js';
import { runPromptLlmTests } from './prompt-llm.test.js';
// Last suite when enabled (runs after Recordings). Uncomment import + block below to include in `npm test`.
// import { runCleanupTests } from './cleanup.test.js';

/**
 * Run all test suites
 */
async function runAllTests() {
  console.log('\n' + '='.repeat(70));
  console.log('FASTIFY API TEST SUITE - COMPREHENSIVE');
  console.log('='.repeat(70) + '\n');

  const startTime = new Date();
  const results = [];

  // Check if server is running
  try {
    const response = await fetch(`${getApiBaseUrl()}/health`);
    if (!response.ok) throw new Error('Server not responding');
    console.log('✅ Server health check passed\n');
  } catch (error) {
    console.error(`❌ Server is not running at ${getApiBaseUrl()}`);
    console.error('   Start the server with: npm run dev:fastify');
    console.error('   Or test production: API_BASE_URL=https://api.enscribe.sjpedgi.doctor npm test\n');
    process.exit(1);
  }

  // Run Auth Tests
  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 1: AUTHENTICATION API');
    console.log('-'.repeat(70) + '\n');
    const authResult = await runAuthTests();
    results.push({ 
      suite: 'Authentication', 
      status: 'completed',
      tests: authResult?.total || 0,
      passed: authResult?.passed || 0,
      failed: authResult?.failed || 0,
      passRate: authResult?.passRate || '0%'
    });
  } catch (error) {
    console.error('❌ Auth tests failed:', error.message);
    results.push({ suite: 'Authentication', status: 'failed', error: error.message });
  }

  // Run Dot Phrases Tests
  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 2: DOT PHRASES API');
    console.log('-'.repeat(70) + '\n');
    const dotPhrasesResult = await runDotPhrasesTests();
    results.push({ 
      suite: 'Dot Phrases', 
      status: 'completed',
      tests: dotPhrasesResult?.total || 0,
      passed: dotPhrasesResult?.passed || 0,
      failed: dotPhrasesResult?.failed || 0,
      passRate: dotPhrasesResult?.passRate || '0%'
    });
  } catch (error) {
    console.error('❌ Dot Phrases tests failed:', error.message);
    results.push({ suite: 'Dot Phrases', status: 'failed', error: error.message });
  }

  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 2.1: NOVA CHAT SESSIONS (REDIS)');
    console.log('-'.repeat(70) + '\n');
    const novaResult = await runNovaChatSessionsTests();
    results.push({
      suite: 'Nova Chat Sessions',
      status: 'completed',
      tests: novaResult?.total || 0,
      passed: novaResult?.passed || 0,
      failed: novaResult?.failed || 0,
      passRate: novaResult?.passRate || '0%',
    });
  } catch (error) {
    console.error('❌ Nova Chat Sessions tests failed:', error.message);
    results.push({ suite: 'Nova Chat Sessions', status: 'failed', error: error.message });
  }

  // Run User Profile Tests
  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 2.5: USER PROFILE API');
    console.log('-'.repeat(70) + '\n');
    const upResult = await runUserProfileTests();
    results.push({
      suite: 'User Profile',
      status: 'completed',
      tests: upResult?.total || 0,
      passed: upResult?.passed || 0,
      failed: upResult?.failed || 0,
      passRate: upResult?.passRate || '0%',
    });
  } catch (error) {
    console.error('❌ User Profile tests failed:', error.message);
    results.push({ suite: 'User Profile', status: 'failed', error: error.message });
  }

  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 2.6: BILLING + ORGANIZATION API');
    console.log('-'.repeat(70) + '\n');
    const billingResult = await runBillingOrgTests();
    results.push({
      suite: 'Billing + Organization',
      status: 'completed',
      tests: billingResult?.total || 0,
      passed: billingResult?.passed || 0,
      failed: billingResult?.failed || 0,
      passRate: billingResult?.passRate || '0%',
    });
  } catch (error) {
    console.error('❌ Billing + Organization tests failed:', error.message);
    results.push({ suite: 'Billing + Organization', status: 'failed', error: error.message });
  }

  // Run Patient Encounters Tests
  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 3: PATIENT ENCOUNTERS API');
    console.log('-'.repeat(70) + '\n');
    const peResult = await runPatientEncounterTests();
    results.push({ 
      suite: 'Patient Encounters', 
      status: 'completed',
      tests: peResult?.total || 0,
      passed: peResult?.passed || 0,
      failed: peResult?.failed || 0,
      passRate: peResult?.passRate || '0%'
    });
  } catch (error) {
    console.error('❌ Patient Encounters tests failed:', error.message);
    results.push({ suite: 'Patient Encounters', status: 'failed', error: error.message });
  }

  // Run Transcripts Tests
  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 4: TRANSCRIPTS API');
    console.log('-'.repeat(70) + '\n');
    const transResult = await runTranscriptsTests();
    results.push({ 
      suite: 'Transcripts', 
      status: 'completed',
      tests: transResult?.total || 0,
      passed: transResult?.passed || 0,
      failed: transResult?.failed || 0,
      passRate: transResult?.passRate || '0%'
    });
  } catch (error) {
    console.error('❌ Transcripts tests failed:', error.message);
    results.push({ suite: 'Transcripts', status: 'failed', error: error.message });
  }

  // Run SOAP Notes Tests
  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 5: SOAP NOTES API');
    console.log('-'.repeat(70) + '\n');
    const soapResult = await runSoapNotesTests();
    results.push({ 
      suite: 'SOAP Notes', 
      status: 'completed',
      tests: soapResult?.total || 0,
      passed: soapResult?.passed || 0,
      failed: soapResult?.failed || 0,
      passRate: soapResult?.passRate || '0%'
    });
  } catch (error) {
    console.error('❌ SOAP Notes tests failed:', error.message);
    results.push({ suite: 'SOAP Notes', status: 'failed', error: error.message });
  }

  // Run Notes Tests
  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 5.5: NOTES API');
    console.log('-'.repeat(70) + '\n');
    const notesResult = await runNotesTests();
    results.push({ 
      suite: 'Notes', 
      status: 'completed',
      tests: notesResult?.total || 0,
      passed: notesResult?.passed || 0,
      failed: notesResult?.failed || 0,
      passRate: notesResult?.passRate || '0%'
    });
  } catch (error) {
    console.error('❌ Notes tests failed:', error.message);
    results.push({ suite: 'Notes', status: 'failed', error: error.message });
  }

  // Run Note Template Sections Tests
  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 6: NOTE TEMPLATE SECTIONS API');
    console.log('-'.repeat(70) + '\n');
    const ntsResult = await runNoteTemplateSectionsTests();
    results.push({ 
      suite: 'Note Template Sections', 
      status: 'completed',
      tests: ntsResult?.total || 0,
      passed: ntsResult?.passed || 0,
      failed: ntsResult?.failed || 0,
      passRate: ntsResult?.passRate || '0%'
    });
  } catch (error) {
    console.error('❌ Note Template Sections tests failed:', error.message);
    results.push({ suite: 'Note Template Sections', status: 'failed', error: error.message });
  }

  // Run Note Templates Tests
  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 7: NOTE TEMPLATES API');
    console.log('-'.repeat(70) + '\n');
    const ntResult = await runNoteTemplateTests();
    results.push({ 
      suite: 'Note Templates', 
      status: 'completed',
      tests: ntResult?.total || 0,
      passed: ntResult?.passed || 0,
      failed: ntResult?.failed || 0,
      passRate: ntResult?.passRate || '0%'
    });
  } catch (error) {
    console.error('❌ Note Templates tests failed:', error.message);
    results.push({ suite: 'Note Templates', status: 'failed', error: error.message });
  }

  // Run AWS Tests
  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 8: AWS PHI MASKING API');
    console.log('-'.repeat(70) + '\n');
    const awsResult = await runAwsTests();
    results.push({ 
      suite: 'AWS PHI Masking', 
      status: 'completed',
      tests: awsResult?.total || 0,
      passed: awsResult?.passed || 0,
      failed: awsResult?.failed || 0,
      passRate: awsResult?.passRate || '0%'
    });
  } catch (error) {
    console.error('❌ AWS tests failed:', error.message);
    results.push({ suite: 'AWS PHI Masking', status: 'failed', error: error.message });
  }

  // Run OpenAI Prompt-LLM Tests
  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 9: OPENAI PROMPT-LLM (SOAP NOTE GENERATION)');
    console.log('-'.repeat(70) + '\n');
    const promptLlmResult = await runPromptLlmTests();
    results.push({ 
      suite: 'OpenAI Prompt-LLM', 
      status: 'completed',
      tests: promptLlmResult?.total || 0,
      passed: promptLlmResult?.passed || 0,
      failed: promptLlmResult?.failed || 0,
      passRate: promptLlmResult?.passRate || '0%'
    });
  } catch (error) {
    console.error('❌ OpenAI Prompt-LLM tests failed:', error.message);
    results.push({ suite: 'OpenAI Prompt-LLM', status: 'failed', error: error.message });
  }

  // Run Recordings Tests
  try {
    console.log('\n' + '-'.repeat(70));
    console.log('TEST SUITE 10: RECORDINGS API');
    console.log('-'.repeat(70) + '\n');
    const recResult = await runRecordingsTests();
    results.push({ 
      suite: 'Recordings', 
      status: 'completed',
      tests: recResult?.total || 0,
      passed: recResult?.passed || 0,
      failed: recResult?.failed || 0,
      passRate: recResult?.passRate || '0%'
    });
  } catch (error) {
    console.error('❌ Recordings tests failed:', error.message);
    results.push({ suite: 'Recordings', status: 'failed', error: error.message });
  }

  // Internal cleanup — keep last. Excluded from full run for now; use `npm run test:cleanup`.
  // try {
  //   console.log('\n' + '-'.repeat(70));
  //   console.log('TEST SUITE 11: INTERNAL CLEANUP API');
  //   console.log('-'.repeat(70) + '\n');
  //   const icResult = await runCleanupTests();
  //   results.push({
  //     suite: 'Internal cleanup',
  //     status: 'completed',
  //     tests: icResult?.total || 0,
  //     passed: icResult?.passed || 0,
  //     failed: icResult?.failed || 0,
  //     passRate: icResult?.passRate || '0%',
  //   });
  // } catch (error) {
  //   console.error('❌ Internal cleanup tests failed:', error.message);
  //   results.push({ suite: 'Internal cleanup', status: 'failed', error: error.message });
  // }

  // Generate consolidated report
  const duration = new Date() - startTime;
  const completedSuites = results.filter((r) => r.status === 'completed').length;
  const suiteRunCompletionPct =
    results.length > 0 ? ((completedSuites / results.length) * 100).toFixed(1) : '0.0';

  /** Per-suite test stats (only suites that finished without throwing). */
  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  /** Suites with at least one failed test — primary signal for CI. */
  const suitesWithTestFailures = [];

  for (const r of results) {
    if (r.status !== 'completed' || r.tests === undefined) continue;
    totalTests += r.tests;
    totalPassed += r.passed;
    totalFailed += r.failed;
    if (r.failed > 0) {
      suitesWithTestFailures.push({
        suite: r.suite,
        passed: r.passed,
        failed: r.failed,
        tests: r.tests,
        passRate: r.passRate,
      });
    }
  }

  const thrownSuites = results.filter((r) => r.status === 'failed');
  const overallTestPassPct =
    totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(2) : null;

  const report = {
    executedAt: new Date().toISOString(),
    totalDuration: `${duration}ms`,
    /** @deprecated Same as suiteRunCompletionRate — share of suites that ran without throwing; not aggregate test pass rate. */
    successRate: `${suiteRunCompletionPct}%`,
    /** Share of suites that ran without throwing (not the same as individual test pass rate). */
    suiteRunCompletionRate: `${suiteRunCompletionPct}%`,
    suitesCompletedWithoutError: completedSuites,
    suitesTotal: results.length,
    /** Aggregate across all completed suites that reported test counts. */
    overallTestPassRate: overallTestPassPct !== null ? `${overallTestPassPct}%` : null,
    totalTests,
    totalPassed,
    totalFailed,
    suitesWithTestFailures,
    thrownSuiteErrors: thrownSuites.map((r) => ({ suite: r.suite, error: r.error })),
    suites: results,
    testResultsLocation: path.resolve(process.cwd(), 'test-results'),
  };

  // Save consolidated report
  const reportFile = path.join(process.cwd(), 'test-results', 'consolidated-report.json');
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  // Print final summary — test-level pass rate is primary; suite "no throw" is secondary.
  console.log('\n' + '='.repeat(70));
  console.log('TEST EXECUTION SUMMARY');
  console.log('='.repeat(70));
  console.log(`Executed at: ${new Date().toLocaleString()}`);
  console.log(`Total Duration: ${duration}ms`);

  if (thrownSuites.length > 0) {
    console.log('\n❌ SUITE RUNNER CRASHED (no partial results for these):');
    thrownSuites.forEach((r) => {
      console.log(`   • ${r.suite}: ${r.error || r.status}`);
    });
  }

  if (suitesWithTestFailures.length > 0) {
    console.log('\n⚠️  SUITES WITH FAILED TESTS (non-100% within suite):');
    suitesWithTestFailures.forEach((s) => {
      console.log(
        `   • ${s.suite}: ${s.passed}/${s.tests} passed, ${s.failed} failed (${s.passRate})`
      );
    });
  }

  if (overallTestPassPct !== null) {
    console.log(
      `\nOverall test pass rate: ${overallTestPassPct}% (${totalPassed}/${totalTests} tests passed)`
    );
  } else {
    console.log('\nOverall test pass rate: (no test counts reported)');
  }

  console.log(
    `Suites completed without throwing: ${suiteRunCompletionPct}% (${completedSuites}/${results.length} suites)`
  );

  console.log(`\nDetailed Results:`);
  results.forEach((result) => {
    const status = result.status === 'completed' ? '✅' : '❌';
    if (result.tests !== undefined) {
      const warn = result.failed > 0 ? ' ⚠' : '';
      console.log(
        `  ${status} ${result.suite} - ${result.passed}/${result.tests} passed (${result.passRate})${warn}`
      );
    } else {
      console.log(`  ${status} ${result.suite} - ${result.status}`);
      if (result.error) console.log(`     Error: ${result.error}`);
    }
  });
  console.log(`\nResults Location: ${reportFile}`);
  console.log('='.repeat(70) + '\n');
}

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { runAllTests };
