"""
Provider de video via ComfyUI (LTX-Video), falando com o servidor HTTP do
ComfyUI (`python main.py --listen`) -- substitui o antigo LtxVideoProvider,
que rodava inference.py como subprocesso local sem servidor HTTP.

## Como funciona
1. Carrega o workflow de referencia (formato API do ComfyUI) de
   `settings.COMFYUI_WORKFLOW_PATH` uma vez, no __init__.
2. A cada geracao, faz uma COPIA em memoria desse workflow e edita apenas
   os nos marcados com um `_meta.title` conhecido (ver `_NODE_TITLES`):
   prompt positivo, prompt negativo, imagem de entrada, dimensoes/length
   do latente de video e denoise do KSampler. O restante do grafo (loaders,
   samplers, decode, encode de video) fica exatamente como foi exportado da
   UI do ComfyUI -- este provider nunca inventa nos novos.
3. Faz upload da imagem de entrada via POST /upload/image (endpoint padrao
   do ComfyUI para o LoadImage), enfileira o grafo via POST /prompt, e faz
   polling assincrono em GET /history/{prompt_id} ate concluir ou estourar
   settings.COMFYUI_TIMEOUT_S.
4. Baixa o video de saida via GET /view e salva em OUTPUT_DIR_VIDEOS.

## Por que patch por titulo, e nao por node_id fixo
O grafo exato de um workflow LTX-Video (quantos nos, que class_type) muda
entre versoes do modelo/custom nodes -- fixar node_id quebraria a cada
atualizacao do ComfyUI ou troca de checkpoint. Localizar por `_meta.title`
deixa o provider estavel mesmo que o usuario reexporte um workflow
diferente da UI, desde que os titulos abaixo continuem presentes nos nos
certos (ver docstring de app/workflows/ltxv_i2v_api.json).
"""
import asyncio
import io
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from app.config import settings
from app.providers.base import VideoProvider, ProviderUnavailableError, ResourceExhaustedError

logger = logging.getLogger("nexus.comfyui_video_provider")

# Titulo (_meta.title) esperado em cada no do workflow que este provider
# precisa editar em runtime. Ver app/workflows/ltxv_i2v_api.json.
_NODE_TITLES = {
    "positive": "positive_prompt",
    "negative": "negative_prompt",
    "image": "input_image",
    "video_latent": "video_latent",
    "ksampler": "ksampler",
    "save_video": "save_video",
}

# Trechos tipicos de erro de OOM que o ComfyUI/PyTorch reportam em
# messages/exception_message dentro do /history -- usados para decidir se o
# resource_manager deve tentar de novo (ResourceExhaustedError) ou desistir
# na hora (ProviderUnavailableError).
_OOM_MARKERS = (
    "cuda out of memory",
    "cublas_status_alloc_failed",
    "outofmemoryerror",
    "cudaerrormemoryallocation",
    "not enough memory",
    "allocation on device",
)


