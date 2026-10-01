"""
Provider de imagem via ComfyUI (SDXL / Pony Diffusion + LoRA), cobrindo os
modos text-to-image (T2I) e image-to-image (I2I) atraves de dois grafos de
referencia (formato API do ComfyUI) exportados da UI:
    - app/workflows/comfyui_t2i_api.json
    - app/workflows/comfyui_i2i_api.json

Segue o mesmo padrao HTTP do ComfyUIVideoProvider (upload de imagem via
/upload/image, enfileiramento via /prompt, polling assincrono em
/history/{prompt_id} e download via /view) -- ver
app/providers/comfyui_video_provider.py para o provider "irmao" de video.

## Por que localizar nos pelas *referencias do KSampler*, nao por titulo
ou por id fixo
Os dois workflows fornecidos NAO tem `_meta.title` unicos: os nos 6 e 7
compartilham o mesmo titulo de fabrica ("CLIP Text Encode (Prompt)"), entao
uma busca por titulo (como o provider de video faz) bateria nos dois e
sempre pegaria o primeiro -- silenciosamente escrevendo o prompt negativo
por cima do positivo em metade das geracoes. Hardcodar os ids "6"/"7"/"11"
tambem e fragil: quebra assim que alguem reexporta o workflow da UI do
ComfyUI e os ids sao renumerados.

Em vez disso, este provider le a propria estrutura do grafo: acha o
(unico) no KSampler e usa os *links* `positive`/`negative`/`latent_image`
dele para descobrir com certeza qual no e qual. LoadImage,
CheckpointLoaderSimple, SaveImage e LoraLoader sao localizados por
`class_type` (tambem unicos no grafo). Isso continua estavel mesmo que os
ids numericos mudem entre exports.
"""
import asyncio
import base64
import binascii
import io
import json
import logging
import random
import time
import uuid
from pathlib import Path
from typing import Any, Literal

import httpx

from app.config import settings
from app.models import GenerateRequest
from app.providers.base import ImageProvider, ProviderUnavailableError, ResourceExhaustedError

logger = logging.getLogger("nexus.comfyui_provider")

# Mesmos marcadores usados no provider de video -- ComfyUI/PyTorch reportam
# OOM com um vocabulario consistente em messages/exception_message dentro
# de /history, independente do grafo (imagem ou video) que estourou.
_OOM_MARKERS = (
    "cuda out of memory",
    "cublas_status_alloc_failed",
    "outofmemoryerror",
    "cudaerrormemoryallocation",
    "not enough memory",
    "allocation on device",
)

_SEED_MAX = 2**32 - 1  # teto de seed aceito pelo KSampler do ComfyUI


