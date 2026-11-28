import { NextRequest, NextResponse } from 'next/server';
import { getUploadedFile, mockStore } from '@/lib/mock-store';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const video = mockStore.videos.get(params.id);
  if (!video) {
    return NextResponse.json({ message: `Video with ID ${params.id} not found` }, { status: 404 });
  }
  if (!video.originalKey) {
    return NextResponse.json(
      {
        message:
          'Este video no tiene copia completa guardada. Procesa de nuevo el enlace activando "Guardar video completo".',
      },
      { status: 404 },
    );
  }

  const uploaded = getUploadedFile(video.originalKey);
  if (!uploaded) {
    return NextResponse.json(
      {
        message:
          'El archivo completo aún se está descargando o ya no está disponible en almacenamiento temporal.',
      },
      { status: 404 },
    );
  }

  const safeTitle = (video.title || 'video').replace(/[^\w.-]+/g, '_');
  const filename = safeTitle.endsWith('.mp4') ? safeTitle : `${safeTitle}.mp4`;
  const url = `/upload/mock/${encodeURIComponent(video.originalKey)}?download=1&filename=${encodeURIComponent(filename)}`;

  return NextResponse.json({
    id: video.id,
    url,
    filename,
    expiresIn: 900,
  });
}
