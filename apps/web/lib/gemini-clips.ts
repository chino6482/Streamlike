import { GoogleGenAI, Type } from '@google/genai';

export interface ClipAnalysisInput {
  videoTitle: string;
  sourceUrl?: string | null;
  topicHint?: string;
  duration: number;
  windows: Array<{
    startTime: number;
    endTime: number;
    audioScore: number;
  }>;
}

export interface EnhancedClipMetadata {
  startTime: number;
  title: string;
  hookText: string;
  why: string;
  caption: string;
  suggestedScore: number;
}

export class GeminiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiConfigError';
  }
}

export async function generateViralClipMetadata(
  input: ClipAnalysisInput,
  overrideApiKey?: string,
): Promise<EnhancedClipMetadata[]> {
  const apiKey = overrideApiKey?.trim() || process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new GeminiConfigError(
      'GEMINI_API_KEY no está configurada. Añade tu clave en "Configuración de API Keys" o configúrala en el servidor para generar hooks y títulos con IA.',
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const prompt = [
    'Eres un editor experto de shorts virales para TikTok, YouTube Shorts e Instagram Reels.',
    'Para cada ventana de tiempo detectada en el video, genera metadatos optimizados para retención en español:',
    '- title: título llamativo (máximo 58 caracteres)',
    '- hookText: frase gancho de apertura para superponer en pantalla los primeros 3 segundos (máximo 8 palabras, directa y provocadora)',
    '- why: explicación breve (1-2 frases) de por qué este momento retiene audiencia (gancho emocional, pico de energía, contraste)',
    '- caption: copy listo para publicar en redes sociales con 3-4 hashtags relevantes',
    '- suggestedScore: puntuación de viralidad calibrada de 60 a 99',
    '',
    `Video: "${input.videoTitle}" (${input.duration}s)`,
    input.sourceUrl ? `Origen: ${input.sourceUrl}` : '',
    input.topicHint ? `Contexto / temática indicada por el creador: ${input.topicHint}` : '',
    `Ventanas detectadas: ${JSON.stringify(input.windows)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            startTime: {
              type: Type.INTEGER,
              description: 'El startTime exacto de la ventana analizada.',
            },
            title: {
              type: Type.STRING,
              description: 'Título viral corto para el clip.',
            },
            hookText: {
              type: Type.STRING,
              description: 'Frase gancho corta para mostrar sobre el video.',
            },
            why: {
              type: Type.STRING,
              description: 'Razón de retención y potencial viral del clip.',
            },
            caption: {
              type: Type.STRING,
              description: 'Descripción social con hashtags listos para copiar.',
            },
            suggestedScore: {
              type: Type.INTEGER,
              description: 'Puntuación viral de 0 a 100.',
            },
          },
          required: ['startTime', 'title', 'hookText', 'why', 'caption', 'suggestedScore'],
        },
      },
    },
  });

  const rawText = (response.text ?? '[]').trim();
  const parsed = JSON.parse(rawText);
  if (!Array.isArray(parsed)) {
    throw new Error('La respuesta de Gemini no tuvo el formato esperado.');
  }
  return parsed;
}