class ComfyUIImageProvider(ImageProvider):
    def __init__(self, host: str | None = None,
                 t2i_workflow_path: Path | str | None = None,
                 i2i_workflow_path: Path | str | None = None):
        self.host = (host or settings.COMFYUI_HOST).rstrip("/")
        self.t2i_path = Path(t2i_workflow_path or settings.COMFYUI_T2I_WORKFLOW_PATH)
        self.i2i_path = Path(i2i_workflow_path or settings.COMFYUI_I2I_WORKFLOW_PATH)
        self.client_id = str(uuid.uuid4())
        self._templates: dict[str, dict[str, Any]] = {}

    # --- carregamento/preparo do grafo --------------------------------

    def _load_template(self, mode: Literal["t2i", "i2i"]) -> dict[str, Any]:
        if mode not in self._templates:
            path = self.t2i_path if mode == "t2i" else self.i2i_path
            if not path.exists():
                raise ProviderUnavailableError(
                    f"Workflow ComfyUI para modo '{mode}' nao encontrado em '{path}'. "
                    f"Confira COMFYUI_{mode.upper()}_WORKFLOW_PATH no .env."
                )
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:
                raise ProviderUnavailableError(
                    f"Nao foi possivel ler/parsear o workflow ComfyUI em '{path}': {e}"
                ) from e
            raw.pop("_comment", None)
            self._templates[mode] = raw
        # copia profunda barata via round-trip JSON (grafo so tem tipos primitivos)
        return json.loads(json.dumps(self._templates[mode]))

    @staticmethod
    def _find_by_class(workflow: dict[str, Any], class_type: str, required: bool = True) -> str | None:
        matches = [
            node_id for node_id, node in workflow.items()
            if isinstance(node, dict) and node.get("class_type") == class_type
        ]
        if not matches:
            if required:
                raise ProviderUnavailableError(
                    f"No de class_type='{class_type}' nao encontrado no workflow ComfyUI "
                    f"({len(workflow)} nos carregados)."
                )
            return None
        if len(matches) > 1:
            logger.warning(
                "Workflow ComfyUI tem %d nos de class_type=%s (%s); usando o primeiro (%s).",
                len(matches), class_type, matches, matches[0],
            )
        return matches[0]

    def _build_prompt(self, mode: Literal["t2i", "i2i"], positive_prompt: str, negative_prompt: str,
                       steps: int, cfg: float | None, seed: int | None,
                       width: int | None, height: int | None, denoise: float | None,
                       lora_name: str | None, image_filename: str | None) -> dict[str, Any]:
        workflow = self._load_template(mode)

        ksampler_id = self._find_by_class(workflow, "KSampler")
        ksampler_inputs = workflow[ksampler_id]["inputs"]

        # Descobre os nos de prompt positivo/negativo pelos LINKS do
        # KSampler (["<node_id>", <slot>]), nao por titulo/posicao -- ver
        # docstring do modulo.
        positive_id = ksampler_inputs["positive"][0]
        negative_id = ksampler_inputs["negative"][0]
        workflow[positive_id]["inputs"]["text"] = positive_prompt
        workflow[negative_id]["inputs"]["text"] = negative_prompt

        ksampler_inputs["seed"] = seed if seed is not None else random.randint(0, _SEED_MAX)
        ksampler_inputs["steps"] = steps
        if cfg is not None:
            ksampler_inputs["cfg"] = cfg
        if denoise is not None:
            ksampler_inputs["denoise"] = denoise

        if mode == "t2i":
            latent_id = ksampler_inputs["latent_image"][0]
            if workflow[latent_id].get("class_type") == "EmptyLatentImage" and width and height:
                workflow[latent_id]["inputs"]["width"] = width
                workflow[latent_id]["inputs"]["height"] = height
        else:
            if not image_filename:
                # Defesa em profundidade: o Pydantic (GenerateRequest) ja
                # exige image_base64 quando mode == "i2i", mas um provider
                # nunca deve confiar cegamente no schema de outra camada.
                raise ProviderUnavailableError(
                    "Modo i2i requer uma imagem de entrada, mas nenhuma foi recebida "
                    "(image_base64 ausente ou vazio)."
                )
            load_image_id = self._find_by_class(workflow, "LoadImage")
            workflow[load_image_id]["inputs"]["image"] = image_filename

        # LoRA e opcional: se o grafo nao tiver LoraLoader, ou nenhum nome
        # customizado foi pedido, deixa o valor exportado do workflow como esta.
        lora_id = self._find_by_class(workflow, "LoraLoader", required=False)
        if lora_id and lora_name:
            workflow[lora_id]["inputs"]["lora_name"] = lora_name

        return workflow

    # --- decodificacao de base64 -----------------------------------------

    @staticmethod
    def _decode_base64_image(image_base64: str) -> bytes:
        """
        Bug corrigido: aceita tanto base64 puro quanto uma data URI completa
        (ex: "data:image/jpeg;base64,/9j/4AAQ..."), que e o formato que
        `<input type="file">` + FileReader.readAsDataURL produz no browser
        e que o frontend manda sem alteracao. Um strip ingenuo por
        ",".split(1) tambem quebraria se o payload nao tiver prefixo -- aqui
        so removemos o prefixo quando ele de fato existe.
        """
        payload = image_base64.strip()
        if payload.lower().startswith("data:") and "," in payload:
            payload = payload.split(",", 1)[1]
        try:
            return base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError) as e:
            raise ProviderUnavailableError(
                f"image_base64 invalido: nao foi possivel decodificar ({e})"
            ) from e

    # --- chamadas HTTP ao ComfyUI (mesmo padrao do provider de video) ----

    async def _upload_image(self, client: httpx.AsyncClient, image_bytes: bytes) -> str:
        filename = f"nexus_i2i_{uuid.uuid4().hex}.png"
        files = {"image": (filename, io.BytesIO(image_bytes), "image/png")}
        data = {"type": "input", "overwrite": "true"}
        try:
            resp = await client.post(f"{self.host}/upload/image", files=files, data=data)
            resp.raise_for_status()
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            raise ProviderUnavailableError(f"ComfyUI indisponivel (upload de imagem): {e}") from e
        except httpx.HTTPStatusError as e:
            raise ProviderUnavailableError(
                f"ComfyUI recusou o upload da imagem ({e.response.status_code}): {e.response.text[:300]}"
            ) from e
        body = resp.json()
        return body.get("name") or filename

    async def _queue_prompt(self, client: httpx.AsyncClient, workflow: dict[str, Any]) -> str:
        payload = {"prompt": workflow, "client_id": self.client_id}
        try:
            resp = await client.post(f"{self.host}/prompt", json=payload)
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            raise ProviderUnavailableError(f"ComfyUI indisponivel ao enfileirar prompt: {e}") from e

        if resp.status_code != 200:
            raise ProviderUnavailableError(
                f"ComfyUI rejeitou o workflow ({resp.status_code}): {resp.text[:800]}"
            )

        data = resp.json()
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            raise ProviderUnavailableError(f"ComfyUI nao retornou prompt_id: {data}")
        return prompt_id

    async def _poll_history(self, client: httpx.AsyncClient, prompt_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + settings.COMFYUI_TIMEOUT_S
        while time.monotonic() < deadline:
            try:
                resp = await client.get(f"{self.host}/history/{prompt_id}")
                resp.raise_for_status()
            except (httpx.ConnectError, httpx.TimeoutException) as e:
                raise ProviderUnavailableError(f"ComfyUI indisponivel durante o polling: {e}") from e
            except httpx.HTTPStatusError as e:
                raise ProviderUnavailableError(
                    f"ComfyUI respondeu com erro ({e.response.status_code}) durante o polling"
                ) from e

            history = resp.json()
            entry = history.get(prompt_id)
            if entry:
                status = entry.get("status", {})
                messages = status.get("messages", [])

                if status.get("status_str") == "error" or not status.get("completed", True):
                    error_text = json.dumps(messages).lower()
                    if any(marker in error_text for marker in _OOM_MARKERS):
                        raise ResourceExhaustedError(
                            f"CUDA OOM no ComfyUI (prompt_id={prompt_id}): {messages}"
                        )
                    if status.get("status_str") == "error":
                        raise ProviderUnavailableError(
                            f"Execucao do workflow falhou no ComfyUI (prompt_id={prompt_id}): {messages}"
                        )

                if entry.get("outputs"):
                    return entry

            await asyncio.sleep(settings.COMFYUI_POLL_INTERVAL_S)

        raise ProviderUnavailableError(
            f"Timeout ({settings.COMFYUI_TIMEOUT_S}s) aguardando o ComfyUI concluir prompt_id={prompt_id}."
        )

    async def _download_output_image(self, client: httpx.AsyncClient, history_entry: dict[str, Any]) -> str:
        outputs = history_entry.get("outputs", {})
        image_info = None
        for node_output in outputs.values():
            images = node_output.get("images")
            if images:
                image_info = images[-1]
                break

        if not image_info:
            raise ProviderUnavailableError(
                f"ComfyUI concluiu o job mas nenhum output de imagem foi encontrado "
                f"(esperado em um no SaveImage): {outputs}"
            )

        params = {
            "filename": image_info["filename"],
            "subfolder": image_info.get("subfolder", ""),
            "type": image_info.get("type", "output"),
        }
        try:
            resp = await client.get(f"{self.host}/view", params=params)
            resp.raise_for_status()
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            raise ProviderUnavailableError(f"ComfyUI indisponivel ao baixar a imagem gerada: {e}") from e
        except httpx.HTTPStatusError as e:
            raise ProviderUnavailableError(
                f"ComfyUI recusou o download da imagem ({e.response.status_code})"
            ) from e

        settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        suffix = Path(image_info["filename"]).suffix or ".png"
        output_path = settings.OUTPUT_DIR / f"{uuid.uuid4()}{suffix}"
        output_path.write_bytes(resp.content)
        return str(output_path)

    @staticmethod
    def _parse_resolution(resolution: str) -> tuple[int, int]:
        """Aceita o mesmo formato usado por settings.FOOOCUS_DEFAULT_RESOLUTION
        ("1152*896"), mais "x" como separador alternativo ("1024x1024")."""
        sep = "*" if "*" in resolution else "x"
        try:
            width_s, height_s = resolution.lower().split(sep, 1)
            return int(width_s), int(height_s)
        except (ValueError, AttributeError):
            logger.warning("Resolucao '%s' invalida, usando 1024x1024.", resolution)
            return 1024, 1024

    # --- interface publica (ImageProvider) -------------------------------

    async def generate(self, refined_prompt: str, req: GenerateRequest, steps: int, resolution: str) -> str:
        mode: Literal["t2i", "i2i"] = getattr(req, "mode", "t2i") or "t2i"
        width, height = self._parse_resolution(resolution)

        logger.info("[ComfyUI] Gerando imagem modo=%s %sx%s steps=%s (seed=%s)...",
                    mode, width, height, steps, req.seed)

        async with httpx.AsyncClient(timeout=30) as client:
            image_filename = None
            if mode == "i2i":
                if not req.image_base64:
                    raise ProviderUnavailableError(
                        "Modo i2i requer image_base64 no payload de /api/generate."
                    )
                image_bytes = self._decode_base64_image(req.image_base64)
                image_filename = await self._upload_image(client, image_bytes)

            workflow = self._build_prompt(
                mode=mode,
                positive_prompt=refined_prompt,
                negative_prompt=req.negative_prompt or settings.COMFYUI_DEFAULT_NEGATIVE_PROMPT,
                steps=steps,
                cfg=req.guidance_scale,
                seed=req.seed,
                width=width,
                height=height,
                denoise=settings.COMFYUI_I2I_DENOISE if mode == "i2i" else None,
                lora_name=settings.COMFYUI_DEFAULT_LORA_NAME or None,
                image_filename=image_filename,
            )
            prompt_id = await self._queue_prompt(client, workflow)
            logger.info("[ComfyUI] Prompt enfileirado (prompt_id=%s), aguardando conclusao...", prompt_id)
            history_entry = await self._poll_history(client, prompt_id)
            return await self._download_output_image(client, history_entry)

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.host}/system_stats")
                return resp.status_code == 200
        except (httpx.ConnectError, httpx.TimeoutException):
            return False
