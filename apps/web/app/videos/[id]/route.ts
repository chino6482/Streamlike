import { NextRequest, NextResponse } from 'next/server';
import { mockStore, deleteVideoFiles } from '@/lib/mock-store';

export const dynamic = 'force-dynamic';

export async function GET(
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
  return NextResponse.json(video);
}

export async function DELETE(
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
  deleteVideoFiles(video);
  mockStore.videos.delete(params.id);
  return NextResponse.json({ id: params.id, deleted: true, objectsDeleted: 1 });
}
