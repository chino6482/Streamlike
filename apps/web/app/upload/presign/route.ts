import { NextRequest, NextResponse } from 'next/server';
import { sanitizeStorageKey, UnsafeUrlError } from '@/lib/ssrf-guard';

export async function POST(req: NextRequest) {
  try {
    const { fileName } = await req.json();
    const key = sanitizeStorageKey(String(fileName || `upload-${Date.now()}.mp4`));
    return NextResponse.json({
      url: `/upload/mock/${encodeURIComponent(key)}`,
      bucket: 'local-mock',
      key,
    });
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return NextResponse.json({ message: err.message }, { status: 400 });
    }
    return NextResponse.json({ message: 'Invalid presign payload' }, { status: 400 });
  }
}
