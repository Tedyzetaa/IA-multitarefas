from typing import Literal

import httpx
from app.config import settings
from app.providers.base import LLMProvider, ProviderUnavailableError

REFINEMENT_SYSTEM_PROMPT_IMAGE = (
    "Voce e um especialista em prompt engineering para modelos de geracao de imagem "
    "(estilo Stable Diffusion / Fooocus). Transforme a ideia do usuario em um prompt "
    "artistico rico em detalhes visuais: composicao, iluminacao, estilo de arte, cores, "
    "atmosfera e qualidade tecnica (ex: 'highly detailed, cinematic lighting, 8k'). "
    "Responda APENAS com o prompt final em ingles, sem explicacoes, sem aspas, "
    "sem markdown, em uma unica linha."
)

TRANSLATION_SYSTEM_PROMPT_TEMPLATE = (
    "You are a professional subtitle/dubbing translator. Translate the user's text from "
    "{source_lang} to {target_lang}. Preserve meaning, tone and register; keep it natural "
    "for spoken narration (this text will be fed to a text-to-speech engine). "
    "Output ONLY the translated text, nothing else -- no explanations, no quotes, no markdown."
)

REFINEMENT_SYSTEM_PROMPT_VIDEO = """You are a prompt writer for an image-to-video AI model (LTX-Video).
The source image is always a top-down flat-lay product photo (e.g. bedding laid flat on a bed, seen from above). Rewrite the user's product description into a SHORT, literal video prompt.

Rules:
- Maximum 25 words. Never write a narrative or a story.
- Describe ONLY the product itself (pattern, color, material) — never invent a room, wall, window, floor, headboard, furniture, or lighting setup that the user did not explicitly mention. If the user's description has no background details, do not add any.
- Never mention a person, hand, model, or any human presence, even implicitly.
- Always end the prompt with exactly one simple camera motion, e.g.: "slow zoom in", "subtle push-in", "slow overhead pan". Never omit this.
- Do not describe motion of the product itself (it must not move, morph, or change shape).

Output ONLY the final prompt text, nothing else — no preamble, no quotes, no explanation."""


