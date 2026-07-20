import httpx
from app.config import settings
from app.providers.base import LLMProvider, ProviderUnavailableError

REFINEMENT_SYSTEM_PROMPT = (
    "Voce e um especialista em prompt engineering para modelos de geracao de imagem "
    "(estilo Stable Diffusion / Fooocus). Transforme a ideia do usuario em um prompt "
    "artistico rico em detalhes visuais: composicao, iluminacao, estilo de arte, cores, "
    "atmosfera e qualidade tecnica (ex: 'highly detailed, cinematic lighting, 8k'). "
    "Responda APENAS com o prompt final em ingles, sem explicacoes, sem aspas, "
    "sem markdown, em uma unica linha."
)


class OllamaProvider(LLMProvider):
    def __init__(self, host: str = None, model: str = None):
        self.host = host or settings.OLLAMA_HOST
        self.model = model or settings.OLLAMA_MODEL

    async def refine_prompt(self, user_prompt: str) -> str:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": REFINEMENT_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "stream": False,
            # mantem o modelo carregado so durante a chamada ativa
            "keep_alive": settings.OLLAMA_KEEP_ALIVE_ACTIVE,
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
