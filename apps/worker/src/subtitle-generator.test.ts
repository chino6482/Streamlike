import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAssTimestamp,
  splitTranscriptIntoBlocks,
  buildSubtitleCues,
  generateAssContent,
  escapeFfmpegFilterPath,
} from './subtitle-generator';

test('formatAssTimestamp formats H:MM:SS.cc accurately including centisecond rounding', () => {
  assert.equal(formatAssTimestamp(0), '0:00:00.00');
  assert.equal(formatAssTimestamp(-3), '0:00:00.00');
  assert.equal(formatAssTimestamp(12.345), '0:00:12.35');
  assert.equal(formatAssTimestamp(65.996), '0:01:06.00');
  assert.equal(formatAssTimestamp(3661.5), '1:01:01.50');
});

test('splitTranscriptIntoBlocks produces 3-4 word blocks without orphan 1-word tail when possible', () => {
  assert.deepEqual(splitTranscriptIntoBlocks(''), []);
  assert.deepEqual(
    splitTranscriptIntoBlocks('Uno dos tres cuatro cinco'),
    ['Uno dos tres', 'cuatro cinco'],
  );
  assert.deepEqual(
    splitTranscriptIntoBlocks('Esta es una prueba de subtítulos dinámicos virales'),
    ['Esta es una prueba', 'de subtítulos dinámicos virales'],
  );
  assert.deepEqual(
    splitTranscriptIntoBlocks('Uno dos tres cuatro cinco seis siete ocho nueve'),
    ['Uno dos tres cuatro', 'cinco seis siete', 'ocho nueve'],
  );
});

test('buildSubtitleCues distributes proportional timestamps from 0 to clipDuration and supports precise wordTimestamps', () => {
  const cues = buildSubtitleCues({
    transcript: 'Hola mundo esto funciona genial en vertical hoy',
    startTime: 10,
    endTime: 30,
  });

  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 0);
  assert.ok(cues[0].end > 0 && cues[0].end < 20);
  assert.equal(cues[1].start, cues[0].end);
  assert.equal(cues[1].end, 20);

  const precise = buildSubtitleCues({
    transcript: 'Hola mundo genial ahora',
    startTime: 50,
    endTime: 60,
    wordTimestamps: [
      { word: 'Hola', start: 51, end: 51.6 },
      { word: 'mundo', start: 51.6, end: 52.2 },
      { word: 'genial', start: 52.3, end: 53.0 },
      { word: 'ahora', start: 53.1, end: 54.0 },
    ],
  });
  assert.equal(precise.length, 1);
  assert.equal(precise[0].start, 1);
  assert.equal(precise[0].end, 4);
  assert.equal(precise[0].text, 'Hola mundo genial ahora');
});

test('generateAssContent includes 1080x1920 PlayRes, bold white style, Outline=3, MarginV=380, and escaped dialogue', () => {
  assert.equal(
    generateAssContent({ transcript: '   ', startTime: 0, endTime: 25 }),
    null,
  );

  const ass = generateAssContent({
    transcript: 'Mira {esto} rápido ahora mismo',
    startTime: 12,
    endTime: 37,
  });
  assert.ok(ass);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Style: ViralBold,DejaVu Sans,68,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,60,60,380,1/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,.*,ViralBold,,0,0,0,,Mira \\\{esto\\\}/);
  assert.match(ass, /0:00:25\.00,ViralBold/);
});

test('escapeFfmpegFilterPath escapes colons, quotes, brackets and backslashes', () => {
  assert.equal(
    escapeFfmpegFilterPath('C:\\tmp\\clip:1[v].ass'),
    'C\\:/tmp/clip\\:1\\[v\\].ass',
  );
});
