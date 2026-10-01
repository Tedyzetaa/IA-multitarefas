import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ollama Chat",
  description: "Interface de chat estilo Claude conectada ao Ollama local",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <head>
        {/* Tema é aplicado antes da hidratação para evitar flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                const stored = localStorage.getItem('theme');
                const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                if (stored === 'dark' || (!stored && prefersDark)) {
                  document.documentElement.classList.add('dark');
                }
              } catch (e) {}
              
              // Aparência: carrega tema dinâmico
              try {
                const appearanceStr = localStorage.getItem('appearance-settings');
                const appearance = appearanceStr ? JSON.parse(appearanceStr) : {};
                const theme = appearance.theme || 'clay';
                
                // Mapeamento de temas para RGB
                const themes = {
                  clay: { rgb: '217 119 87', hover: '196 101 63', soft: '243 227 219' },
                  ocean: { rgb: '14 165 233', hover: '2 132 199', soft: '224 242 254' },
                  forest: { rgb: '16 185 129', hover: '5 150 105', soft: '209 250 229' },
                  violet: { rgb: '139 92 246', hover: '124 58 237', soft: '237 233 254' },
                  rose: { rgb: '244 63 94', hover: '225 29 72', soft: '255 228 230' },
                  amber: { rgb: '245 158 11', hover: '217 119 6', soft: '254 243 199' },
                  graphite: { rgb: '107 114 128', hover: '75 85 99', soft: '243 244 246' },
                };
                
                const t = themes[theme] || themes.clay;
                const root = document.documentElement;
                root.style.setProperty('--color-accent', t.rgb);
                root.style.setProperty('--color-accent-hover', t.hover);
                root.style.setProperty('--color-accent-soft', t.soft);
                
                if (appearance.customAccentColor && theme === 'custom') {
                  const hex = appearance.customAccentColor.replace('#', '');
                  const num = parseInt(hex, 16);
                  const r = (num >> 16) & 255;
                  const g = (num >> 8) & 255;
                  const b = num & 255;
                  const clamp = (n) => Math.max(0, Math.min(255, n));
                  const rgb = r + ' ' + g + ' ' + b;
                  const hover = clamp(r - 20) + ' ' + clamp(g - 20) + ' ' + clamp(b - 20);
                  const soft = clamp(r + 85) + ' ' + clamp(g + 85) + ' ' + clamp(b + 85);
                  root.style.setProperty('--color-accent', rgb);
                  root.style.setProperty('--color-accent-hover', hover);
                  root.style.setProperty('--color-accent-soft', soft);
                }
                
                if (appearance.wallpaperUrl) {
                  root.style.setProperty('--wallpaper-url', "url('" + appearance.wallpaperUrl + "')");
                  root.style.setProperty('--wallpaper-opacity', (appearance.wallpaperOpacity || 20) / 100);
                  root.style.setProperty('--wallpaper-blur', (appearance.wallpaperBlur || 8) + 'px');
                  root.classList.add('has-wallpaper');
                }
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