class OllamaProvider(LLMProvider):
    def __init__(self, host: str = None, model: str = None):
        self.host = host or settings.OLLAMA_HOST
        self.model = model or settings.OLLAMA_MODEL

    async def refine_prompt(self, user_prompt: str, mode: Literal["image", "video"] = "image") -> str:
        system_prompt = (
            REFINEMENT_SYSTEM_PROMPT_VIDEO if mode == "video" else REFINEMENT_SYSTEM_PROMPT_IMAGE
        )
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "stream": False,
            # mantem o modelo carregado so durante a chamada ativa
            "keep_alive": settings.OLLAMA_KEEP_ALIVE_ACTIVE,
            # contexto fixo e pequeno: refinamento de prompt nao precisa de
            # historico longo, e um num_ctx alto e a forma mais rapida de
            # estourar VRAM numa RTX 3050 6GB quando o modelo mudar no futuro.
            "options": {"num_ctx": settings.OLLAMA_NUM_CTX},
        }
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(f"{self.host}/api/chat", json=payload)
                resp.raise_for_status()
                data = resp.json()
                refined = data.get("message", {}).get("content", "").strip()
                return refined or user_prompt
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            raise ProviderUnavailableError(f"Ollama indisponivel: {e}") from e
        except httpx.HTTPStatusError as e:
            # Caso mais comum: o modelo configurado em OLLAMA_MODEL (.env) nao
            # esta instalado/puxado no Ollama (404). Sem esse catch, o erro
            # cru do httpx ("Client error '404 Not Found' for url ...") vazava
            # ate o card de video na UI, sem dizer o que de fato faltava.
            if e.response.status_code == 404:
                raise ProviderUnavailableError(
                    f"Modelo '{self.model}' nao encontrado no Ollama ({self.host}). "
                    f"Rode 'ollama list' e confira o valor de OLLAMA_MODEL no .env."
                ) from e
            raise ProviderUnavailableError(
                f"Ollama respondeu com erro {e.response.status_code}: {e}"
            ) from e

    async def translate_text(self, text: str, source_lang: str, target_lang: str, model: str | None = None) -> str:
        """Traduz `text` de source_lang para target_lang reaproveitando o Ollama.

        Usado pelo pipeline de translation_dubbing (app/providers/translation_dubbing_provider.py)
        para traduzir a transcricao do whisper antes de sintetizar com XTTS v2.
        model permite sobrescrever settings.OLLAMA_MODEL (ex: settings.TRANSLATION_OLLAMA_MODEL).
        """
        if not text or not text.strip():
            raise ValueError("Texto vazio para traducao.")
        system_prompt = TRANSLATION_SYSTEM_PROMPT_TEMPLATE.format(
            source_lang=source_lang, target_lang=target_lang
        )
        payload = {
            "model": model or self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            "stream": False,
            "keep_alive": settings.OLLAMA_KEEP_ALIVE_ACTIVE,
            "options": {"num_ctx": settings.OLLAMA_NUM_CTX},
        }
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(f"{self.host}/api/chat", json=payload)
                resp.raise_for_status()
                data = resp.json()
                translated = data.get("message", {}).get("content", "").strip()
                if not translated:
                    raise ProviderUnavailableError("Ollama devolveu tradução vazia.")
                return translated
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            raise ProviderUnavailableError(f"Ollama indisponivel para traducao: {e}") from e
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                raise ProviderUnavailableError(
                    f"Modelo '{model or self.model}' nao encontrado no Ollama ({self.host}) "
                    f"para traducao. Rode 'ollama list' e confira TRANSLATION_OLLAMA_MODEL/OLLAMA_MODEL."
                ) from e
            raise ProviderUnavailableError(
                f"Ollama respondeu com erro {e.response.status_code} na traducao: {e}"
            ) from e

    async def clear_context(self) -> None:
        """
        Nao mantemos historico de conversa entre chamadas (cada refine_prompt e
        stateless), e alem disso forcamos o descarregamento do modelo da VRAM
        enviando keep_alive=0, liberando memoria para o Fooocus.
        """
        payload = {
            "model": self.model,
            "messages": [],
            "stream": False,
            "keep_alive": settings.OLLAMA_KEEP_ALIVE_IDLE,
        }
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                await client.post(f"{self.host}/api/chat", json=payload)
        except (httpx.ConnectError, httpx.TimeoutException):
            # Nao e critico se o unload falhar; o Ollama descarrega sozinho
            # apos o timeout padrao de 5 minutos.
            pass

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.host}/api/tags")
                return resp.status_code == 200
        except (httpx.ConnectError, httpx.TimeoutException):
            return False

    async def model_ready(self) -> tuple[bool, str | None]:
        """
        Health check ativo de verdade: confere se o Ollama esta de pe NA PORTA
        configurada (OLLAMA_HOST) e se o modelo especifico (OLLAMA_MODEL) esta
        instalado -- nao basta o servico responder, o modelo errado/ausente
        tambem deve ser reportado como falha.
        Retorna (ready: bool, detail: str | None) -- detail so vem preenchido
        quando ready=False, para aparecer no /api/health.
        """
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.host}/api/tags")
                if resp.status_code != 200:
                    return False, f"Ollama respondeu com status {resp.status_code}"
                names = {m.get("name") for m in resp.json().get("models", [])}
                if self.model not in names:
                    return False, f"Modelo '{self.model}' nao encontrado (instalados: {sorted(names)})"
                return True, None
        except httpx.ConnectError:
            return False, f"Conexao recusada em {self.host} -- o Ollama esta rodando?"
        except httpx.TimeoutException:
            return False, f"Timeout ao consultar {self.host}/api/tags"
