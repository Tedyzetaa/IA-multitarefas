"""
Provider de geracao 3D (imagem -> malha) via ComfyUI, usando o pipeline
NATIVO do ComfyUI-Core para Hunyuan3D 2.0 (Tencent) -- sem custom node
packs, apenas os nos que ja vem com o ComfyUI >= 0.3.35:
ImageOnlyCheckpointLoader, ModelSamplingAuraFlow, CLIPVisionEncode,
EmptyLatentHunyuan3Dv2, Hunyuan3Dv2Conditioning, KSampler,
VAEDecodeHunyuan3D, VoxelToMesh, SaveGLB.

Segue o MESMO padrao HTTP dos providers "irmaos" (ver
app/providers/comfyui_video_provider.py e comfyui_provider.py): upload de
imagem via /upload/image, enfileiramento via /prompt, polling assincrono
em /history/{prompt_id} e download via /view.

## Por que localizar nos por _meta.title (nao por node_id fixo)
Mesmo motivo do ComfyUIVideoProvider: o grafo exato pode mudar entre
versoes do ComfyUI/reexports da UI. O workflow de referencia
(app/workflows/hunyuan3d_i2mesh_api.json) ja vem com titulos estaveis
gravados em cada no -- ver _NODE_TITLES abaixo.

## Saida: SEM textura
Este pipeline gera so a GEOMETRIA (estagio Hunyuan3D-DiT). O estagio de
textura/PBR (Hunyuan3D-Paint) exige bastante mais VRAM e nao esta neste
grafo de proposito (mesma filosofia de "parametros rigidos para caber em
6GB" usada no pipeline de video LTX -- ver config.py). A malha sai como
.glb (formato nativo do no SaveGLB do ComfyUI). Para converter para .fbx
(import no Roblox Studio), ver app/providers/mesh_converter.py -- Roblox
Studio importa .gltf/.glb tao bem quanto .fbx (ambos suportam multiplos
objetos/hierarquias e PBR), entao .fbx so e necessario se voce
especificamente precisa desse formato.
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
from app.providers.base import ThreeDProvider, ProviderUnavailableError, ResourceExhaustedError

logger = logging.getLogger("nexus.comfyui_3d_provider")

_NODE_TITLES = {
    "checkpoint": "hy3d_checkpoint",
    "image": "input_image",
    "ksampler": "ksampler",
    "vae_decode": "vae_decode_hy3d",
    "save_glb": "save_glb",
}

# Mesmo vocabulario de erro de OOM usado nos outros providers ComfyUI deste
# projeto -- ver comfyui_video_provider.py/comfyui_provider.py.
_OOM_MARKERS = (
    "cuda out of memory",
    "cublas_status_alloc_failed",
    "outofmemoryerror",
    "cudaerrormemoryallocation",
    "not enough memory",
    "allocation on device",
)


class ComfyUI3DProvider(ThreeDProvider):
    def __init__(self, host: str | None = None, workflow_path: Path | str | None = None):
        self.host = (host or settings.COMFYUI_HOST).rstrip("/")
        self.workflow_path = Path(workflow_path or settings.COMFYUI_3D_WORKFLOW_PATH)
        self.client_id = str(uuid.uuid4())
        self._workflow_template: dict[str, Any] | None = None

    # --- carregamento/preparo do grafo --------------------------------

    def _load_template(self) -> dict[str, Any]:
        if self._workflow_template is None:
            if not self.workflow_path.exists():
                raise ProviderUnavailableError(
                    f"Workflow ComfyUI (3D) nao encontrado em '{self.workflow_path}'. "
                    f"Confira COMFYUI_3D_WORKFLOW_PATH no .env -- deve apontar para um "
                    f"arquivo em formato API (ver app/workflows/hunyuan3d_i2mesh_api.json "
                    f"como referencia)."
                )
            try:
                raw = json.loads(self.workflow_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:
                raise ProviderUnavailableError(
                    f"Nao foi possivel ler/parsear o workflow ComfyUI (3D) em "
                    f"'{self.workflow_path}': {e}"
                ) from e
            raw.pop("_comment", None)
            self._workflow_template = raw
        return json.loads(json.dumps(self._workflow_template))

    @staticmethod
    def _find_node_by_title(workflow: dict[str, Any], title: str) -> str:
        for node_id, node in workflow.items():
            if isinstance(node, dict) and node.get("_meta", {}).get("title") == title:
                return node_id
        raise ProviderUnavailableError(
            f"No com _meta.title='{title}' nao encontrado no workflow ComfyUI (3D) "
            f"({len(workflow)} nos carregados). Confira COMFYUI_3D_WORKFLOW_PATH -- "
            f"ver app/workflows/hunyuan3d_i2mesh_api.json."
        )

    def _build_prompt(self, image_filename: str, seed: int | None, octree_resolution: int) -> dict[str, Any]:
        workflow = self._load_template()

        img_id = self._find_node_by_title(workflow, _NODE_TITLES["image"])
        workflow[img_id]["inputs"]["image"] = image_filename

        ckpt_id = self._find_node_by_title(workflow, _NODE_TITLES["checkpoint"])
        if settings.COMFYUI_3D_CKPT_NAME:
            workflow[ckpt_id]["inputs"]["ckpt_name"] = settings.COMFYUI_3D_CKPT_NAME

        ksampler_id = self._find_node_by_title(workflow, _NODE_TITLES["ksampler"])
        workflow[ksampler_id]["inputs"]["seed"] = seed if seed is not None else int(uuid.uuid4().int % (2**32 - 1))
        workflow[ksampler_id]["inputs"]["steps"] = settings.COMFYUI_3D_STEPS
        workflow[ksampler_id]["inputs"]["cfg"] = settings.COMFYUI_3D_CFG

        vae_decode_id = self._find_node_by_title(workflow, _NODE_TITLES["vae_decode"])
        workflow[vae_decode_id]["inputs"]["octree_resolution"] = octree_resolution
        workflow[vae_decode_id]["inputs"]["num_chunks"] = settings.COMFYUI_3D_NUM_CHUNKS

        return workflow

    # --- chamadas HTTP ao ComfyUI (mesmo padrao dos providers irmaos) ----

    async def _upload_image(self, client: httpx.AsyncClient, image_bytes: bytes) -> str:
        filename = f"nexus_3d_{uuid.uuid4().hex}.png"
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
            raise ProviderUnavailableError(f"ComfyUI indisponivel ao enfileirar prompt (3D): {e}") from e

        if resp.status_code != 200:
            raise ProviderUnavailableError(
                f"ComfyUI rejeitou o workflow 3D ({resp.status_code}): {resp.text[:800]}"
            )

        data = resp.json()
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            raise ProviderUnavailableError(f"ComfyUI nao retornou prompt_id (3D): {data}")
        return prompt_id

    async def _poll_history(self, client: httpx.AsyncClient, prompt_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + settings.COMFYUI_TIMEOUT_S
        while time.monotonic() < deadline:
            try:
                resp = await client.get(f"{self.host}/history/{prompt_id}")
                resp.raise_for_status()
            except (httpx.ConnectError, httpx.TimeoutException) as e:
                raise ProviderUnavailableError(f"ComfyUI indisponivel durante o polling (3D): {e}") from e
            except httpx.HTTPStatusError as e:
                raise ProviderUnavailableError(
                    f"ComfyUI respondeu com erro ({e.response.status_code}) durante o polling (3D)"
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
                            f"CUDA OOM no ComfyUI/Hunyuan3D (prompt_id={prompt_id}): {messages}"
                        )
                    if status.get("status_str") == "error":
                        raise ProviderUnavailableError(
                            f"Execucao do workflow 3D falhou no ComfyUI (prompt_id={prompt_id}): {messages}"
                        )

                if entry.get("outputs"):
                    return entry

            await asyncio.sleep(settings.COMFYUI_POLL_INTERVAL_S)

        raise ProviderUnavailableError(
            f"Timeout ({settings.COMFYUI_TIMEOUT_S}s) aguardando o ComfyUI concluir o job 3D "
            f"(prompt_id={prompt_id})."
        )

    async def _download_output_mesh(self, client: httpx.AsyncClient, history_entry: dict[str, Any]) -> str:
        """
        Varre os outputs do /history de forma GENERICA (nao assume a chave
        exata que o SaveGLB usa no dict de outputs -- isso pode variar
        entre versoes do ComfyUI, diferente de nos consolidados como
        SaveImage/VHS_VideoCombine). Procura qualquer lista de dicts com
        'filename' em QUALQUER chave do node_output, e prioriza o que tem
        extensao de malha 3D conhecida.
        """
        outputs = history_entry.get("outputs", {})
        _MESH_EXTS = (".glb", ".gltf", ".obj", ".ply", ".stl", ".fbx")
        mesh_info = None
        for node_output in outputs.values():
            if not isinstance(node_output, dict):
                continue
            for items in node_output.values():
                if not isinstance(items, list):
                    continue
                for item in items:
                    if isinstance(item, dict) and "filename" in item:
                        if Path(item["filename"]).suffix.lower() in _MESH_EXTS:
                            mesh_info = item
                            break
                if mesh_info:
                    break
            if mesh_info:
                break

        if not mesh_info:
            raise ProviderUnavailableError(
                f"ComfyUI concluiu o job 3D mas nenhum arquivo de malha foi encontrado "
                f"nos outputs (esperado no titulado 'save_glb'): {outputs}"
            )

        params = {
            "filename": mesh_info["filename"],
            "subfolder": mesh_info.get("subfolder", ""),
            "type": mesh_info.get("type", "output"),
        }
        try:
            resp = await client.get(f"{self.host}/view", params=params)
            resp.raise_for_status()
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            raise ProviderUnavailableError(f"ComfyUI indisponivel ao baixar a malha gerada: {e}") from e
        except httpx.HTTPStatusError as e:
            raise ProviderUnavailableError(
                f"ComfyUI recusou o download da malha ({e.response.status_code})"
            ) from e

        settings.OUTPUT_DIR_MESHES.mkdir(parents=True, exist_ok=True)
        suffix = Path(mesh_info["filename"]).suffix or ".glb"
        output_path = settings.OUTPUT_DIR_MESHES / f"{uuid.uuid4()}{suffix}"
        output_path.write_bytes(resp.content)
        return str(output_path)

    # --- interface publica (ThreeDProvider) -------------------------------

    async def generate(self, image_bytes: bytes, seed: int | None,
                        octree_resolution: int, export_format: str) -> str:
        logger.info(
            "[ComfyUI] Gerando malha 3D (octree_resolution=%s, seed=%s)...",
            octree_resolution, seed,
        )
        async with httpx.AsyncClient(timeout=30) as client:
            image_filename = await self._upload_image(client, image_bytes)
            workflow = self._build_prompt(image_filename, seed, octree_resolution)
            prompt_id = await self._queue_prompt(client, workflow)
            logger.info("[ComfyUI] Prompt 3D enfileirado (prompt_id=%s), aguardando conclusao...", prompt_id)
            history_entry = await self._poll_history(client, prompt_id)
            glb_path = await self._download_output_mesh(client, history_entry)

        if export_format == "fbx":
            from app.providers.mesh_converter import BlenderMeshConverter, MeshConversionError
            try:
                return BlenderMeshConverter().convert_glb_to_fbx(Path(glb_path))
            except MeshConversionError as e:
                raise ProviderUnavailableError(str(e)) from e

        return glb_path

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.host}/system_stats")
                return resp.status_code == 200
        except (httpx.ConnectError, httpx.TimeoutException):
            return False
