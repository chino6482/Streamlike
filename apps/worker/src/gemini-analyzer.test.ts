import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_VIRAL_MOMENTS, normalizeViralMoments, resolveGeminiApiKey } from './gemini-analyzer';

test('resolveGeminiApiKey prioritizes explicit override over env and rejects placeholders', () => {
  const prev = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = 'env-key-123';
    assert.equal(resolveGeminiApiKey('  user-key-456  '), 'user-key-456');
    assert.equal(resolveGeminiApiKey(''), 'env-key-123');
    assert.equal(resolveGeminiApiKey(undefined), 'env-key-123');

    process.env.GEMINI_API_KEY = 'MY_GEMINI_API_KEY';
    assert.equal(resolveGeminiApiKey(), null);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prev;
  }
});

test('normalizeViralMoments enforces 20-55s clip duration, 1-100 viralScore, deduplication, and max 8 moments', () => {
  const raw = [
    // Too short (5s) -> extended to 20s
    {
      startTime: 10,
      endTime: 15,
      title: 'Corto extendido',
      viralScore: 88,
      hookReason: 'Dato sorprendente al inicio',
      transcript: 'Sabías esto sobre...',
    },
    // Heavy overlap with moment #1 (>50%) and lower score -> dropped
    {
      startTime: 12,
      endTime: 32,
      title: 'Duplicado solapado',
      viralScore: 60,
      hookReason: 'Solapado',
      transcript: 'Solapado',
    },
    // Too long (90s) -> capped to 55s
    {
      startTime: 100,
      endTime: 190,
      title: 'Largo recortado',
      viralScore: 150, // clamped to 100
      hookReason: 'Clímax de la historia',
      transcript: 'Y entonces pasó lo increíble...',
    },
    // Near end of video (295..300 in 300s video) -> pulled back to 280..300
    {
      startTime: 295,
      endTime: 310,
      title: 'Final ajustado',
      viralScore: 0, // clamped to 1
      hookReason: 'Cierre potente',
      transcript: 'No te olvides de...',
    },
  ];

  const result = normalizeViralMoments(raw, 300);
  assert.equal(result.length, 3);

  assert.equal(result[0].startTime, 10);
  assert.equal(result[0].endTime, 30);
  assert.equal(result[0].viralScore, 88);
  assert.equal(result[0].title, 'Corto extendido');

  assert.equal(result[1].startTime, 100);
  assert.equal(result[1].endTime, 155);
  assert.equal(result[1].viralScore, 100);

  assert.equal(result[2].startTime, 280);
  assert.equal(result[2].endTime, 300);
  assert.equal(result[2].viralScore, 1);

  // Max 8 clips enforced
  const many = Array.from({ length: 12 }, (_, i) => ({
    startTime: i * 60,
    endTime: i * 60 + 30,
    title: `Clip ${i}`,
    viralScore: 50 + i,
    hookReason: 'Hook',
    transcript: 'Texto',
  }));
  const limited = normalizeViralMoments(many, 1000);
  assert.equal(limited.length, MAX_VIRAL_MOMENTS);
  // Kept top 8 scores (indices 4..11) sorted chronologically
  assert.equal(limited[0].startTime, 240);
  assert.equal(limited[7].startTime, 660);
});

test('normalizeViralMoments handles short videos (<20s) safely', () => {
  const result = normalizeViralMoments(
    [
      {
        startTime: 0,
        endTime: 12,
        title: 'Clip breve',
        viralScore: 75,
        hookReason: 'Directo al grano',
        transcript: 'Hola mundo',
      },
    ],
    12,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].startTime, 0);
  assert.equal(result[0].endTime, 12);
});
