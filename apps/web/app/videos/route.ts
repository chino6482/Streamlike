import { NextRequest, NextResponse } from 'next/server';
import {
  mockStore,
  startRealVideoProcessing,
  MockVideo,
  LayoutMode,
} from '@/lib/mock-store';
import { assertPublicUrl, sanitizeStorageKey, UnsafeUrlError } from '@/lib/ssrf-guard';

const VALID_LAYOUTS = new Set<LayoutMode>([
  'AUTO',
  'VERTICAL_CROP',
  'BLUR_FILL',
  'SPLIT',
  'SCREENCAST',
]);

export const dynamic = 'force-dynamic';

export async function GET() {
  const list = Array.from(mockStore.videos.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return NextResponse.json(list);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    let validatedSourceUrl: string | null = null;
    if (body.sourceUrl) {
      let rawSource = String(body.sourceUrl).trim();
      if (
        rawSource &&
        !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawSource) &&
        /^[^\s/]+\.[^\s/]+/.test(rawSource)
      ) {
        rawSource = `https://${rawSource}`;
      }
      validatedSourceUrl = await assertPublicUrl(rawSource);
    }

    const s3Key: string = validatedSourceUrl
      ? validatedSourceUrl
      : sanitizeStorageKey(String(body.s3Key || `video-${Date.now()}.mp4`));

    const keepOriginal = body.keepOriginal === true || !validatedSourceUrl;
    const rawClipDuration = Number(body.clipDuration);
    const clipDuration = [15, 30, 45, 60].includes(rawClipDuration)
      ? rawClipDuration
      : 15;
    const layoutMode: LayoutMode = VALID_LAYOUTS.has(body.layoutMode)
      ? body.layoutMode
      : 'AUTO';

    let cookiesText: string | undefined;
    if (body.youtubeCookies !== undefined && body.youtubeCookies !== null) {
      if (typeof body.youtubeCookies !== 'string') {
        return NextResponse.json(
          { message: 'Formato de cookies inválido' },
          { status: 400 },
        );
      }
      const trimmedCookies = body.youtubeCookies.replace(/\0/g, '').trim();
      if (Buffer.byteLength(trimmedCookies, 'utf8') > 256 * 1024) {
        return NextResponse.json(
          { message: 'El archivo de cookies supera el límite de 256 KB' },
          { status: 400 },
        );
      }
      if (trimmedCookies) {
        cookiesText = trimmedCookies;
      }
    }

    const id = crypto.randomUUID();
    const video: MockVideo = {
      id,
      title: String(body.title || `video-${Date.now()}.mp4`).slice(0, 160),
      s3Key,
      duration: Math.max(0, Number(body.duration) || 0),
      status: 'PENDING',
      phase: 'QUEUED',
      errorMessage: null,
      sourceUrl: validatedSourceUrl,
      originalKey: null,
      clipDuration,
      layoutMode,
      topicHint: body.topicHint ? String(body.topicHint).slice(0, 240) : null,
      createdAt: new Date().toISOString(),
      clips: [],
    };

    mockStore.videos.set(id, video);
    startRealVideoProcessing(id, keepOriginal, { cookiesText });

    return NextResponse.json(video, { status: 201 });
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return NextResponse.json({ message: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { message: 'Invalid video payload' },
      { status: 400 },
    );
  }
}
