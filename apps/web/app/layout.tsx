import './globals.css';
import { ReactNode } from 'react';
import { Clapperboard, Sparkles, Github } from 'lucide-react';

export const metadata = {
  title: 'StreamLike - AI Video Clipping',
  description:
    'Convierte videos largos en clips virales de forma automática detectando los momentos de mayor energía.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen antialiased">
        <div className="bg-aurora" aria-hidden />

        <header className="sticky top-0 z-50 border-b border-white/5 bg-slate-950/70 backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <a href="/" className="group flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 shadow-lg shadow-indigo-500/30 transition group-hover:scale-105">
                <Clapperboard className="h-5 w-5 text-white" />
              </span>
              <span className="text-lg font-bold tracking-tight">
                Stream
                <span className="bg-gradient-to-r from-indigo-400 to-fuchsia-400 bg-clip-text text-transparent">
                  Like
                </span>
              </span>
            </a>

            <span className="hidden items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-slate-300 sm:inline-flex">
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
              AI Video Clipping
            </span>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>

        <footer className="mx-auto max-w-6xl px-6 pb-10 pt-4">
          <div className="flex flex-col items-center justify-between gap-2 border-t border-white/5 pt-6 text-xs text-slate-500 sm:flex-row">
            <span>StreamLike · prototipo SaaS de clipping automático</span>
            <span className="inline-flex items-center gap-1.5">
              <Github className="h-3.5 w-3.5" />
              Hecho con NestJS · Next.js · BullMQ · FFmpeg
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
