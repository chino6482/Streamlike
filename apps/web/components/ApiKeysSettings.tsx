'use client';

import { useState, useEffect } from 'react';
import {
  KeyRound,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  Check,
  Trash2,
  Info,
} from 'lucide-react';

interface ApiKeysSettingsProps {
  savedKey: string;
  onSaveKey: (nextKey: string) => void;
  onNotify?: (toast: { type: 'success' | 'error'; message: string }) => void;
}

export function ApiKeysSettings({
  savedKey,
  onSaveKey,
  onNotify,
}: ApiKeysSettingsProps) {
  const [open, setOpen] = useState(false);
  const [draftKey, setDraftKey] = useState(savedKey);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    setDraftKey(savedKey);
  }, [savedKey]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draftKey.replace(/[\r\n\0]/g, '').trim();
    if (!trimmed) {
      onSaveKey('');
      onNotify?.({
        type: 'success',
        message: 'Gemini API Key eliminada del navegador',
      });
      return;
    }
    if (trimmed.length > 512) {
      onNotify?.({
        type: 'error',
        message: 'La clave supera el límite permitido (512 caracteres)',
      });
      return;
    }
    onSaveKey(trimmed);
    onNotify?.({
      type: 'success',
      message: 'Gemini API Key guardada en este navegador',
    });
  };

  const handleClear = () => {
    setDraftKey('');
    onSaveKey('');
    onNotify?.({
      type: 'success',
      message: 'Gemini API Key eliminada de localStorage',
    });
  };

  return (
    <section className="animate-fade-up rounded-3xl border border-white/5 bg-white/[0.02] backdrop-blur">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="api-keys-settings-panel"
        onClick={() => setOpen((cur) => !cur)}
        className="flex w-full items-center justify-between gap-3 px-6 py-4 text-left transition hover:bg-white/[0.02] sm:px-8"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <KeyRound className="h-4 w-4 text-indigo-400" />
          <span className="text-sm font-bold text-slate-200">
            Configuración de API Keys
          </span>
          {savedKey ? (
            <span className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
              Gemini Key guardada en navegador
            </span>
          ) : (
            <span className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              Sin clave local
            </span>
          )}
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {!savedKey && (
        <div className="mx-6 mb-4 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3.5 py-2.5 text-xs text-amber-200/90 sm:mx-8">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span>
            No hay una <span className="font-semibold">Gemini API Key</span> guardada en
            este navegador. Las peticiones usarán la variable de entorno del servidor como
            respaldo, o el <span className="font-semibold">modo heurístico</span> si
            tampoco existe en el servidor.
          </span>
        </div>
      )}

      {open && (
        <form
          id="api-keys-settings-panel"
          onSubmit={handleSave}
          className="space-y-4 border-t border-white/5 px-6 py-5 sm:px-8"
        >
          <p className="text-xs leading-relaxed text-slate-400">
            Introduce tu propia <span className="font-semibold text-slate-200">Gemini API Key</span>{' '}
            para analizar clips y generar títulos, hooks y copy viral. Por privacidad, la clave
            se guarda exclusivamente en <span className="font-mono text-slate-300">localStorage</span>{' '}
            dentro de tu navegador y se envía en la cabecera{' '}
            <span className="font-mono text-slate-300">x-gemini-key</span> en lugar de depender
            de las claves globales del servidor. Puedes obtener una clave gratuita en{' '}
            <a
              href="https://aistudio.google.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-indigo-400 underline underline-offset-2 hover:text-indigo-300"
            >
              Google AI Studio
              <ExternalLink className="h-3 w-3" />
            </a>
            .
          </p>

          <div className="space-y-2">
            <label
              htmlFor="gemini-api-key-input"
              className="block text-xs font-medium text-slate-300"
            >
              Gemini API Key
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <input
                  id="gemini-api-key-input"
                  type={showKey ? 'text' : 'password'}
                  value={draftKey}
                  onChange={(e) => setDraftKey(e.target.value)}
                  placeholder="AIza..."
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-xl border border-white/10 bg-slate-950/70 py-2.5 pl-3.5 pr-10 font-mono text-xs text-slate-100 placeholder:text-slate-600 outline-none transition focus:border-indigo-500/60"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((prev) => !prev)}
                  aria-label={showKey ? 'Ocultar Gemini API Key' : 'Mostrar Gemini API Key'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 transition hover:text-slate-200"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-2.5 text-xs font-semibold text-white transition hover:from-indigo-500 hover:to-violet-500"
                >
                  <Check className="h-3.5 w-3.5" />
                  Guardar clave
                </button>

                {savedKey && (
                  <button
                    type="button"
                    onClick={handleClear}
                    aria-label="Eliminar Gemini API Key"
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Eliminar
                  </button>
                )}
              </div>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}
