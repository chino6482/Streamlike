import { NextRequest, NextResponse } from 'next/server';
import { mockStore } from '@/lib/mock-store';
import {
  generateViralClipMetadata,
  GeminiConfigError,
} from '@/lib/gemini-clips';
import { sanitizeGeminiKey } from '@/lib/api-headers';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const videoId = String(body.videoId || '').trim();
    if (!videoId) {
      return NextResponse.json(
        { message: 'videoId es obligatorio' },
        { status: 400 },
      );
    }

    const video = mockStore.videos.get(videoId);
    if (!video) {
      return NextResponse.json(
        { message: `Video ${videoId} no encontrado` },
        { status: 404 },
      );
    }

    if (!video.clips || video.clips.length === 0) {
      return NextResponse.json(
        { message: 'El video aún no tiene clips generados para analizar.' },
        { status: 400 },
      );
    }

    // Agrupar por startTime para analizar cada momento una vez y aplicarlo a ambos formatos
    const uniqueWindowsMap = new Map<
      number,
      { startTime: number; endTime: number; audioScore: number }
    >();
    for (const c of video.clips) {
      if (!uniqueWindowsMap.has(c.startTime)) {
        uniqueWindowsMap.set(c.startTime, {
          startTime: c.startTime,
          endTime: c.endTime,
          audioScore: c.score,
        });
      }
    }

    const topicHint =
      typeof body.topicHint === 'string' && body.topicHint.trim()
        ? body.topicHint.trim()
        : video.topicHint || undefined;

    const headerGeminiKey = sanitizeGeminiKey(req.headers.get('x-gemini-key'));

    const results = await generateViralClipMetadata(
      {
        videoTitle: video.title,
        sourceUrl: video.sourceUrl,
        topicHint,
        duration: video.duration,
        windows: Array.from(uniqueWindowsMap.values()),
      },
      headerGeminiKey,
    );

    const byStart = new Map(results.map((r) => [r.startTime, r]));
    for (const clip of video.clips) {
      const match =
        byStart.get(clip.startTime) ??
        results.find((r) => Math.abs(r.startTime - clip.startTime) <= 2);
      if (!match) continue;
      clip.title = match.title;
      clip.hookText = match.hookText;
      clip.why = match.why;
      clip.hookReason = match.why;
      clip.caption = match.caption;
      if (Number.isFinite(match.suggestedScore)) {
        const bounded = Math.max(0, Math.min(100, Math.round(match.suggestedScore)));
        clip.score = bounded;
        clip.viralScore = bounded;
      }
    }

    return NextResponse.json(video);
  } catch (err: any) {
    if (err instanceof GeminiConfigError) {
      return NextResponse.json({ message: err.message }, { status: 503 });
    }
    const status = err?.status === 403 || err?.status === 400 ? err.status : 500;
    return NextResponse.json(
      {
        message:
          err?.message ||
          'No se pudo analizar los clips con Gemini. Verifica tu clave en Settings > Secrets.',
      },
      { status },
    );
  }
}
