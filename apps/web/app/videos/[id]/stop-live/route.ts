import { NextRequest, NextResponse } from 'next/server';
import { mockStore, stopLiveLocal } from '@/lib/mock-store';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const video = mockStore.videos.get(params.id);
  if (!video) {
    return NextResponse.json(
      { message: `Video with ID ${params.id} not found` },
      { status: 404 },
    );
  }
  if (!video.isLiveCapture) {
    return NextResponse.json(
      { message: 'Este video no es una captura en vivo.' },
      { status: 400 },
    );
  }
  if (video.liveStatus === 'FINISHED') {
    return NextResponse.json(
      { message: 'La captura en vivo ya finalizó.' },
      { status: 400 },
    );
  }

  stopLiveLocal(params.id);
  return NextResponse.json({
    id: video.id,
    isLiveCapture: true,
    liveStatus: 'STOPPED',
  });
}
