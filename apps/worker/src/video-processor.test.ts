import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDynamicCropFiltersFromTrack, buildFfmpegDynamicCropXExpr } from './video-processor';

test('buildFfmpegDynamicCropXExpr handles empty, single, and multi-keyframe linear interpolation', () => {
  assert.equal(buildFfmpegDynamicCropXExpr([]), '(iw-ow)/2');

  const single = buildFfmpegDynamicCropXExpr([{ t: 0, x: 0.25 }]);
  assert.equal(single, 'clip(iw*0.25-ow/2,0,iw-ow)');

  const multi = buildFfmpegDynamicCropXExpr([
    { t: 0, x: 0.2 },
    { t: 2, x: 0.8 },
    { t: 4, x: 0.5 },
  ]);
  assert.match(
    multi,
    /^clip\(iw\*\(if\(lt\(t,2\),\(0\.2\+0\.3\*t\),if\(lt\(t,4\),\(0\.8-0\.15\*\(t-2\)\),0\.5\)\)\)-ow\/2,0,iw-ow\)$/,
  );
});

test('buildDynamicCropFiltersFromTrack returns null when hasFaces is false and crop+scale filters when true', () => {
  assert.equal(buildDynamicCropFiltersFromTrack({ hasFaces: false, keyframes: [] }), null);

  const filters = buildDynamicCropFiltersFromTrack(
    {
      hasFaces: true,
      keyframes: [
        { t: 0, x: 0.4 },
        { t: 3, x: 0.6 },
      ],
    },
    1080,
    1920,
  );

  assert.ok(Array.isArray(filters));
  assert.equal(filters.length, 3);
  assert.match(filters[0], /^crop=w='min\(iw,ih\*9\/16\)':h=ih:x='clip\(.*\)':y=0$/);
  assert.equal(filters[1], 'scale=1080:1920:force_original_aspect_ratio=increase');
  assert.equal(filters[2], 'crop=1080:1920');
});
