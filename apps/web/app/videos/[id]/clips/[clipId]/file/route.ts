import * as fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import { getClipFilePath, mockStore } from '@/lib/mock-store';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; clipId: string } },
) {
  const video = mockStore.videos.get(params.id);
  const clip = video?.clips.find((c) => c.id === params.clipId);
  const filePath = getClipFilePath(params.clipId);

  if (!video || !clip || !filePath) {
    return NextResponse.json(
      { message: 'El archivo del clip no está disponible.' },
      { status: 404 },
    );
  }

  const stat = fs.statSync(filePath);
  const total = stat.size;
  const download = req.nextUrl.searchParams.get('download') === '1';
  const safeBase = (clip.title || video.title || 'clip').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const filename = `${safeBase}-${clip.format.toLowerCase()}.mp4`;

  const range = req.headers.get('range');
  if (range && !download) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(total - 1, Number(match[2])) : total - 1;
      if (start <= end && start < total) {
        const length = end - start + 1;
        const buf = Buffer.alloc(length);
        const fd = fs.openSync(filePath, 'r');
        try {
          fs.readSync(fd, buf, 0, length, start);
        } finally {
          fs.closeSync(fd);
        }
        return new NextResponse(buf, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(length),
            'Content-Type': 'video/mp4',
          },
        });
      }
    }
  }

  const data = fs.readFileSync(filePath);
  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Content-Length': String(total),
    'Accept-Ranges': 'bytes',
  };
  if (download) {
    headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  }

  return new NextResponse(data, { status: 200, headers });
}
