"""
Contratos abstratos. Qualquer provedor de LLM ou Imagem novo
(ex: trocar Ollama por LM Studio, ou Fooocus por ComfyUI)
so precisa implementar esta interface. O core (orchestrator)
nunca e alterado.
"""
from abc import ABC, abstractmethod
from typing import Literal
from app.models import GenerateRequest


class LLMProvider(ABC):
    @abstractmethod
    async def refine_prompt(self, user_prompt: str, mode: Literal["image", "video"] = "image") -> str:
        """
        Transforma um prompt simples em um prompt detalhado.
        `mode` seleciona o vocabulario de refinamento: "image" (estilo,
        composicao, iluminacao -- linguagem Stable Diffusion/Fooocus) ou
        "video" (acao cronologica, movimento de camera, duracao -- linguagem
        que modelos de video como o LTX-Video esperam).
        """
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


class VideoProvider(ABC):
    @abstractmethod
    async def generate(self, positive_prompt: str, negative_prompt: str, image_bytes: bytes,
                        width: int, height: int, length: int, denoise: float,
                        seed: int | None) -> str:
        """
        Dispara a geracao de video e retorna o caminho do arquivo final.

        O payload ja chega totalmente estruturado pelo orchestrator:
        `positive_prompt` (refinado pelo LLMProvider), `negative_prompt`
        (sempre o template fixo -- ver app/constants.py, nunca vem do
        usuario), `image_bytes` (PNG ja redimensionado para o teto de VRAM
        seguro) e `width`/`height`/`length`/`denoise` (parametros rigidos de
        config.py, nao configuraveis por request). O provider concreto so
        precisa montar/editar o grafo do backend de video (ex: ComfyUI) com
        esses valores e devolver o caminho do arquivo gerado.
        """
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        ...


class ThreeDProvider(ABC):
    @abstractmethod
    async def generate(self, image_bytes: bytes, seed: int | None,
                        octree_resolution: int, export_format: str) -> str:
        """
        Dispara a geracao image-to-3D (geometria/malha) e retorna o caminho
        do arquivo final no formato pedido (`export_format`: "glb" nativo
        do ComfyUI, ou "fbx" -- exige conversao adicional via Blender
        headless, ver app/providers/mesh_converter.py).

        `image_bytes` ja chega pronta (PNG, redimensionada) -- o provider
        so faz upload/enfileira o grafo do ComfyUI. `octree_resolution`
        controla o nivel de detalhe da malha (VRAM x qualidade); `seed`
        None = aleatorio.
        """
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        ...


class BaseProvider(ABC):
    """Contrato genérico para provedores que produzem artefatos externos."""

    provider_name: str = "base"

    @abstractmethod
    async def health_check(self) -> bool:
        ...

    @abstractmethod
    async def process(self, *args, **kwargs):
        ...


class ResourceExhaustedError(Exception):
    """Levantada quando VRAM/RAM insuficiente e detectada."""
    pass


class ProviderUnavailableError(Exception):
    """Levantada quando o servico externo (Ollama/Fooocus) nao responde."""
    pass
