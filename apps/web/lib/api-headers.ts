export const GEMINI_STORAGE_KEY = 'GEMINI_API_KEY';

export function sanitizeGeminiKey(raw?: string | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/[\r\n\0]/g, '').trim();
  if (!cleaned || cleaned.length > 512) return undefined;
  return cleaned;
}

export function buildApiHeaders(options?: {
  apiKey?: string;
  geminiKey?: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options?.apiKey) {
    headers['x-api-key'] = options.apiKey;
  }
  const cleanGemini = sanitizeGeminiKey(options?.geminiKey);
  if (cleanGemini) {
    headers['x-gemini-key'] = cleanGemini;
  }
  return headers;
}

export function readStoredGeminiKey(): string {
  if (typeof window === 'undefined') return '';
  try {
    return sanitizeGeminiKey(window.localStorage.getItem(GEMINI_STORAGE_KEY)) || '';
  } catch {
    return '';
  }
}

export function writeStoredGeminiKey(raw: string): string {
  const clean = sanitizeGeminiKey(raw) || '';
  if (typeof window === 'undefined') return clean;
  try {
    if (clean) {
      window.localStorage.setItem(GEMINI_STORAGE_KEY, clean);
    } else {
      window.localStorage.removeItem(GEMINI_STORAGE_KEY);
    }
  } catch {
    /* ignore storage quota/privacy errors */
  }
  return clean;
}
