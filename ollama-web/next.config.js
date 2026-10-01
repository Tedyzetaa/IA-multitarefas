// Versao instalada do Next: o nome da opcao de limite de body mudou na 16
// (middleware -> proxy). Setamos so a chave que a versao reconhece, sem warnings.
const nextMajor = (() => {
  try {
    return parseInt(require("next/package.json").version.split(".")[0], 10);
  } catch {
    return 15;
  }
})();
const bodyLimitKey = nextMajor >= 16 ? "proxyClientMaxBodySize" : "middlewareClientMaxBodySize";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  experimental: {
    // O Next bufferiza em memoria o body das requisicoes que passam pelos rewrites
    // (/nexus-proxy, /ollama-proxy) e, acima de 10MB, TRUNCA o resto em silencio
    // ("Request body exceeded 10MB ... Only the first 10MB will be available").
    // O upload de audio (ate 25MB no UI) chegava incompleto no FastAPI -> 422
    // "file: Field required" + "Failed to proxy ... ECONNRESET" + 500 na UI.
    [bodyLimitKey]: "100mb",
    // Padrao do proxy = 30s. A dublagem sincrona (<10MB) espera a ElevenLabs e estourava.
    proxyTimeout: 300_000,
  },

  // Proxy reverso via Next.js: o navegador so fala com a propria origem
  // (localhost:3000), e o Next.js repassa a chamada por baixo dos panos
  // para o Ollama / Nexus-Bridge reais. Isso elimina CORS e requisicoes
  // OPTIONS de preflight por completo -- em vez de "consertar" headers,
  // a chamada deixa de ser cross-origin.
  //
  // Configure OLLAMA_INTERNAL_URL / NEXUS_INTERNAL_URL no .env se os
  // serviços não estiverem nos endereços padrão abaixo.
  async rewrites() {
    return [
      {
        source: "/ollama-proxy/:path*",
        destination: `${process.env.OLLAMA_INTERNAL_URL || "http://127.0.0.1:11434"}/:path*`,
      },
      {
        source: "/nexus-proxy/:path*",
        destination: `${process.env.NEXUS_INTERNAL_URL || "http://127.0.0.1:8000"}/:path*`,
      },
    ];
  },
  allowedDevOrigins: ["100.113.248.34", "localhost:3000"],
};

module.exports = nextConfig;