class ComfyUIVideoProvider(VideoProvider):
    def __init__(self, host: str | None = None, workflow_path: Path | str | None = None):
        self.host = (host or settings.COMFYUI_HOST).rstrip("/")
        self.workflow_path = Path(workflow_path or settings.COMFYUI_WORKFLOW_PATH)
        self.client_id = str(uuid.uuid4())
        self._workflow_template: dict[str, Any] | None = None

    # --- carregamento/preparo do grafo ------------------------------------

    def _load_template(self) -> dict[str, Any]:
        if self._workflow_template is None:
            if not self.workflow_path.exists():
                raise ProviderUnavailableError(
                    f"Workflow do ComfyUI nao encontrado em '{self.workflow_path}'. "
                    f"Confira COMFYUI_WORKFLOW_PATH no .env -- deve apontar para um "
                    f"arquivo exportado via 'Workflow > Export (API Format)' na UI "
                    f"do ComfyUI (ver app/workflows/ltxv_i2v_api.json como referencia)."
                )
            try:
                raw = json.loads(self.workflow_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:
                raise ProviderUnavailableError(
                    f"Nao foi possivel ler/parsear o workflow do ComfyUI em "
                    f"'{self.workflow_path}': {e}"
                ) from e
            # "_comment" e um campo de documentacao livre no arquivo de
            # referencia -- nao e um no valido e o ComfyUI rejeitaria o
            # prompt se fosse enviado junto.
            raw.pop("_comment", None)
            self._workflow_template = raw
        # copia profunda simples via round-trip JSON: o grafo so contem
        # tipos primitivos/listas/dicts, entao isso e seguro e barato aqui.
        return json.loads(json.dumps(self._workflow_template))

    @staticmethod
    def _find_node_by_title(workflow: dict[str, Any], title: str) -> str:
        for node_id, node in workflow.items():
            if isinstance(node, dict) and node.get("_meta", {}).get("title") == title:
                return node_id
        raise ProviderUnavailableError(
            f"No com _meta.title='{title}' nao encontrado no workflow do ComfyUI "
            f"({workflow.__len__()} nos carregados). Confira se o arquivo em "
            f"COMFYUI_WORKFLOW_PATH tem esse titulo no no correto -- ver "
            f"app/workflows/ltxv_i2v_api.json."
        )

    def _build_prompt(self, positive_prompt: str, negative_prompt: str, image_filename: str,
                       width: int, height: int, length: int, denoise: float,
                       seed: int | None) -> dict[str, Any]:
        workflow = self._load_template()

        pos_id = self._find_node_by_title(workflow, _NODE_TITLES["positive"])
        workflow[pos_id]["inputs"]["text"] = positive_prompt

        neg_id = self._find_node_by_title(workflow, _NODE_TITLES["negative"])
        workflow[neg_id]["inputs"]["text"] = negative_prompt

        img_id = self._find_node_by_title(workflow, _NODE_TITLES["image"])
        workflow[img_id]["inputs"]["image"] = image_filename

        latent_id = self._find_node_by_title(workflow, _NODE_TITLES["video_latent"])
        workflow[latent_id]["inputs"]["width"] = width
        workflow[latent_id]["inputs"]["height"] = height
        workflow[latent_id]["inputs"]["length"] = length

        ksampler_id = self._find_node_by_title(workflow, _NODE_TITLES["ksampler"])
        workflow[ksampler_id]["inputs"]["denoise"] = denoise
        if seed is not None:
            workflow[ksampler_id]["inputs"]["seed"] = seed

        return workflow

    # --- chamadas HTTP ao ComfyUI ------------------------------------------

    async def _upload_image(self, client: httpx.AsyncClient, image_bytes: bytes) -> str:
        filename = f"nexus_{uuid.uuid4().hex}.png"
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
        # ComfyUI responde {"name": "<arquivo salvo>", "subfolder": "...", "type": "input"}
        return body.get("name") or filename

    async def _queue_prompt(self, client: httpx.AsyncClient, workflow: dict[str, Any]) -> str:
        payload = {"prompt": workflow, "client_id": self.client_id}
        try:
            resp = await client.post(f"{self.host}/prompt", json=payload)
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            raise ProviderUnavailableError(f"ComfyUI indisponivel ao enfileirar prompt: {e}") from e

        if resp.status_code != 200:
            body_text = resp.text
            # O ComfyUI retorna 400 com detalhes de validacao do grafo (ex:
            # no obrigatorio faltando, tipo errado) -- repassa a mensagem
            # crua, e o formato mais util pra diagnosticar um workflow.json
            # desatualizado sem precisar abrir a UI do ComfyUI pra debugar.
            raise ProviderUnavailableError(
                f"ComfyUI rejeitou o workflow ({resp.status_code}): {body_text[:800]}"
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
                            f"CUDA OOM no ComfyUI/LTX-Video (prompt_id={prompt_id}): {messages}"
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

    async def _download_output_video(self, client: httpx.AsyncClient, history_entry: dict[str, Any]) -> str:
        outputs = history_entry.get("outputs", {})
        save_title = _NODE_TITLES["save_video"]
        # Procura o output do no titulado "save_video" primeiro (mais preciso);
        # se o title nao aparecer no /history (alguns backends de video, como
        # VHS_VideoCombine, so retornam a chave "gifs" mesmo pra mp4), cai
        # para uma varredura de qualquer output com arquivo de video/gif.
        video_info = None
        for node_id, node_output in outputs.items():
            for key in ("gifs", "videos", "images"):
                items = node_output.get(key)
                if items:
                    video_info = items[-1]
                    break
            if video_info:
                break

        if not video_info:
            raise ProviderUnavailableError(
                f"ComfyUI concluiu o job mas nenhum output de video foi encontrado "
                f"(esperado no titulado '{save_title}'): {outputs}"
            )

        params = {
            "filename": video_info["filename"],
            "subfolder": video_info.get("subfolder", ""),
            "type": video_info.get("type", "output"),
        }
        try:
            resp = await client.get(f"{self.host}/view", params=params)
            resp.raise_for_status()
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            raise ProviderUnavailableError(f"ComfyUI indisponivel ao baixar o video gerado: {e}") from e
        except httpx.HTTPStatusError as e:
            raise ProviderUnavailableError(
                f"ComfyUI recusou o download do video ({e.response.status_code})"
            ) from e

        settings.OUTPUT_DIR_VIDEOS.mkdir(parents=True, exist_ok=True)
        suffix = Path(video_info["filename"]).suffix or ".mp4"
        output_path = settings.OUTPUT_DIR_VIDEOS / f"{uuid.uuid4()}{suffix}"
        output_path.write_bytes(resp.content)
        return str(output_path)

    # --- interface publica --------------------------------------------------

    async def generate(self, positive_prompt: str, negative_prompt: str, image_bytes: bytes,
                        width: int, height: int, length: int, denoise: float,
                        seed: int | None) -> str:
        logger.info(
            "[ComfyUI] Gerando video %sx%s, length=%s, denoise=%s (seed=%s)...",
            width, height, length, denoise, seed,
        )
        async with httpx.AsyncClient(timeout=30) as client:
            image_filename = await self._upload_image(client, image_bytes)
            workflow = self._build_prompt(
                positive_prompt=positive_prompt,
                negative_prompt=negative_prompt,
                image_filename=image_filename,
                width=width, height=height, length=length, denoise=denoise,
                seed=seed,
            )
            prompt_id = await self._queue_prompt(client, workflow)
            logger.info("[ComfyUI] Prompt enfileirado (prompt_id=%s), aguardando conclusao...", prompt_id)
            history_entry = await self._poll_history(client, prompt_id)
            return await self._download_output_video(client, history_entry)

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.host}/system_stats")
                return resp.status_code == 200
        except (httpx.ConnectError, httpx.TimeoutException):
            return False
