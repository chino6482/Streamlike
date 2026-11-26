import { NextRequest, NextResponse } from 'next/server';
import {
  mockStore,
  startRealVideoProcessing,
  MockVideo,
  LayoutMode,
} from '@/lib/mock-store';
import { assertPublicUrl, sanitizeStorageKey, UnsafeUrlError } from '@/lib/ssrf-guard';
import { sanitizeGeminiKey } from '@/lib/api-headers';

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

    const isLiveCapture = body.isLiveCapture === true;
    const findActiveLive = () =>
      Array.from(mockStore.videos.values()).find(
        (v) => v.isLiveCapture && v.liveStatus === 'RECORDING',
      );

    if (isLiveCapture && findActiveLive()) {
      return NextResponse.json(
        {
          message:
            'Ya existe una transmisión en vivo capturándose. Solo se permite capturar 1 directo a la vez hasta que finalice o se detenga.',
        },
        { status: 409 },
      );
    }

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

    if (isLiveCapture && !validatedSourceUrl) {
      return NextResponse.json(
        {
          message:
            'El modo transmisión en vivo requiere un enlace público válido (YouTube Live, Twitch, Kick o TikTok Live).',
        },
        { status: 400 },
      );
    }

    // Segunda verificación síncrona tras los `await` para evitar carreras TOCTOU
    if (isLiveCapture && findActiveLive()) {
      return NextResponse.json(
        {
          message:
            'Ya existe una transmisión en vivo capturándose. Solo se permite capturar 1 directo a la vez hasta que finalice o se detenga.',
        },
        { status: 409 },
      );
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

    const rawLiveMins = Number(body.liveDurationMinutes);
    const liveDurationMinutes = isLiveCapture
      ? Number.isFinite(rawLiveMins)
        ? Math.max(5, Math.min(120, Math.round(rawLiveMins)))
        : 30
      : null;

    const id = crypto.randomUUID();
    const video: MockVideo = {
      id,
      title: String(body.title || `video-${Date.now()}.mp4`).slice(0, 160),
      s3Key,
      duration: Math.max(0, Number(body.duration) || 0),
      status: 'PENDING',
      phase: isLiveCapture ? 'LIVE_RECORDING' : 'QUEUED',
      errorMessage: null,
      sourceUrl: validatedSourceUrl,
      originalKey: null,
      clipDuration,
      layoutMode,
      autoReframe: body.autoReframe !== false,
      topicHint: body.topicHint ? String(body.topicHint).slice(0, 240) : null,
      isLiveCapture,
      liveDurationMinutes,
      liveStatus: isLiveCapture ? 'RECORDING' : null,
      liveRecordedSeconds: isLiveCapture ? 0 : undefined,
      liveFileSizeBytes: isLiveCapture ? 0 : undefined,
      createdAt: new Date().toISOString(),
      clips: [],
    };

    const geminiApiKey = sanitizeGeminiKey(req.headers.get('x-gemini-key'));

    mockStore.videos.set(id, video);
    startRealVideoProcessing(id, keepOriginal, { cookiesText, geminiApiKey });

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
