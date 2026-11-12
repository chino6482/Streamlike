'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ComponentType } from 'react';
import { useDropzone } from 'react-dropzone';
import axios from 'axios';
import { io } from 'socket.io-client';
import {
  Upload,
  Film,
  CheckCircle2,
  Clock,
  AlertCircle,
  Play,
  Sparkles,
  Trash2,
  X,
  Loader2,
  Wand2,
  Scissors,
  AlertTriangle,
  TrendingUp,
  Download,
} from 'lucide-react';

interface Clip {
  id: string;
  s3Key: string;
  clipUrl: string;
  startTime: number;
  endTime: number;
  score: number;
  format: 'VERTICAL' | 'HORIZONTAL';
  title?: string;
}

interface Video {
  id: string;
  title: string;
  s3Key: string;
  duration: number;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  /** Fase informativa enviada por el worker (p. ej. "DURATION"). */
  phase?: string;
  /** Enlace de origen (YouTube, TikTok, MP4 directo...). */
  sourceUrl?: string | null;
  /** Clave S3 del video completo guardado (si se conservó). */
  originalKey?: string | null;
  createdAt: string;
  clips?: Clip[];
}

interface ToastMessage {
  type: 'success' | 'error';
  message: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
// Cabecera opcional de API key (solo si el backend exige API_KEY)
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;
const apiHeaders: Record<string, string> = API_KEY
  ? { 'x-api-key': API_KEY }
  : {};

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function Dashboard() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [linkUrl, setLinkUrl] = useState('');
  const [processingFromLink, setProcessingFromLink] = useState(false);
  /** Guardar también el video completo en el servidor (descargable). */
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<Video | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const selectedVideo = useMemo(
    () => videos.find((v) => v.id === selectedId) || null,
    [videos, selectedId],
  );

  const stats = useMemo(
    () => ({
      total: videos.length,
      pending: videos.filter(
        (v) => v.status === 'PENDING' || v.status === 'PROCESSING',
      ).length,
      completed: videos.filter((v) => v.status === 'COMPLETED').length,
      clips: videos.reduce((n, v) => n + (v.clips?.length || 0), 0),
    }),
    [videos],
  );

