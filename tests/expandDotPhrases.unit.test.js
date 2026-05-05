/**
 * Unit Test: expandDotPhrases (prosody punctuation stripping)
 *
 * Ensures Aho-Corasick matching ignores meaningless ASR punctuation (",", ".", ";")
 * while replacements still apply to the correct original span.
 *
 * Pure unit tests: no API, no database, no external services.
 */

import assert from 'assert';
import { UnitTestRunner } from './unitTestRunner.js';
import { expandDotPhrases } from '../src/fastify/controllers/transcriptsController.js';

const runner = new UnitTestRunner('expandDotPhrases Unit Tests', { maxStringLength: 50_000 });

const DOT_PHRASES = [
  { trigger: 'pt', expansion: 'patient' },
  // Keep explicit 'patient' after 'pt' so it wins over abbreviation-expanded 'patient'
  { trigger: 'patient', expansion: 'the patient' },
  {
    trigger: 'exam child',
    expansion: `General: Alert, interactive, age-appropriate behavior. No acute distress.
Growth Parameters: Height, weight, BMI plotted on growth chart; percentiles noted.
HEENT: Normocephalic, atraumatic. Pupils equal, round. Nasal mucosa pink, no discharge. Oropharynx clear, moist mucosa, no tonsillar enlargement.
Neck: Supple, no lymphadenopathy or masses.
Cardiovascular: Regular rate and rhythm. No murmurs, rubs, or gallops. Peripheral pulses palpable.
Respiratory: Clear to auscultation bilaterally. No wheezes, rales, or rhonchi. No retractions.
Abdomen: Soft, non-tender, non-distended. Bowel sounds present. No hepatosplenomegaly.
Genitourinary: Normal external genitalia. No rashes, lesions, or discharge.
Musculoskeletal: Full range of motion. No deformities or swelling. Normal gait.
Skin: Warm, dry, intact. No rashes, bruises, or lesions.
Neurological: Alert, oriented. Normal tone and reflexes.
Psychosocial: Age-appropriate interaction. No concerns noted by caregiver.`,
  },
];

runner.test('Matches across comma within a word (pat,ient → patient)', () => {
  const input = 'pat,ient has fever';
  const { expanded, llm_notated } = expandDotPhrases(input, DOT_PHRASES);

  assert.strictEqual(expanded, 'the patient has fever');
  assert(llm_notated.includes('the patient'), 'LLM-notated output should include expansion');
  assert(!expanded.includes('pat,ient'), 'Original comma-span should be replaced');
  return { original: input, expanded, llm_notated };
}, { category: 'Prosody punctuation stripping' });

runner.test('Matches across semicolon within a word (p;t → pt)', () => {
  const input = 'see p;t for follow up';
  const { expanded, llm_notated } = expandDotPhrases(input, DOT_PHRASES);

  assert.strictEqual(expanded, 'see patient for follow up');
  return { original: input, expanded, llm_notated };
}, { category: 'Prosody punctuation stripping' });

runner.test('Matches across period within a word (p.t → pt)', () => {
  const input = 'see p.t for follow up';
  const { expanded, llm_notated } = expandDotPhrases(input, DOT_PHRASES);

  assert.strictEqual(expanded, 'see patient for follow up');
  return { original: input, expanded, llm_notated };
}, { category: 'Prosody punctuation stripping' });

runner.test('Does not strip other punctuation for matching (question mark blocks match)', () => {
  const input = 'see p?t for follow up';
  const { expanded, llm_notated } = expandDotPhrases(input, DOT_PHRASES);

  assert.strictEqual(expanded, input);
  return { original: input, expanded, llm_notated };
}, { category: 'Non-prosody punctuation behavior' });

runner.test('Matches exam child across comma punctuation (exam, child)', () => {
  const input = 'We will now do exam, child then plan.';
  const { expanded, llm_notated } = expandDotPhrases(input, DOT_PHRASES);

  assert(
    expanded.includes('General: Alert, interactive, age-appropriate behavior. No acute distress.'),
    'Expanded output should include exam child expansion'
  );
  assert(!expanded.includes('exam, child'), 'Original trigger span should be replaced');
  assert(
    llm_notated.includes('<dotphrase'),
    'LLM-notated output should include dotphrase wrapper'
  );
  assert(
    llm_notated.includes('</dotphrase>'),
    'LLM-notated output should include closing dotphrase wrapper'
  );
  return { original: input, expanded, llm_notated };
}, { category: 'Prosody punctuation stripping' });

runner.exit();

