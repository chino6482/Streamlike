import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApiHeaders, GEMINI_STORAGE_KEY, sanitizeGeminiKey } from './api-headers';

test('GEMINI_STORAGE_KEY uses expected key name', () => {
  assert.equal(GEMINI_STORAGE_KEY, 'GEMINI_API_KEY');
});

test('sanitizeGeminiKey strips control characters and rejects empty or oversized values', () => {
  assert.equal(sanitizeGeminiKey('  AIzaTest123\r\n  '), 'AIzaTest123');
  assert.equal(sanitizeGeminiKey('   '), undefined);
  assert.equal(sanitizeGeminiKey(null), undefined);
  assert.equal(sanitizeGeminiKey('a'.repeat(513)), undefined);
});

test('buildApiHeaders includes x-gemini-key only when valid key is provided', () => {
  const withoutGemini = buildApiHeaders({ apiKey: 'srv-key' });
  assert.deepEqual(withoutGemini, {
    Accept: 'application/json',
    'x-api-key': 'srv-key',
  });

  const withGemini = buildApiHeaders({
    apiKey: 'srv-key',
    geminiKey: ' AIzaUserKey999 ',
  });
  assert.deepEqual(withGemini, {
    Accept: 'application/json',
    'x-api-key': 'srv-key',
    'x-gemini-key': 'AIzaUserKey999',
  });
});
