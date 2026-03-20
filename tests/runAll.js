/**
 * Master Test Runner
 * Executes all test suites and generates consolidated report
 */
import fs from 'fs';
import path from 'path';
import { getApiBaseUrl } from './testConfig.js';
import { runAuthTests } from './auth.test.js';
import { runDotPhrasesTests } from './dot-phrases.test.js';
import { runPatientEncounterTests } from './patient-encounters.test.js';
import { runRecordingsTests } from './recordings.test.js';
import { runTranscriptsTests } from './transcripts.test.js';
import { runSoapNotesTests } from './soap-notes.test.js';
import { runNoteTemplateSectionsTests } from './note-template-sections.test.js';
import { runNoteTemplateTests } from './note-templates.test.js';
import { runAwsTests } from './aws.test.js';
import { runPromptLlmTests } from './prompt-llm.test.js';

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

  // Generate consolidated report
  const duration = new Date() - startTime;
  const completedSuites = results.filter((r) => r.status === 'completed').length;
  const successPercentage = ((completedSuites / results.length) * 100).toFixed(1);
  
  const report = {
    executedAt: new Date().toISOString(),
    totalDuration: `${duration}ms`,
    successRate: `${successPercentage}%`,
    suites: results,
    testResultsLocation: path.resolve(process.cwd(), 'test-results'),
  };

  // Save consolidated report
  const reportFile = path.join(process.cwd(), 'test-results', 'consolidated-report.json');
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  // Print final summary
  console.log('\n' + '='.repeat(70));
  console.log('TEST EXECUTION SUMMARY');
  console.log('='.repeat(70));
  console.log(`Executed at: ${new Date().toLocaleString()}`);
  console.log(`Total Duration: ${duration}ms`);
  console.log(`Overall Success Rate: ${successPercentage}% (${completedSuites}/${results.length} suites)`);
  console.log(`\nDetailed Results:`);
  results.forEach((result) => {
    const status = result.status === 'completed' ? '✅' : '❌';
    if (result.tests !== undefined) {
      console.log(`  ${status} ${result.suite} - ${result.passed}/${result.tests} passed (${result.passRate})`);
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
