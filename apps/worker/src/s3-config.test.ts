import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkerS3Config, buildPublicObjectUrl } from './s3-config';

test('resolveWorkerS3Config defaults to region=auto and forcePathStyle=true for R2/Supabase/LocalStack compatibility', () => {
  const defaultCfg = resolveWorkerS3Config({});
  assert.equal(defaultCfg.region, 'auto');
  assert.equal(defaultCfg.forcePathStyle, true);
  assert.equal(defaultCfg.endpoint, undefined);

  const r2Cfg = resolveWorkerS3Config({
    AWS_REGION: 'auto',
    S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
    AWS_ACCESS_KEY_ID: 'key',
    AWS_SECRET_ACCESS_KEY: 'secret',
  });
  assert.equal(r2Cfg.region, 'auto');
  assert.equal(r2Cfg.forcePathStyle, true);
  assert.equal(r2Cfg.endpoint, 'https://abc123.r2.cloudflarestorage.com');

  const supabaseCfg = resolveWorkerS3Config({
    AWS_REGION: 'us-east-1',
    S3_ENDPOINT: 'https://xyz.supabase.co/storage/v1/s3',
  });
  assert.equal(supabaseCfg.region, 'us-east-1');
  assert.equal(supabaseCfg.forcePathStyle, true);
});

test('buildPublicObjectUrl formats LocalStack, Cloudflare R2, and Supabase Storage public URLs without duplicating bucket names', () => {
  // LocalStack
  assert.equal(
    buildPublicObjectUrl({
      bucket: 'streamlike-bucket',
      key: 'clips/v1/clip.mp4',
      s3Endpoint: 'http://localstack:4566',
    }),
    'http://localhost:4566/streamlike-bucket/clips/v1/clip.mp4',
  );

  // Cloudflare R2 public dev domain (bucket root)
  assert.equal(
    buildPublicObjectUrl({
      bucket: 'streamlike-bucket',
      key: 'clips/v1/clip.mp4',
      publicEndpoint: 'https://pub-deadbeef1234.r2.dev/',
    }),
    'https://pub-deadbeef1234.r2.dev/clips/v1/clip.mp4',
  );

  // Supabase Storage public object URL (already ends with /<bucket>)
  assert.equal(
    buildPublicObjectUrl({
      bucket: 'streamlike-bucket',
      key: 'clips/v1/clip.mp4',
      publicEndpoint: 'https://proj.supabase.co/storage/v1/object/public/streamlike-bucket',
    }),
    'https://proj.supabase.co/storage/v1/object/public/streamlike-bucket/clips/v1/clip.mp4',
  );
});
