import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveS3ClientConfig, rewritePresignedS3Url } from './s3.config';

test('resolveS3ClientConfig handles auto region and forcePathStyle for R2, Supabase, and LocalStack', () => {
  const r2 = resolveS3ClientConfig({
    AWS_REGION: 'auto',
    S3_ENDPOINT: 'https://acc123.r2.cloudflarestorage.com',
    AWS_ACCESS_KEY_ID: 'r2-id',
    AWS_SECRET_ACCESS_KEY: 'r2-secret',
  });
  assert.equal(r2.region, 'auto');
  assert.equal(r2.forcePathStyle, true);
  assert.equal(r2.endpoint, 'https://acc123.r2.cloudflarestorage.com');

  const supabase = resolveS3ClientConfig({
    AWS_REGION: 'eu-central-1',
    S3_ENDPOINT: 'https://ref.supabase.co/storage/v1/s3',
  });
  assert.equal(supabase.region, 'eu-central-1');
  assert.equal(supabase.forcePathStyle, true);
});

test('rewritePresignedS3Url only rewrites internal localstack host', () => {
  assert.equal(
    rewritePresignedS3Url('http://localstack:4566/bucket/key?X-Amz-Signature=1'),
    'http://localhost:4566/bucket/key?X-Amz-Signature=1',
  );
  assert.equal(
    rewritePresignedS3Url('https://acc123.r2.cloudflarestorage.com/bucket/key?sig=1'),
    'https://acc123.r2.cloudflarestorage.com/bucket/key?sig=1',
  );
});