  // Auto-ocultar el toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const fetchVideos = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE}/videos`, { headers: apiHeaders });
      setVideos(res.data);
    } catch (err) {
      console.error('Error al cargar videos:', err);
    }
  }, []);

  useEffect(() => {
    fetchVideos();

    // Conexión Socket.io para estado en tiempo real (con API key si aplica)
    const socket = io(API_BASE, { auth: { apiKey: API_KEY } });

    socket.on('connect', () => {
      console.log('Socket.io conectado al backend');
    });

    socket.on('video-status', (payload: any) => {
      setVideos((prev) =>
        prev.map((v) =>
          v.id === payload.id
            ? { ...v, status: payload.status, phase: payload.phase }
            : v,
        ),
      );
      // Refrescar para obtener nuevos clips si se completa
      if (payload.status === 'COMPLETED') {
        fetchVideos();
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [fetchVideos]);

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;

      setUploading(true);
      setUploadProgress(0);

      try {
        const fileName = `${Date.now()}-${file.name.replace(/\s+/g, '_')}`;

        // 1. Obtener URL prefirmada
        const presignRes = await axios.post(
          `${API_BASE}/upload/presign`,
          { fileName, contentType: file.type || 'video/mp4' },
          { headers: apiHeaders },
        );
        const { url } = presignRes.data;

        // 2. Subir directo a S3 / LocalStack
        await axios.put(url, file, {
          headers: { 'Content-Type': file.type || 'video/mp4' },
          onUploadProgress: (progressEvent) => {
            if (progressEvent.total) {
              const percent = Math.round(
                (progressEvent.loaded * 100) / progressEvent.total,
              );
              setUploadProgress(percent);
            }
          },
        });

        // 3. Registrar el video en la API y ponerlo en cola
        await axios.post(
          `${API_BASE}/videos`,
          { title: file.name, s3Key: fileName, duration: 0 },
          { headers: apiHeaders },
        );

        await fetchVideos();
        setToast({ type: 'success', message: 'Video subido y en cola de análisis' });
      } catch (err) {
        console.error('Error durante la subida:', err);
        setToast({
          type: 'error',
          message: 'Error al subir el video. Verifica que los servicios estén activos.',
        });
      } finally {
        setUploading(false);
        setUploadProgress(0);
      }
    },
    [fetchVideos],
  );

  const confirmDelete = useCallback(async () => {
    if (!confirmTarget) return;
    const id = confirmTarget.id;
    setDeleting(true);
    try {
      await axios.delete(`${API_BASE}/videos/${id}`, { headers: apiHeaders });
      setVideos((prev) => prev.filter((v) => v.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
      setToast({ type: 'success', message: 'Video y clips eliminados' });
      setConfirmTarget(null);
    } catch (err) {
      console.error('Error al eliminar el video:', err);
      setToast({ type: 'error', message: 'No se pudo eliminar el video' });
    } finally {
      setDeleting(false);
    }
  }, [confirmTarget]);

  const processFromUrl = useCallback(async () => {
    const url = linkUrl.trim();
    if (!url) {
      setToast({ type: 'error', message: 'Pega un enlace de video para procesar' });
      return;
    }
    setProcessingFromLink(true);
    try {
      const res = await axios.post(
        `${API_BASE}/videos`,
        {
          title: `video-${Date.now()}.mp4`,
          s3Key: url,
          duration: 0,
          sourceUrl: url,
          keepOriginal,
        },
        { headers: apiHeaders },
      );
      setToast({ type: 'success', message: 'Video en cola desde el enlace' });
      setLinkUrl('');
      await fetchVideos();
    } catch (err) {
      console.error('Error al procesar desde enlace:', err);
      setToast({
        type: 'error',
        message: 'No se pudo procesar el video desde el enlace',
      });
    } finally {
      setProcessingFromLink(false);
    }
  }, [fetchVideos, linkUrl, apiHeaders, keepOriginal]);

  /**
   * Descarga el video COMPLETO (no los clips). Pide a la API una URL
   * prefirmada y la abre en una pestaña nueva con `download`.
   */
  const downloadFullVideo = useCallback(async (video: Video) => {
    setDownloadingId(video.id);
    try {
      const res = await axios.get(`${API_BASE}/videos/${video.id}/download`, {
        headers: apiHeaders,
      });
      const { url, filename } = res.data;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'video.mp4';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setToast({ type: 'success', message: 'Descarga del video completo iniciada' });
    } catch (err: any) {
      console.error('Error al descargar el video completo:', err);
      setToast({
        type: 'error',
        message:
          err?.response?.data?.message ||
          'No se pudo descargar el video completo',
      });
    } finally {
      setDownloadingId(null);
    }
  }, [apiHeaders]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'video/*': ['.mp4', '.mov', '.avi', '.mkv'] },
    maxFiles: 1,
    disabled: uploading,
  });

  return (
    <div className="space-y-12">
      {/* ---------------- Hero ---------------- */}
      <section className="animate-fade-up space-y-6 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-4 py-1.5 text-xs font-medium text-indigo-300">
          <Sparkles className="h-3.5 w-3.5" />
          Análisis automático de momentos destacados
        </span>
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
          Convierte videos largos en{' '}
          <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400 bg-clip-text text-transparent">
            clips virales
          </span>
        </h1>
        <p className="mx-auto max-w-2xl text-sm text-slate-400 sm:text-base">
          Sube un video y el worker detecta los momentos de mayor energía (audio y
          acción) para generar versiones verticales 9:16 y horizontales listas para
          publicar.
        </p>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-4">
          <StatCard icon={Film} label="Videos" value={stats.total} />
          <StatCard
            icon={Loader2}
            label="En proceso"
            value={stats.pending}
            spin={stats.pending > 0}
          />
          <StatCard icon={CheckCircle2} label="Completados" value={stats.completed} />
          <StatCard icon={Scissors} label="Clips generados" value={stats.clips} />
        </div>
      </section>

      {/* ---------------- Dropzone ---------------- */}
      <section className="animate-fade-up rounded-3xl border border-white/5 bg-white/[0.02] p-6 backdrop-blur sm:p-8">
        <div
          {...getRootProps()}
          className={`group flex cursor-pointer flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed p-10 text-center transition ${
            isDragActive
              ? 'border-indigo-400 bg-indigo-500/10'
              : 'border-slate-700 bg-slate-950/40 hover:border-indigo-500/60 hover:bg-slate-900/40'
          } ${uploading ? 'cursor-not-allowed opacity-60' : ''}`}
        >
          <input {...getInputProps()} />
          <div
            className={`grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/20 to-fuchsia-500/20 text-indigo-300 transition group-hover:scale-105 ${
              isDragActive ? 'animate-pulse-ring' : ''
            }`}
          >
            <Upload className="h-7 w-7" />
          </div>

          {uploading ? (
            <div className="w-full max-w-xs space-y-3">
              <p className="text-sm font-medium text-slate-300">
                Subiendo video: {uploadProgress}%
              </p>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-2 rounded-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          ) : (
            <>
              <div>
                <p className="text-base font-semibold text-slate-200">
                  {isDragActive
                    ? 'Suelta el archivo aquí...'
                    : 'Arrastra y suelta un video aquí'}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  o haz clic para seleccionar · MP4, MOV, AVI, MKV hasta 500 MB
                </p>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ---------------- Procesar desde enlace ---------------- */}
      <section className="animate-fade-up rounded-3xl border border-white/5 bg-white/[0.02] p-6 backdrop-blur sm:p-8">
        <h2 className="flex items-center gap-2 text-lg font-bold text-slate-200">
          <Wand2 className="h-5 w-5 text-indigo-400" />
          Procesar video desde enlace
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Pega un enlace (YouTube, TikTok o un MP4 directo) y el worker descargará
          el video y generará los clips automáticamente.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <input
            type="url"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=...  |  https://ejemplo.com/video.mp4"
            className="flex-1 rounded-xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-200 placeholder:text-slate-600 outline-none transition focus:border-indigo-500/60"
          />
          <button
            onClick={processFromUrl}
            disabled={processingFromLink}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-3 text-sm font-semibold text-white transition hover:from-indigo-500 hover:to-violet-500 disabled:opacity-50"
          >
            {processingFromLink ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Wand2 className="h-4 w-4" />
            )}
            Procesar
          </button>
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 text-xs text-slate-400 transition hover:border-indigo-500/30">
          <input
            type="checkbox"
            checked={keepOriginal}
            onChange={(e) => setKeepOriginal(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/20 bg-slate-900 text-indigo-500 accent-indigo-500 focus:ring-indigo-500/40"
          />
          <span>
            <span className="font-semibold text-slate-300">
              Guardar el video completo
            </span>
            <span className="mt-0.5 block">
              Además de los clips, se conserva el video original en el servidor
              para poder descargarlo completo. Consume más espacio (un video de
              10 min puede pesar varios cientos de MB).
            </span>
          </span>
        </label>
      </section>

      {/* ---------------- Lista de videos ---------------- */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Film className="h-5 w-5 text-indigo-400" />
            Tus videos
          </h2>
          <button
            onClick={fetchVideos}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-indigo-500/40 hover:text-indigo-300"
          >
            <Loader2 className="h-3.5 w-3.5" />
            Actualizar
          </button>
        </div>

        {videos.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 py-16 text-center">
            <Film className="h-8 w-8 text-slate-600" />
            <p className="text-sm text-slate-500">
              Aún no has subido ningún video. ¡Arrastra uno arriba para comenzar!
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {videos.map((video) => (
              <article
                key={video.id}
                onClick={() => setSelectedId(video.id)}
                className={`group relative animate-fade-up cursor-pointer space-y-4 overflow-hidden rounded-2xl border p-5 backdrop-blur transition ${
                  selectedId === video.id
                    ? 'border-indigo-500/70 bg-indigo-500/[0.06] ring-1 ring-indigo-500/40'
                    : 'border-white/5 bg-white/[0.02] hover:-translate-y-0.5 hover:border-white/10 hover:bg-white/[0.04]'
                }`}
              >
                {/* Botón borrar */}
                <button
                  title="Eliminar video"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmTarget(video);
                  }}
                  className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-slate-900/80 text-slate-400 opacity-0 transition hover:border-rose-500/50 hover:text-rose-400 focus:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>

                {/* Botón descargar video completo */}
                {video.originalKey && (
                  <button
                    title="Descargar video completo"
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadFullVideo(video);
                    }}
                    disabled={downloadingId === video.id}
                    className="absolute right-12 top-3 z-10 grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-slate-900/80 text-slate-400 opacity-0 transition hover:border-emerald-500/50 hover:text-emerald-400 focus:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                  >
                    {downloadingId === video.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                  </button>
                )}

                <div className="flex items-start justify-between gap-2 pr-8">
                  <h3
                    className="flex-1 truncate text-sm font-semibold text-slate-200"
                    title={video.title}
                  >
                    {video.title}
                  </h3>
                  <StatusBadge status={video.status} />
                </div>

                <div className="flex items-center justify-between border-t border-white/5 pt-3 text-xs text-slate-400">
                  <span>
                    {new Date(video.createdAt).toLocaleDateString()}
                    {video.duration > 0 && (
                      <span className="ml-2 text-slate-500">
                        · {formatDuration(video.duration)}
                      </span>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1 font-medium text-indigo-300">
                    <Sparkles className="h-3.5 w-3.5" />
                    {video.clips?.length || 0} clips
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ---------------- Detalle del video ---------------- */}
      {selectedVideo && (
        <section className="animate-fade-up space-y-6 rounded-3xl border border-white/5 bg-white/[0.02] p-6 backdrop-blur sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-4">
            <div className="min-w-0">
              <h2 className="truncate text-xl font-bold text-slate-100">
                {selectedVideo.title}
              </h2>
              <p className="mt-1 truncate text-xs text-slate-500">
                ID: {selectedVideo.id}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={selectedVideo.status} />
              {selectedVideo.originalKey && (
                <button
                  onClick={() => downloadFullVideo(selectedVideo)}
                  disabled={downloadingId === selectedVideo.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  {downloadingId === selectedVideo.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  Descargar video completo
                </button>
              )}
              <button
                onClick={() => setConfirmTarget(selectedVideo)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Eliminar
              </button>
            </div>
          </div>

          {selectedVideo.sourceUrl && (
            <p className="mb-4 truncate text-xs text-slate-500">
              <span className="font-medium text-slate-400">Origen:</span>{' '}
              <a
                href={selectedVideo.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-400 underline-offset-2 hover:underline"
              >
                {selectedVideo.sourceUrl}
              </a>
            </p>
          )}

          <div>
            <h3 className="mb-4 flex items-center gap-2 text-md font-semibold text-slate-200">
              <Wand2 className="h-4 w-4 text-indigo-400" />
              Clips generados ({selectedVideo.clips?.length || 0})
            </h3>

            {!selectedVideo.clips || selectedVideo.clips.length === 0 ? (
              <div className="rounded-2xl border border-white/5 bg-slate-950/40 py-10 text-center">
                <p className="text-sm text-slate-500">
                  {selectedVideo.status === 'PROCESSING'
                    ? selectedVideo.phase === 'DURATION'
                      ? 'Midiendo la duración del video...'
                      : 'El worker está analizando audio y acción para generar clips...'
                    : selectedVideo.status === 'PENDING'
                    ? 'En cola de procesamiento...'
                    : selectedVideo.status === 'FAILED'
                    ? 'El procesamiento falló. Revisa los logs del worker.'
                    : 'No se encontraron clips para este video.'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {selectedVideo.clips.map((clip) => (
                  <div
                    key={clip.id}
                    className="flex flex-col justify-between space-y-3 rounded-2xl border border-white/5 bg-slate-950/50 p-4 transition hover:border-white/10"
                  >
                    <div>
                      <div className="mb-3 flex items-center justify-between text-xs">
                        <span className="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-slate-300">
                          {clip.format}
                        </span>
                        <span className="inline-flex items-center gap-1 font-semibold text-amber-400">
                          <TrendingUp className="h-3.5 w-3.5" />
                          {clip.score}
                        </span>
                      </div>
                      <p className="truncate text-sm font-medium text-slate-200">
                        {clip.title ||
                          `Clip ${clip.startTime}s – ${clip.endTime}s`}
                      </p>
                    </div>

                    <a
                      href={clip.clipUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 py-2 text-xs font-semibold text-white transition hover:from-indigo-500 hover:to-violet-500"
                    >
                      <Play className="h-3.5 w-3.5" />
                      Ver / Descargar
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ---------------- Modal de confirmación ---------------- */}
      {confirmTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => !deleting && setConfirmTarget(null)}
          />
          <div className="animate-fade-up relative w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
            <button
              onClick={() => !deleting && setConfirmTarget(null)}
              className="absolute right-4 top-4 text-slate-500 transition hover:text-slate-300"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-rose-500/10 text-rose-400">
              <AlertTriangle className="h-6 w-6" />
            </div>

            <h3 className="text-lg font-bold text-slate-100">Eliminar video</h3>
            <p className="mt-2 text-sm text-slate-400">
              Se eliminará{' '}
              <span className="font-semibold text-slate-200">
                “{confirmTarget.title}”
              </span>{' '}
              junto con sus clips y los archivos en S3. Esta acción no se puede
              deshacer.
            </p>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setConfirmTarget(null)}
                disabled={deleting}
                className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-white/10 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50"
              >
                {deleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Toast ---------------- */}
      {toast && (
        <div
          className={`animate-fade-up fixed bottom-6 right-6 z-[70] flex items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl ${
            toast.type === 'success'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          {toast.message}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Componentes auxiliares                                             */
/* ------------------------------------------------------------------ */

function StatCard({
  icon: Icon,
  label,
  value,
  spin = false,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: number;
  spin?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4 backdrop-blur">
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <Icon className={`h-3.5 w-3.5 text-indigo-400 ${spin ? 'animate-spin' : ''}`} />
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-slate-100">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: Video['status'] }) {
  switch (status) {
    case 'COMPLETED':
      return (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
          <CheckCircle2 className="h-3 w-3" /> Completado
        </span>
      );
    case 'PROCESSING':
      return (
        <span className="inline-flex shrink-0 animate-pulse items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-400">
          <Clock className="h-3 w-3" /> Procesando
        </span>
      );
    case 'FAILED':
      return (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-rose-500/20 bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium text-rose-400">
          <AlertCircle className="h-3 w-3" /> Fallido
        </span>
      );
    default:
      return (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-500/20 bg-slate-500/10 px-2.5 py-0.5 text-xs font-medium text-slate-400">
          <Clock className="h-3 w-3" /> En cola
        </span>
      );
  }
}
