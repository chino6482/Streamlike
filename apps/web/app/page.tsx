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
  Copy,
  Check,
  SlidersHorizontal,
  Type,
  LayoutTemplate,
  Info,
  ChevronDown,
  ShieldCheck,
  Radio,
  Square,
} from 'lucide-react';
import { ApiKeysSettings } from '@/components/ApiKeysSettings';
import {
  buildApiHeaders,
  readStoredGeminiKey,
  writeStoredGeminiKey,
} from '@/lib/api-headers';

type LayoutMode =
  | 'AUTO'
  | 'VERTICAL_CROP'
  | 'BLUR_FILL'
  | 'SPLIT'
  | 'SCREENCAST';
type HookStyle = 'pill' | 'banner' | 'minimal';
type HookPosition = 'top' | 'center' | 'bottom';

interface Clip {
  id: string;
  s3Key: string;
  clipUrl: string;
  startTime: number;
  endTime: number;
  score: number;
  format: 'VERTICAL' | 'HORIZONTAL';
  layoutMode?: LayoutMode;
  title?: string | null;
  viralScore?: number | null;
  hookReason?: string | null;
  transcript?: string | null;
  hookText?: string;
  hookStyle?: HookStyle;
  hookPosition?: HookPosition;
  why?: string | null;
  caption?: string;
}

interface Video {
  id: string;
  title: string;
  s3Key: string;
  duration: number;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  /** Fase informativa enviada por el worker (p. ej. "DURATION"). */
  phase?: string;
  errorMessage?: string | null;
  /** Enlace de origen (YouTube, TikTok, MP4 directo...). */
  sourceUrl?: string | null;
  /** Clave S3 del video completo guardado (si se conservó). */
  originalKey?: string | null;
  clipDuration?: number;
  layoutMode?: LayoutMode;
  topicHint?: string | null;
  isLiveCapture?: boolean;
  liveDurationMinutes?: number | null;
  liveStatus?: 'RECORDING' | 'STOPPED' | 'FINISHED' | null;
  liveRecordedSeconds?: number;
  liveFileSizeBytes?: number;
  createdAt: string;
  clips?: Clip[];
}

interface ToastMessage {
  type: 'success' | 'error';
  message: string;
}

const ENV_API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const API_BASE =
  typeof window !== 'undefined' &&
  (!ENV_API_URL ||
    window.location.origin === ENV_API_URL ||
    ((ENV_API_URL.includes('localhost') || ENV_API_URL.includes('127.0.0.1')) &&
      window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1'))
    ? ''
    : ENV_API_URL;
// Cabecera opcional de API key (solo si el backend exige API_KEY)
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;
const baseApiHeaders: Record<string, string> = buildApiHeaders({ apiKey: API_KEY });

const LAYOUT_LABELS: Record<LayoutMode, { label: string; hint: string }> = {
  AUTO: { label: 'Auto 9:16', hint: 'Recorte inteligente estándar' },
  VERTICAL_CROP: { label: 'Smart Crop', hint: 'Enfoque centrado 9:16' },
  BLUR_FILL: { label: 'Blur Fill', hint: 'Fondo difuminado + 16:9 nítido' },
  SPLIT: { label: 'Split (2x)', hint: '2 hablantes apilados (podcast)' },
  SCREENCAST: { label: 'Screencast', hint: 'Pantalla arriba + cámara abajo' },
};

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function isDirectPlayableUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('/upload/mock/') || url.includes('/clips/')) return true;
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
}

