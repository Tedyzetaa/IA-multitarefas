"""
Contratos abstratos. Qualquer provedor de LLM ou Imagem novo
(ex: trocar Ollama por LM Studio, ou Fooocus por ComfyUI)
so precisa implementar esta interface. O core (orchestrator)
nunca e alterado.
"""
from abc import ABC, abstractmethod
from app.models import GenerateRequest


class LLMProvider(ABC):
    @abstractmethod
    async def refine_prompt(self, user_prompt: str) -> str:
        """Transforma um prompt simples em um prompt artistico detalhado."""
        ...

    @abstractmethod
    async def clear_context(self) -> None:
        """Libera VRAM/RAM ocupada pelo modelo (ex: keep_alive=0)."""
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        ...


class ImageProvider(ABC):
    @abstractmethod
    async def generate(self, refined_prompt: str, req: GenerateRequest,
                        steps: int, resolution: str) -> str:
        """
        Dispara a geracao usando as funcoes nativas avancadas do provedor
        (styles, LoRAs, ControlNet, inpaint/outpaint, upscale/vary, etc,
        conforme presentes em `req`) e retorna o caminho/url do arquivo final.

        `refined_prompt` e o prompt ja processado pelo LLMProvider (Ollama);
        `steps`/`resolution` chegam separados porque o resource_manager os
        sobrescreve dinamicamente em caso de retry por OOM.
        """
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        ...


class ResourceExhaustedError(Exception):
    """Levantada quando VRAM/RAM insuficiente e detectada."""
    pass


class ProviderUnavailableError(Exception):
    """Levantada quando o servico externo (Ollama/Fooocus) nao responde."""
    pass
