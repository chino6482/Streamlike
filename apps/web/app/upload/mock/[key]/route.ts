import * as fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import { getUploadedFile, saveUploadedFile } from '@/lib/mock-store';
import { sanitizeStorageKey, UnsafeUrlError } from '@/lib/ssrf-guard';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, { params }: { params: { key: string } }) {
  try {
    const key = sanitizeStorageKey(decodeURIComponent(params.key));
    const arrayBuffer = await req.arrayBuffer();
    const contentType = req.headers.get('content-type') || 'video/mp4';
    saveUploadedFile(key, Buffer.from(arrayBuffer), contentType);
    return new NextResponse(null, { status: 200 });
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return NextResponse.json({ message: err.message }, { status: 400 });
    }
    return NextResponse.json({ message: 'Upload error' }, { status: 400 });
  }
}

export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  let key: string;
  try {
    key = sanitizeStorageKey(decodeURIComponent(params.key));
  } catch (err) {
    return NextResponse.json({ message: (err as Error).message }, { status: 400 });
  }

  const meta = getUploadedFile(key);
  if (!meta) {
    return NextResponse.json(
      {
        message: 'Archivo no disponible en almacenamiento temporal.',
      },
      { status: 404 },
    );
  }

  const stat = fs.statSync(meta.filePath);
  const total = stat.size;
  const download = req.nextUrl.searchParams.get('download') === '1';
  const rawFilename = req.nextUrl.searchParams.get('filename') || 'video.mp4';
  const safeFilename = rawFilename.replace(/[^\w.-]+/g, '_');

  const range = req.headers.get('range');
  if (range && !download) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(total - 1, Number(match[2])) : total - 1;
      if (start <= end && start < total) {
        const length = end - start + 1;
        const buf = Buffer.alloc(length);
        const fd = fs.openSync(meta.filePath, 'r');
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
            'Content-Type': meta.contentType,
          },
        });
      }
    }
  }

  const data = fs.readFileSync(meta.filePath);
  const headers: Record<string, string> = {
    'Content-Type': meta.contentType,
    'Content-Length': String(total),
    'Accept-Ranges': 'bytes',
  };
  if (download) {
    headers['Content-Disposition'] = `attachment; filename="${safeFilename}"`;
  }

  return new NextResponse(data, { status: 200, headers });
}
