import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIVE_DURATION_MINUTES,
  MAX_LIVE_DURATION_MINUTES,
  MIN_LIVE_DURATION_MINUTES,
  buildFfmpegLiveCaptureArgs,
  buildFfmpegRemuxMp4Args,
  buildLiveStopChannel,
  buildYtDlpLiveArgs,
  formatLiveProgressPayload,
  normalizeLiveDurationMinutes,
} from './live-recorder';

test('normalizeLiveDurationMinutes applies default and bounds [5, 120]', () => {
  assert.equal(normalizeLiveDurationMinutes(undefined), DEFAULT_LIVE_DURATION_MINUTES);
  assert.equal(normalizeLiveDurationMinutes(null), DEFAULT_LIVE_DURATION_MINUTES);
  assert.equal(normalizeLiveDurationMinutes(Number.NaN), DEFAULT_LIVE_DURATION_MINUTES);
  assert.equal(normalizeLiveDurationMinutes(1), MIN_LIVE_DURATION_MINUTES);
  assert.equal(normalizeLiveDurationMinutes(300), MAX_LIVE_DURATION_MINUTES);
  assert.equal(normalizeLiveDurationMinutes(45.4), 45);
});

test('buildLiveStopChannel formats Redis Pub/Sub stop channel consistently', () => {
  assert.equal(buildLiveStopChannel('vid-123'), 'live-stop:vid-123');
});

test('buildYtDlpLiveArgs includes --no-part, --hls-use-mpegts, and -- delimiter before URL', () => {
  const args = buildYtDlpLiveArgs({
    sourceUrl: 'https://www.twitch.tv/streamer',
    cookiePath: '/tmp/cookies.txt',
  });
  assert.ok(args.includes('--no-part'));
  assert.ok(args.includes('--hls-use-mpegts'));
  assert.ok(args.includes('--cookies'));
  assert.ok(args.includes('/tmp/cookies.txt'));
  assert.equal(args[args.length - 2], '--');
  assert.equal(args[args.length - 1], 'https://www.twitch.tv/streamer');
  assert.ok(!args.includes('--js-runtimes'));

  const ytArgs = buildYtDlpLiveArgs({
    sourceUrl: 'https://www.youtube.com/watch?v=live123',
  });
  assert.ok(ytArgs.includes('--js-runtimes'));
});

test('buildFfmpegLiveCaptureArgs writes resilient mpegts stream bounded by -t', () => {
  const args = buildFfmpegLiveCaptureArgs({
    outTsPath: '/tmp/live.mp4.ts',
    maxDurationSeconds: 1800,
  });
  assert.ok(args.includes('pipe:0'));
  assert.equal(args[args.indexOf('-t') + 1], '1800');
  assert.equal(args[args.indexOf('-f') + 1], 'mpegts');
  assert.equal(args[args.length - 1], '/tmp/live.mp4.ts');
});

test('buildFfmpegRemuxMp4Args supports fast copy remux and H.264/AAC fallback', () => {
  const copyArgs = buildFfmpegRemuxMp4Args({
    inTsPath: '/tmp/live.ts',
    outMp4Path: '/tmp/live.mp4',
  });
  assert.ok(copyArgs.includes('-bsf:a'));
  assert.ok(copyArgs.includes('+faststart'));

  const transcodeArgs = buildFfmpegRemuxMp4Args({
    inTsPath: '/tmp/live.ts',
    outMp4Path: '/tmp/live.mp4',
    transcode: true,
  });
  assert.ok(transcodeArgs.includes('libx264'));
  assert.ok(transcodeArgs.includes('aac'));
});

test('formatLiveProgressPayload computes minutes and MB accurately', () => {
  const payload = formatLiveProgressPayload({
    videoId: 'v-1',
    recordedSeconds: 90,
    fileSizeBytes: 5 * 1024 * 1024,
    liveStatus: 'RECORDING',
  });
  assert.deepEqual(payload, {
    videoId: 'v-1',
    recordedSeconds: 90,
    recordedMinutes: 1.5,
    fileSizeBytes: 5242880,
    fileSizeMb: 5,
    liveStatus: 'RECORDING',
  });
});
