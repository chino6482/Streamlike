import { NextRequest, NextResponse } from 'next/server';
import { HookPosition, HookStyle, LayoutMode, mockStore, recutClipReal } from '@/lib/mock-store';

export const dynamic = 'force-dynamic';

const VALID_STYLES = new Set<HookStyle>(['pill', 'banner', 'minimal']);
const VALID_POSITIONS = new Set<HookPosition>(['top', 'center', 'bottom']);
const VALID_LAYOUTS = new Set<LayoutMode>([
  'AUTO',
  'VERTICAL_CROP',
  'BLUR_FILL',
  'SPLIT',
  'SCREENCAST',
]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; clipId: string } },
) {
  const video = mockStore.videos.get(params.id);
  if (!video) {
    return NextResponse.json({ message: `Video with ID ${params.id} not found` }, { status: 404 });
  }

  const clip = video.clips.find((c) => c.id === params.clipId);
  if (!clip) {
    return NextResponse.json(
      { message: `Clip with ID ${params.clipId} not found` },
      { status: 404 },
    );
  }

  try {
    const body = await req.json();
    let needsRecut = false;

    if (typeof body.startTime === 'number' && Number.isFinite(body.startTime)) {
      const nextStart = Math.max(0, Math.floor(body.startTime));
      if (nextStart !== clip.startTime) needsRecut = true;
      clip.startTime = nextStart;
    }
    if (typeof body.endTime === 'number' && Number.isFinite(body.endTime)) {
      const nextEnd = Math.max(clip.startTime + 3, Math.floor(body.endTime));
      if (nextEnd !== clip.endTime) needsRecut = true;
      clip.endTime = nextEnd;
    }
    if (typeof body.title === 'string') {
      clip.title = body.title.trim().slice(0, 120);
    }
    if (typeof body.hookText === 'string') {
      clip.hookText = body.hookText.trim().slice(0, 140);
    }
    if (typeof body.caption === 'string') {
      clip.caption = body.caption.trim().slice(0, 500);
    }
    if (VALID_STYLES.has(body.hookStyle)) {
      clip.hookStyle = body.hookStyle;
    }
    if (VALID_POSITIONS.has(body.hookPosition)) {
      clip.hookPosition = body.hookPosition;
    }
    if (VALID_LAYOUTS.has(body.layoutMode)) {
      if (body.layoutMode !== clip.layoutMode) needsRecut = true;
      clip.layoutMode = body.layoutMode;
    }

    if (needsRecut) {
      await recutClipReal(video, clip);
    }

    return NextResponse.json(clip);
  } catch (err: any) {
    return NextResponse.json(
      { message: err?.message || 'Error al re-cortar el clip' },
      { status: 400 },
    );
  }
}