export default function Dashboard() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [linkUrl, setLinkUrl] = useState('');
  const [processingFromLink, setProcessingFromLink] = useState(false);
  /** Guardar también el video completo en el servidor (descargable). */
  const [keepOriginal, setKeepOriginal] = useState(true);
  /** Cookies opcionales en formato Netscape para enlaces de YouTube bloqueados por BotGuard (solo en memoria). */
  const [showAdvancedUrl, setShowAdvancedUrl] = useState(false);
  const [youtubeCookies, setYoutubeCookies] = useState('');

  /** Opciones inspiradas en OpenShorts: duración de clip, reencuadre y contexto */
  const [clipDuration, setClipDuration] = useState<number>(15);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('AUTO');
  const [autoReframe, setAutoReframe] = useState<boolean>(true);
  const [topicHint, setTopicHint] = useState('');

  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formatFilter, setFormatFilter] = useState<'ALL' | 'VERTICAL' | 'HORIZONTAL'>('ALL');
  const [enhancingAi, setEnhancingAi] = useState(false);
  const [copiedClipId, setCopiedClipId] = useState<string | null>(null);
  const [copiedTitleId, setCopiedTitleId] = useState<string | null>(null);
  const [expandedWhyId, setExpandedWhyId] = useState<string | null>(null);

  /** Modal de edición de clip / hook (estilo ClipEditor + HookModal de OpenShorts) */
  const [editingClip, setEditingClip] = useState<Clip | null>(null);
  const [savingClip, setSavingClip] = useState(false);
  const [clipRevision, setClipRevision] = useState<number>(0);

  const [confirmTarget, setConfirmTarget] = useState<Video | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [geminiApiKey, setGeminiApiKey] = useState('');

  /** Captura de transmisión en vivo (1 directo activo a la vez) */
  const [isLiveCapture, setIsLiveCapture] = useState<boolean>(false);
  const [liveDurationMinutes, setLiveDurationMinutes] = useState<number>(30);
  const [stoppingLiveId, setStoppingLiveId] = useState<string | null>(null);
  const [liveNowMs, setLiveNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    setGeminiApiKey(readStoredGeminiKey());
  }, []);

  const getRequestHeaders = useCallback(
    () =>
      buildApiHeaders({
        apiKey: API_KEY,
        geminiKey: readStoredGeminiKey() || geminiApiKey,
      }),
    [geminiApiKey],
  );

  const handleSaveGeminiKey = useCallback((nextKey: string) => {
    const persisted = writeStoredGeminiKey(nextKey);
    setGeminiApiKey(persisted);
  }, []);

  const videoList = useMemo(
    () => (Array.isArray(videos) ? videos : []),
    [videos],
  );

  const selectedVideo = useMemo(
    () => videoList.find((v) => v.id === selectedId) || null,
    [videoList, selectedId],
  );

  const filteredClips = useMemo(() => {
    const clips = Array.isArray(selectedVideo?.clips) ? selectedVideo.clips : [];
    if (formatFilter === 'ALL') return clips;
    return clips.filter((c) => c.format === formatFilter);
  }, [selectedVideo, formatFilter]);

  const hasActiveLive = useMemo(
    () =>
      videoList.some(
        (v) => v.isLiveCapture && v.liveStatus === 'RECORDING',
      ),
    [videoList],
  );

  const stats = useMemo(
    () => ({
      total: videoList.length,
      pending: videoList.filter(
        (v) => v.status === 'PENDING' || v.status === 'PROCESSING',
      ).length,
      completed: videoList.filter((v) => v.status === 'COMPLETED').length,
      clips: videoList.reduce((n, v) => n + (v.clips?.length || 0), 0),
    }),
    [videoList],
  );

  // Auto-ocultar el toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const fetchVideos = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE}/videos`, { headers: baseApiHeaders });
      if (Array.isArray(res.data)) {
        setVideos(res.data);
      } else {
        console.warn('Respuesta inesperada de /videos:', typeof res.data);
      }
    } catch (err) {
      console.warn('Error al cargar videos:', err);
    }
  }, []);

  useEffect(() => {
    fetchVideos();

    // Conexión Socket.io solo cuando hay backend externo configurado
    if (!API_BASE) return;

    const socket = io(API_BASE, { auth: { apiKey: API_KEY } });

    socket.on('connect', () => {
      console.log('Socket.io conectado al backend');
    });

    socket.on('video-status', (payload: any) => {
      setVideos((prev) =>
        (Array.isArray(prev) ? prev : []).map((v) =>
          v.id === payload.id
            ? {
                ...v,
                status: payload.status ?? v.status,
                phase: payload.phase ?? v.phase,
                ...(payload.liveStatus !== undefined
                  ? { liveStatus: payload.liveStatus }
                  : {}),
              }
            : v,
        ),
      );
      if (payload.status === 'COMPLETED' || payload.status === 'FAILED') {
        fetchVideos();
      }
    });

    socket.on('live:progress', (payload: any) => {
      if (!payload?.videoId) return;
      setVideos((prev) =>
        (Array.isArray(prev) ? prev : []).map((v) =>
          v.id === payload.videoId
            ? {
                ...v,
                liveRecordedSeconds:
                  typeof payload.recordedSeconds === 'number'
                    ? payload.recordedSeconds
                    : v.liveRecordedSeconds,
                liveFileSizeBytes:
                  typeof payload.fileSizeBytes === 'number'
                    ? payload.fileSizeBytes
                    : v.liveFileSizeBytes,
                ...(payload.liveStatus !== undefined
                  ? { liveStatus: payload.liveStatus }
                  : {}),
              }
            : v,
        ),
      );
    });

    return () => {
      socket.disconnect();
    };
  }, [fetchVideos]);

  // Refresco automático en modo local (sin Socket.IO) mientras haya videos procesándose
  useEffect(() => {
    if (API_BASE || stats.pending === 0) return;
    const interval = setInterval(() => {
      fetchVideos();
    }, 1000);
    return () => clearInterval(interval);
  }, [fetchVideos, stats.pending]);

  // Reloj 1s mientras exista una transmisión en vivo grabando (mm:ss fluido)
  useEffect(() => {
    if (!hasActiveLive) return;
    setLiveNowMs(Date.now());
    const timer = setInterval(() => setLiveNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActiveLive]);

  const formatLiveElapsed = useCallback(
    (video: Video): string => {
      const elapsedSec =
        typeof video.liveRecordedSeconds === 'number' &&
        video.liveRecordedSeconds > 0
          ? video.liveRecordedSeconds
          : Math.max(
              0,
              Math.floor(
                (liveNowMs - new Date(video.createdAt).getTime()) / 1000,
              ),
            );
      const mins = Math.floor(elapsedSec / 60);
      const secs = elapsedSec % 60;
      return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    },
    [liveNowMs],
  );

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;

      setUploading(true);
      setUploadProgress(0);

      try {
        const fileName = `${Date.now()}-${file.name.replace(/\s+/g, '_')}`;

        const reqHeaders = getRequestHeaders();

        // 1. Obtener URL prefirmada
        const presignRes = await axios.post(
          `${API_BASE}/upload/presign`,
          { fileName, contentType: file.type || 'video/mp4' },
          { headers: baseApiHeaders },
        );
        const { url } = presignRes.data;

        // 2. Subir directo a S3 / almacenamiento local
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

        // 3. Registrar el video en la API con la configuración de clipping y x-gemini-key
        const created = await axios.post(
          `${API_BASE}/videos`,
          {
            title: file.name,
            s3Key: fileName,
            duration: 0,
            keepOriginal,
            clipDuration,
            layoutMode,
            autoReframe,
            topicHint: topicHint.trim() || undefined,
          },
          { headers: reqHeaders },
        );

        await fetchVideos();
        if (created.data?.id) setSelectedId(created.data.id);
        setToast({ type: 'success', message: 'Video subido y en cola de análisis' });
      } catch (err: any) {
        console.warn('Error durante la subida:', err?.response?.data?.message || err?.message);
        setToast({
          type: 'error',
          message:
            err?.response?.data?.message ||
            'Error al subir el video. Verifica que los servicios estén activos.',
        });
      } finally {
        setUploading(false);
        setUploadProgress(0);
      }
    },
    [fetchVideos, keepOriginal, clipDuration, layoutMode, autoReframe, topicHint, getRequestHeaders],
  );

  const confirmDelete = useCallback(async () => {
    if (!confirmTarget) return;
    const id = confirmTarget.id;
    setDeleting(true);
    try {
      await axios.delete(`${API_BASE}/videos/${id}`, { headers: baseApiHeaders });
      setVideos((prev) =>
        (Array.isArray(prev) ? prev : []).filter((v) => v.id !== id),
      );
      setSelectedId((cur) => (cur === id ? null : cur));
      setToast({ type: 'success', message: 'Video y clips eliminados' });
      setConfirmTarget(null);
    } catch (err: any) {
      console.warn('Error al eliminar el video:', err?.response?.data?.message || err?.message);
      setToast({ type: 'error', message: 'No se pudo eliminar el video' });
    } finally {
      setDeleting(false);
    }
  }, [confirmTarget]);

  const processFromUrl = useCallback(async () => {
    let url = linkUrl.trim();
    if (!url) {
      setToast({ type: 'error', message: 'Pega un enlace de video para procesar' });
      return;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && /^[^\s/]+\.[^\s/]+/.test(url)) {
      url = `https://${url}`;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setToast({ type: 'error', message: 'Solo se permiten enlaces http:// o https://' });
        return;
      }
    } catch {
      setToast({ type: 'error', message: 'Formato de URL inválido. Ejemplo: https://www.tiktok.com/...' });
      return;
    }

    setProcessingFromLink(true);
    try {
      const res = await axios.post(
        `${API_BASE}/videos`,
        {
          title: isLiveCapture
            ? `live-${Date.now()}.mp4`
            : `video-${Date.now()}.mp4`,
          s3Key: url,
          duration: 0,
          sourceUrl: url,
          keepOriginal,
          clipDuration,
          layoutMode,
          autoReframe,
          topicHint: topicHint.trim() || undefined,
          isLiveCapture,
          ...(isLiveCapture ? { liveDurationMinutes } : {}),
          youtubeCookies: youtubeCookies.trim() || undefined,
        },
        { headers: getRequestHeaders() },
      );
      setToast({
        type: 'success',
        message: isLiveCapture
          ? 'Captura en vivo iniciada. Puedes detenerla cuando quieras para extraer los clips.'
          : 'Video en cola desde el enlace',
      });
      setLinkUrl('');
      if (res.data?.id) setSelectedId(res.data.id);
      await fetchVideos();
    } catch (err: any) {
      console.warn('No se pudo encolar el enlace:', err?.response?.data?.message || err?.message);
      setToast({
        type: 'error',
        message:
          err?.response?.data?.message ||
          'No se pudo procesar el video desde el enlace',
      });
    } finally {
      setProcessingFromLink(false);
    }
  }, [
    fetchVideos,
    linkUrl,
    keepOriginal,
    clipDuration,
    layoutMode,
    autoReframe,
    topicHint,
    isLiveCapture,
    liveDurationMinutes,
    youtubeCookies,
    getRequestHeaders,
  ]);

  const stopLiveCapture = useCallback(
    async (video: Video) => {
      setStoppingLiveId(video.id);
      try {
        await axios.post(
          `${API_BASE}/videos/${video.id}/stop-live`,
          {},
          { headers: baseApiHeaders },
        );
        setVideos((prev) =>
          (Array.isArray(prev) ? prev : []).map((v) =>
            v.id === video.id
              ? { ...v, liveStatus: 'STOPPED', phase: 'ANALYZING' }
              : v,
          ),
        );
        setToast({
          type: 'success',
          message: 'Captura detenida. Generando clips con IA...',
        });
        await fetchVideos();
      } catch (err: any) {
        console.warn('No se pudo detener la captura en vivo:', err?.response?.data?.message || err?.message);
        setToast({
          type: 'error',
          message:
            err?.response?.data?.message ||
            'No se pudo detener la captura en vivo',
        });
      } finally {
        setStoppingLiveId((cur) => (cur === video.id ? null : cur));
      }
    },
    [fetchVideos],
  );

  const downloadFullVideo = useCallback(async (video: Video) => {
    setDownloadingId(video.id);
    try {
      const res = await axios.get(`${API_BASE}/videos/${video.id}/download`, {
        headers: baseApiHeaders,
      });
      const { url, filename } = res.data;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'video.mp4';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setToast({ type: 'success', message: 'Descarga del video completo iniciada' });
    } catch (err: any) {
      console.warn('Error al descargar el video completo:', err?.response?.data?.message || err?.message);
      setToast({
        type: 'error',
        message:
          err?.response?.data?.message ||
          'No se pudo descargar el video completo',
      });
    } finally {
      setDownloadingId(null);
    }
  }, []);

  /**
   * Genera títulos virales, hooks de apertura, explicación de retención y copy
   * social usando Gemini en el servidor (/api/ai/enhance-clips).
   */
  const enhanceWithAi = useCallback(async (video: Video) => {
    setEnhancingAi(true);
    try {
      const res = await axios.post(
        '/api/ai/enhance-clips',
        {
          videoId: video.id,
          topicHint: video.topicHint || topicHint.trim() || undefined,
        },
        { headers: getRequestHeaders() },
      );
      if (res.data && typeof res.data === 'object' && res.data.id) {
        setVideos((prev) =>
          (Array.isArray(prev) ? prev : []).map((v) =>
            v.id === video.id ? res.data : v,
          ),
        );
      }
      setToast({
        type: 'success',
        message: 'Hooks, títulos y copy viral generados con IA',
      });
    } catch (err: any) {
      console.warn('Error al enriquecer clips con IA:', err?.response?.data?.message || err?.message);
      setToast({
        type: 'error',
        message:
          err?.response?.data?.message ||
          'Error al generar metadatos con IA.',
      });
    } finally {
      setEnhancingAi(false);
    }
  }, [topicHint, getRequestHeaders]);

  const saveClipEdits = useCallback(async () => {
    if (!selectedVideo || !editingClip) return;
    setSavingClip(true);
    try {
      const res = await axios.patch(
        `${API_BASE}/videos/${selectedVideo.id}/clips/${editingClip.id}`,
        {
          startTime: editingClip.startTime,
          endTime: editingClip.endTime,
          title: editingClip.title,
          hookText: editingClip.hookText,
          hookStyle: editingClip.hookStyle,
          hookPosition: editingClip.hookPosition,
          layoutMode: editingClip.layoutMode,
          caption: editingClip.caption,
        },
        { headers: baseApiHeaders },
      );
      const updatedClip: Clip = res.data;
      if (updatedClip && updatedClip.id) {
        setVideos((prev) =>
          (Array.isArray(prev) ? prev : []).map((v) =>
            v.id === selectedVideo.id
              ? {
                  ...v,
                  clips: (v.clips || []).map((c) =>
                    c.id === updatedClip.id ? updatedClip : c,
                  ),
                }
              : v,
          ),
        );
      }
      setEditingClip(null);
      setClipRevision((n) => n + 1);
      setToast({ type: 'success', message: 'Clip re-cortado y guardado' });
    } catch (err: any) {
      console.warn('Error al guardar clip:', err?.response?.data?.message || err?.message);
      setToast({
        type: 'error',
        message:
          err?.response?.data?.message || 'No se pudieron guardar los cambios',
      });
    } finally {
      setSavingClip(false);
    }
  }, [selectedVideo, editingClip]);

  const writeClipboardWithFallback = useCallback(async (text: string) => {
    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        /* fallback a textarea si el iframe o contexto HTTP bloquea Clipboard API */
      }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (!ok) {
      throw new Error('Clipboard copy failed');
    }
  }, []);

  const copySocialKit = useCallback(async (clip: Clip) => {
    const text = [
      clip.title,
      clip.hookText ? `Hook: ${clip.hookText}` : '',
      clip.caption,
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      await writeClipboardWithFallback(text || `Clip ${clip.startTime}s-${clip.endTime}s`);
      setCopiedClipId(clip.id);
      setTimeout(() => setCopiedClipId((cur) => (cur === clip.id ? null : cur)), 2000);
      setToast({ type: 'success', message: 'Título y copy copiados al portapapeles' });
    } catch {
      setToast({ type: 'error', message: 'No se pudo copiar al portapapeles' });
    }
  }, [writeClipboardWithFallback]);

  const copyClipTitle = useCallback(async (clip: Clip) => {
    const titleText =
      clip.title?.trim() || `Clip ${clip.startTime}s – ${clip.endTime}s`;
    try {
      await writeClipboardWithFallback(titleText);
      setCopiedTitleId(clip.id);
      setTimeout(() => setCopiedTitleId((cur) => (cur === clip.id ? null : cur)), 2000);
      setToast({ type: 'success', message: 'Título copiado al portapapeles' });
    } catch {
      setToast({ type: 'error', message: 'No se pudo copiar el título' });
    }
  }, [writeClipboardWithFallback]);

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
          Análisis automático de momentos destacados + Hook Studio
        </span>
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
          Convierte videos largos en{' '}
          <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400 bg-clip-text text-transparent">
            clips virales
          </span>
        </h1>
        <p className="mx-auto max-w-2xl text-sm text-slate-400 sm:text-base">
          Detecta los momentos de mayor energía (audio, habla y acción), reencuadra
          automáticamente en 9:16 (Smart Crop, Split o Blur Fill) y edita hooks de
          apertura listos para TikTok, Reels y Shorts.
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

      {/* ---------------- Configuración de API Keys ---------------- */}
      <ApiKeysSettings
        savedKey={geminiApiKey}
        onSaveKey={handleSaveGeminiKey}
        onNotify={setToast}
      />

      {/* ---------------- Configuración de Clipping (OpenShorts style) ---------------- */}
      <section className="animate-fade-up rounded-3xl border border-white/5 bg-white/[0.02] p-6 backdrop-blur sm:p-8">
        <div className="mb-5 flex items-center gap-2 text-sm font-bold text-slate-200">
          <SlidersHorizontal className="h-4 w-4 text-indigo-400" />
          Configuración de generación de clips
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Duración objetivo */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-slate-400">
              Duración objetivo por clip
            </label>
            <div className="grid grid-cols-4 gap-2">
              {[15, 30, 45, 60].map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => setClipDuration(sec)}
                  className={`rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                    clipDuration === sec
                      ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200'
                      : 'border-white/10 bg-slate-950/50 text-slate-400 hover:border-white/20 hover:text-slate-200'
                  }`}
                >
                  {sec}s
                </button>
              ))}
            </div>
          </div>

          {/* Encuadre 9:16 */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-slate-400">
              Modo de reencuadre 9:16
            </label>
            <select
              value={layoutMode}
              onChange={(e) => setLayoutMode(e.target.value as LayoutMode)}
              className="w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-xs font-medium text-slate-200 outline-none transition focus:border-indigo-500/60"
            >
              {(Object.keys(LAYOUT_LABELS) as LayoutMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {LAYOUT_LABELS[mode].label} — {LAYOUT_LABELS[mode].hint}
                </option>
              ))}
            </select>
          </div>

          {/* Contexto opcional */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-slate-400">
              Contexto / temática (opcional para IA)
            </label>
            <input
              type="text"
              value={topicHint}
              onChange={(e) => setTopicHint(e.target.value)}
              placeholder="Ej: Podcast de startups, momentos polémicos"
              className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 outline-none transition focus:border-indigo-500/60"
            />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/5 bg-slate-950/40 px-4 py-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <span>Auto-Reframe Facial (9:16)</span>
              <span
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                  autoReframe
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {autoReframe ? 'Activo' : 'Desactivado'}
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Centra dinámicamente al hablante activo en 9:16; si no hay personas en escena, mantiene el encuadre seleccionado.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoReframe}
            aria-label="Auto-Reframe Facial (9:16)"
            onClick={() => setAutoReframe((prev) => !prev)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition ${
              autoReframe
                ? 'border-indigo-500 bg-indigo-600'
                : 'border-white/15 bg-slate-800'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                autoReframe ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
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
          Pega un enlace público (YouTube, TikTok o un MP4 directo; validado contra
          SSRF) y el pipeline generará los clips automáticamente.
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
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-white transition disabled:opacity-50 ${
              isLiveCapture
                ? 'bg-gradient-to-r from-rose-600 to-amber-600 hover:from-rose-500 hover:to-amber-500'
                : 'bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500'
            }`}
          >
            {processingFromLink ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isLiveCapture ? (
              <Radio className="h-4 w-4" />
            ) : (
              <Wand2 className="h-4 w-4" />
            )}
            {isLiveCapture ? 'Iniciar captura Live' : 'Procesar'}
          </button>
        </div>

        {/* Modo Transmisión en Vivo (Live) */}
        <div className="mt-4 space-y-3 rounded-2xl border border-white/5 bg-slate-950/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Radio
                  className={`h-3.5 w-3.5 ${
                    isLiveCapture ? 'animate-pulse text-rose-400' : 'text-slate-400'
                  }`}
                />
                <span>Modo Transmisión en Vivo (Live)</span>
                {isLiveCapture && (
                  <span className="rounded-md bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold text-rose-300">
                    LIVE
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400">
                Soporta YouTube Live, Twitch, Kick y TikTok Live (1 directo activo a la vez)
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isLiveCapture}
              aria-label="Modo Transmisión en Vivo (Live)"
              onClick={() => setIsLiveCapture((prev) => !prev)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition ${
                isLiveCapture
                  ? 'border-rose-500 bg-rose-600'
                  : 'border-white/15 bg-slate-800'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                  isLiveCapture ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-3">
            <label className="text-xs font-medium text-slate-400">
              Duración máxima de captura
            </label>
            <div className="grid grid-cols-4 gap-2">
              {[15, 30, 60, 120].map((mins) => (
                <button
                  key={mins}
                  type="button"
                  onClick={() => {
                    setLiveDurationMinutes(mins);
                    if (!isLiveCapture) setIsLiveCapture(true);
                  }}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                    liveDurationMinutes === mins && isLiveCapture
                      ? 'border-rose-500 bg-rose-500/20 text-rose-200'
                      : liveDurationMinutes === mins
                      ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200'
                      : 'border-white/10 bg-slate-900/60 text-slate-400 hover:border-white/20 hover:text-slate-200'
                  }`}
                >
                  {mins} min
                </button>
              ))}
            </div>
          </div>

          {hasActiveLive && isLiveCapture && (
            <p className="text-[11px] font-medium text-amber-300">
              Ya hay una transmisión en vivo capturándose. Detén el directo activo antes de iniciar otro.
            </p>
          )}
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
              para poder descargarlo completo.
            </span>
          </span>
        </label>

        {/* Opciones avanzadas: Cookies de YouTube (opcional) */}
        <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.01]">
          <button
            type="button"
            onClick={() => setShowAdvancedUrl((prev) => !prev)}
            className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium text-slate-400 transition hover:text-slate-200"
          >
            <span className="inline-flex items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5 text-indigo-400" />
              Opciones avanzadas: Cookies de YouTube (opcional)
              {youtubeCookies.trim() && (
                <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                  Cargadas
                </span>
              )}
            </span>
            <ChevronDown
              className={`h-4 w-4 transition-transform ${
                showAdvancedUrl ? 'rotate-180' : ''
              }`}
            />
          </button>

          {showAdvancedUrl && (
            <div className="space-y-3 border-t border-white/5 p-3.5 text-xs text-slate-400">
              <p className="leading-relaxed">
                Si YouTube muestra{' '}
                <span className="font-mono text-slate-300">
                  “Sign in to confirm you’re not a bot”
                </span>{' '}
                desde la IP del servidor, exporta tus cookies de{' '}
                <span className="text-slate-300">youtube.com</span> en formato
                Netscape (<span className="font-mono">cookies.txt</span>) y
                pégalas o cárgalas aquí. Se usan solo para esta descarga y se
                eliminan de inmediato.
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 font-medium text-slate-200 transition hover:border-indigo-500/40 hover:text-indigo-300">
                  <Upload className="h-3.5 w-3.5" />
                  Cargar cookies.txt
                  <input
                    type="file"
                    accept=".txt,text/plain"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      try {
                        const text = await f.text();
                        setYoutubeCookies(text);
                        setToast({
                          type: 'success',
                          message: 'Cookies cargadas en memoria para la descarga',
                        });
                      } catch {
                        setToast({
                          type: 'error',
                          message: 'No se pudo leer el archivo de cookies',
                        });
                      } finally {
                        e.target.value = '';
                      }
                    }}
                  />
                </label>

                {youtubeCookies.trim() && (
                  <button
                    type="button"
                    onClick={() => setYoutubeCookies('')}
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-rose-300 transition hover:bg-rose-500/20"
                  >
                    <X className="h-3.5 w-3.5" />
                    Limpiar
                  </button>
                )}
              </div>

              <textarea
                rows={3}
                value={youtubeCookies}
                onChange={(e) => setYoutubeCookies(e.target.value)}
                placeholder="# Netscape HTTP Cookie File&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE&#9;..."
                spellCheck={false}
                className="w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500/60"
              />
            </div>
          )}
        </div>
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

        {videoList.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 py-16 text-center">
            <Film className="h-8 w-8 text-slate-600" />
            <p className="text-sm text-slate-500">
              Aún no has subido ningún video. ¡Arrastra uno arriba para comenzar!
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {videoList.map((video) => (
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
                  {video.isLiveCapture && video.liveStatus === 'RECORDING' ? (
                    <span className="inline-flex shrink-0 animate-pulse items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/15 px-2.5 py-0.5 text-[11px] font-bold text-rose-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
                      EN VIVO • Grabando ({formatLiveElapsed(video)})
                    </span>
                  ) : (
                    <StatusBadge status={video.status} />
                  )}
                </div>

                {video.isLiveCapture && video.liveStatus === 'RECORDING' && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/20 bg-rose-500/[0.06] px-3 py-2">
                    <span className="text-[11px] text-rose-200">
                      Límite {video.liveDurationMinutes || 30} min
                      {typeof video.liveFileSizeBytes === 'number' &&
                      video.liveFileSizeBytes > 0
                        ? ` · ${(video.liveFileSizeBytes / (1024 * 1024)).toFixed(1)} MB`
                        : ''}
                    </span>
                    <button
                      type="button"
                      disabled={stoppingLiveId === video.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        stopLiveCapture(video);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50"
                    >
                      {stoppingLiveId === video.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Square className="h-3 w-3 fill-current" />
                      )}
                      Detener y extraer clips ahora
                    </button>
                  </div>
                )}

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

      {/* ---------------- Detalle del video (Clip Studio) ---------------- */}
      {selectedVideo && (
        <section className="animate-fade-up space-y-6 rounded-3xl border border-white/5 bg-white/[0.02] p-6 backdrop-blur sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-4">
            <div className="min-w-0">
              <h2 className="truncate text-xl font-bold text-slate-100">
                {selectedVideo.title}
              </h2>
              <p className="mt-1 truncate text-xs text-slate-500">
                ID: {selectedVideo.id}
                {selectedVideo.layoutMode && (
                  <span className="ml-2 text-indigo-300">
                    · {LAYOUT_LABELS[selectedVideo.layoutMode]?.label || selectedVideo.layoutMode}
                  </span>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {selectedVideo.isLiveCapture &&
              selectedVideo.liveStatus === 'RECORDING' ? (
                <>
                  <span className="inline-flex shrink-0 animate-pulse items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/15 px-2.5 py-0.5 text-xs font-bold text-rose-300">
                    <span className="h-2 w-2 rounded-full bg-rose-400" />
                    EN VIVO • Grabando ({formatLiveElapsed(selectedVideo)})
                  </span>
                  <button
                    type="button"
                    disabled={stoppingLiveId === selectedVideo.id}
                    onClick={() => stopLiveCapture(selectedVideo)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50"
                  >
                    {stoppingLiveId === selectedVideo.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Square className="h-3.5 w-3.5 fill-current" />
                    )}
                    Detener y extraer clips ahora
                  </button>
                </>
              ) : (
                <StatusBadge status={selectedVideo.status} />
              )}
              {selectedVideo.clips && selectedVideo.clips.length > 0 && (
                <button
                  onClick={() => enhanceWithAi(selectedVideo)}
                  disabled={enhancingAi}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1.5 text-xs font-semibold text-fuchsia-300 transition hover:bg-fuchsia-500/20 disabled:opacity-50"
                >
                  {enhancingAi ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  Generar Hooks y Copy IA
                </button>
              )}
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
            <p className="truncate text-xs text-slate-500">
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
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-md font-semibold text-slate-200">
                <Wand2 className="h-4 w-4 text-indigo-400" />
                Clips generados ({filteredClips.length})
              </h3>

              {/* Filtros de formato */}
              {selectedVideo.clips && selectedVideo.clips.length > 0 && (
                <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-slate-950/60 p-1 text-xs">
                  {(
                    [
                      { key: 'ALL', label: 'Todos' },
                      { key: 'VERTICAL', label: 'Vertical 9:16' },
                      { key: 'HORIZONTAL', label: 'Horizontal 16:9' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setFormatFilter(tab.key)}
                      className={`rounded-lg px-2.5 py-1 font-medium transition ${
                        formatFilter === tab.key
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {!selectedVideo.clips || selectedVideo.clips.length === 0 ? (
              <div
                className={`rounded-2xl border px-5 py-8 text-center ${
                  selectedVideo.status === 'FAILED'
                    ? 'border-rose-500/30 bg-rose-500/5'
                    : 'border-white/5 bg-slate-950/40'
                }`}
              >
                {selectedVideo.status === 'FAILED' ? (
                  <div className="mx-auto max-w-xl space-y-3">
                    <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-rose-500/15 text-rose-400">
                      <AlertCircle className="h-5 w-5" />
                    </div>
                    <p className="whitespace-pre-line text-sm text-rose-200">
                      {selectedVideo.errorMessage ||
                        'El procesamiento falló. Verifica la URL o el archivo de video.'}
                    </p>
                    {selectedVideo.errorMessage &&
                      /cookies|bot/i.test(selectedVideo.errorMessage) && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowAdvancedUrl(true);
                            if (selectedVideo.sourceUrl) {
                              setLinkUrl(selectedVideo.sourceUrl);
                            }
                            window.scrollTo({ top: 320, behavior: 'smooth' });
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/15 px-3.5 py-1.5 text-xs font-semibold text-indigo-200 transition hover:bg-indigo-500/25"
                        >
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Pegar cookies de YouTube y reintentar
                        </button>
                      )}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">
                    {selectedVideo.isLiveCapture &&
                    selectedVideo.liveStatus === 'RECORDING'
                      ? `Grabando transmisión en vivo (${formatLiveElapsed(selectedVideo)})... Puedes detener la captura cuando quieras para analizar con Gemini y generar los clips.`
                      : selectedVideo.status === 'PROCESSING'
                      ? selectedVideo.phase === 'LIVE_RECORDING'
                        ? 'Capturando transmisión en vivo...'
                        : selectedVideo.phase === 'DOWNLOADING'
                        ? 'Descargando el video desde la URL de origen...'
                        : selectedVideo.phase === 'DURATION'
                        ? 'Midiendo la duración real del video con ffprobe...'
                        : selectedVideo.phase === 'ANALYZING'
                        ? 'Analizando momentos virales y sonoridad...'
                        : selectedVideo.phase === 'CUTTING'
                        ? 'Cortando y reencuadrando los clips MP4 con FFmpeg...'
                        : 'Procesando video con FFmpeg...'
                      : selectedVideo.status === 'PENDING'
                      ? 'En cola de procesamiento...'
                      : 'No se encontraron clips para este video.'}
                  </p>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredClips.map((clip) => (
                  <article
                    key={clip.id}
                    className="flex flex-col justify-between space-y-3 rounded-2xl border border-white/5 bg-slate-950/50 p-4 transition hover:border-white/10"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-slate-300">
                            {clip.format}
                          </span>
                          {clip.layoutMode && clip.format === 'VERTICAL' && (
                            <span className="rounded-md bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">
                              {LAYOUT_LABELS[clip.layoutMode]?.label || clip.layoutMode}
                            </span>
                          )}
                        </div>
                        {(() => {
                          const scoreValue = clip.viralScore ?? clip.score;
                          const badgeStyle =
                            scoreValue >= 85
                              ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                              : scoreValue >= 65
                              ? 'border-amber-500/30 bg-amber-500/15 text-amber-300'
                              : 'border-slate-500/30 bg-slate-500/15 text-slate-300';
                          return (
                            <span
                              title="Puntuación de viralidad IA"
                              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${badgeStyle}`}
                            >
                              <TrendingUp className="h-3 w-3" />
                              Viral {scoreValue}/100
                            </span>
                          );
                        })()}
                      </div>

                      {/* Vista previa del clip cortado + Hook Overlay en vivo */}
                      <div className="relative overflow-hidden rounded-xl border border-white/5 bg-black/60">
                        {isDirectPlayableUrl(clip.clipUrl) ? (
                          <video
                            src={
                              clip.clipUrl.includes('/clips/')
                                ? `${clip.clipUrl}?v=${clipRevision}`
                                : `${clip.clipUrl}#t=${clip.startTime},${clip.endTime}`
                            }
                            controls
                            preload="metadata"
                            className={`w-full object-cover ${
                              clip.format === 'VERTICAL' ? 'aspect-[9/16] max-h-64' : 'aspect-video'
                            }`}
                          />
                        ) : (
                          <div
                            className={`flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-900 to-indigo-950/40 p-4 text-center ${
                              clip.format === 'VERTICAL' ? 'h-48' : 'h-36'
                            }`}
                          >
                            <Scissors className="h-6 w-6 text-indigo-400" />
                            <span className="text-xs text-slate-400">
                              Segmento {formatDuration(clip.startTime)} – {formatDuration(clip.endTime)}
                            </span>
                          </div>
                        )}

                        {clip.hookText && (
                          <HookOverlayPreview
                            text={clip.hookText}
                            style={clip.hookStyle || 'pill'}
                            position={clip.hookPosition || 'top'}
                          />
                        )}
                      </div>

                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <p className="line-clamp-2 flex-1 text-sm font-semibold text-slate-100">
                            {clip.title || `Clip ${clip.startTime}s – ${clip.endTime}s`}
                          </p>
                          <button
                            type="button"
                            onClick={() => copyClipTitle(clip)}
                            title="Copiar título sugerido"
                            aria-label="Copiar título sugerido"
                            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-300 transition hover:border-indigo-500/40 hover:text-indigo-300"
                          >
                            {copiedTitleId === clip.id ? (
                              <>
                                <Check className="h-3 w-3 text-emerald-400" />
                                <span className="text-emerald-300">Copiado</span>
                              </>
                            ) : (
                              <>
                                <Copy className="h-3 w-3" />
                                <span>Título</span>
                              </>
                            )}
                          </button>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {formatDuration(clip.startTime)} – {formatDuration(clip.endTime)} ·{' '}
                          {Math.max(1, clip.endTime - clip.startTime)}s
                        </p>
                      </div>

                      {/* Hook reason desplegable */}
                      {(clip.hookReason || clip.why) && (
                        <div className="rounded-xl border border-white/5 bg-white/[0.02] text-xs text-slate-400">
                          <button
                            type="button"
                            aria-expanded={expandedWhyId === clip.id}
                            onClick={() =>
                              setExpandedWhyId((cur) => (cur === clip.id ? null : clip.id))
                            }
                            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:text-slate-200"
                          >
                            <span className="inline-flex items-center gap-1.5 font-medium text-slate-300">
                              <Info className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                              Por qué retiene audiencia
                            </span>
                            <ChevronDown
                              className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${
                                expandedWhyId === clip.id ? 'rotate-180' : ''
                              }`}
                            />
                          </button>
                          {expandedWhyId === clip.id && (
                            <p className="border-t border-white/5 px-3 py-2 leading-relaxed text-slate-300">
                              {clip.hookReason || clip.why}
                            </p>
                          )}
                        </div>
                      )}

                      {clip.caption && (
                        <p className="line-clamp-2 text-xs text-slate-400">
                          {clip.caption}
                        </p>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() =>
                          setEditingClip({
                            ...clip,
                            hookStyle: clip.hookStyle || 'pill',
                            hookPosition: clip.hookPosition || 'top',
                            layoutMode: clip.layoutMode || 'AUTO',
                          })
                        }
                        className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 py-2 text-xs font-medium text-slate-200 transition hover:border-indigo-500/40 hover:text-indigo-300"
                      >
                        <Type className="h-3.5 w-3.5" />
                        Editar
                      </button>

                      <button
                        type="button"
                        onClick={() => copySocialKit(clip)}
                        className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 py-2 text-xs font-medium text-slate-200 transition hover:border-emerald-500/40 hover:text-emerald-300"
                      >
                        {copiedClipId === clip.id ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        Copy
                      </button>

                      <a
                        href={
                          clip.clipUrl.includes('/clips/')
                            ? `${clip.clipUrl}?download=1`
                            : clip.clipUrl
                        }
                        download={`${(clip.title || 'clip').replace(/[^\w.\-]+/g, '_')}.mp4`}
                        className="inline-flex items-center justify-center gap-1 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 py-2 text-xs font-semibold text-white transition hover:from-indigo-500 hover:to-violet-500"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Descargar
                      </a>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ---------------- Modal Clip Editor & Hook Studio ---------------- */}
      {editingClip && selectedVideo && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/75 backdrop-blur-sm"
            onClick={() => !savingClip && setEditingClip(null)}
          />
          <div className="animate-fade-up relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
            <button
              onClick={() => !savingClip && setEditingClip(null)}
              className="absolute right-4 top-4 text-slate-500 transition hover:text-slate-300"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="mb-5 flex items-center gap-2">
              <LayoutTemplate className="h-5 w-5 text-indigo-400" />
              <h3 className="text-lg font-bold text-slate-100">
                Editor de Clip & Hook Studio
              </h3>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {/* Vista previa en vivo */}
              <div className="space-y-3">
                <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black">
                  {isDirectPlayableUrl(editingClip.clipUrl) ? (
                    <video
                      src={
                        editingClip.clipUrl.includes('/clips/')
                          ? `${editingClip.clipUrl}?v=${clipRevision}`
                          : `${editingClip.clipUrl}#t=${editingClip.startTime},${editingClip.endTime}`
                      }
                      controls
                      className="aspect-[9/16] max-h-80 w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-72 flex-col items-center justify-center gap-2 bg-slate-950 p-4 text-center">
                      <Scissors className="h-7 w-7 text-indigo-400" />
                      <span className="text-xs text-slate-400">
                        Vista previa ({formatDuration(editingClip.startTime)} –{' '}
                        {formatDuration(editingClip.endTime)})
                      </span>
                    </div>
                  )}
                  {editingClip.hookText && (
                    <HookOverlayPreview
                      text={editingClip.hookText}
                      style={editingClip.hookStyle || 'pill'}
                      position={editingClip.hookPosition || 'top'}
                    />
                  )}
                </div>

                {/* Controles de recorte temporal */}
                <div className="grid grid-cols-2 gap-3 rounded-xl border border-white/5 bg-slate-950/60 p-3">
                  <div>
                    <label className="block text-[11px] text-slate-400">
                      Inicio (seg)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={Math.max(0, (selectedVideo.duration || 600) - 3)}
                      value={editingClip.startTime}
                      onChange={(e) => {
                        const val = Math.max(0, Number(e.target.value) || 0);
                        setEditingClip((cur) =>
                          cur
                            ? {
                                ...cur,
                                startTime: val,
                                endTime: Math.max(val + 3, cur.endTime),
                              }
                            : null,
                        );
                      }}
                      className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400">
                      Fin (seg)
                    </label>
                    <input
                      type="number"
                      min={editingClip.startTime + 3}
                      max={selectedVideo.duration || 600}
                      value={editingClip.endTime}
                      onChange={(e) => {
                        const val = Math.max(
                          editingClip.startTime + 3,
                          Number(e.target.value) || editingClip.startTime + 3,
                        );
                        setEditingClip((cur) =>
                          cur ? { ...cur, endTime: val } : null,
                        );
                      }}
                      className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
              </div>

              {/* Campos de edición */}
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400">
                    Título viral del clip
                  </label>
                  <input
                    type="text"
                    value={editingClip.title || ''}
                    onChange={(e) =>
                      setEditingClip((cur) =>
                        cur ? { ...cur, title: e.target.value } : null,
                      )
                    }
                    className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-xs text-slate-100 outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400">
                    Hook de apertura (overlay en los primeros segundos)
                  </label>
                  <input
                    type="text"
                    value={editingClip.hookText || ''}
                    placeholder="Ej: El error #1 que nadie te cuenta..."
                    onChange={(e) =>
                      setEditingClip((cur) =>
                        cur ? { ...cur, hookText: e.target.value } : null,
                      )
                    }
                    className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-xs text-slate-100 outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-400">
                      Estilo de Hook
                    </label>
                    <select
                      value={editingClip.hookStyle || 'pill'}
                      onChange={(e) =>
                        setEditingClip((cur) =>
                          cur
                            ? { ...cur, hookStyle: e.target.value as HookStyle }
                            : null,
                        )
                      }
                      className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/70 px-2.5 py-2 text-xs text-slate-200 outline-none"
                    >
                      <option value="pill">Pill Blanco/Oscuro</option>
                      <option value="banner">Banner Neón</option>
                      <option value="minimal">Minimalista</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400">
                      Posición
                    </label>
                    <select
                      value={editingClip.hookPosition || 'top'}
                      onChange={(e) =>
                        setEditingClip((cur) =>
                          cur
                            ? {
                                ...cur,
                                hookPosition: e.target.value as HookPosition,
                              }
                            : null,
                        )
                      }
                      className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/70 px-2.5 py-2 text-xs text-slate-200 outline-none"
                    >
                      <option value="top">Arriba</option>
                      <option value="center">Centro</option>
                      <option value="bottom">Abajo</option>
                    </select>
                  </div>
                </div>

                {editingClip.format === 'VERTICAL' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-400">
                      Encuadre 9:16
                    </label>
                    <select
                      value={editingClip.layoutMode || 'AUTO'}
                      onChange={(e) =>
                        setEditingClip((cur) =>
                          cur
                            ? { ...cur, layoutMode: e.target.value as LayoutMode }
                            : null,
                        )
                      }
                      className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/70 px-2.5 py-2 text-xs text-slate-200 outline-none"
                    >
                      {(Object.keys(LAYOUT_LABELS) as LayoutMode[]).map((mode) => (
                        <option key={mode} value={mode}>
                          {LAYOUT_LABELS[mode].label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-slate-400">
                    Copy / Descripción social
                  </label>
                  <textarea
                    rows={3}
                    value={editingClip.caption || ''}
                    placeholder="Descripción y hashtags para TikTok, Reels o YouTube Shorts..."
                    onChange={(e) =>
                      setEditingClip((cur) =>
                        cur ? { ...cur, caption: e.target.value } : null,
                      )
                    }
                    className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-xs text-slate-100 outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3 border-t border-white/5 pt-4">
              <button
                type="button"
                onClick={() => setEditingClip(null)}
                disabled={savingClip}
                className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/10"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={saveClipEdits}
                disabled={savingClip}
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-2 text-xs font-semibold text-white transition hover:from-indigo-500 hover:to-violet-500 disabled:opacity-50"
              >
                {savingClip && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Guardar cambios
              </button>
            </div>
          </div>
        </div>
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

function HookOverlayPreview({
  text,
  style,
  position,
}: {
  text: string;
  style: HookStyle;
  position: HookPosition;
}) {
  const posClass =
    position === 'center'
      ? 'top-1/2 -translate-y-1/2'
      : position === 'bottom'
      ? 'bottom-10'
      : 'top-3';

  const boxClass =
    style === 'banner'
      ? 'bg-gradient-to-r from-indigo-600 to-fuchsia-600 text-white shadow-lg'
      : style === 'minimal'
      ? 'bg-black/60 text-white backdrop-blur-sm'
      : 'bg-white text-slate-950 shadow-xl';

  return (
    <div
      className={`pointer-events-none absolute inset-x-3 flex justify-center ${posClass}`}
    >
      <span
        className={`max-w-[92%] rounded-lg px-2.5 py-1 text-center text-[11px] font-extrabold uppercase leading-tight tracking-tight ${boxClass}`}
      >
        {text}
      </span>
    </div>
  );
}

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
