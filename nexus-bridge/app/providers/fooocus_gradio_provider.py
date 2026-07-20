"""
Provider que fala com o Fooocus NATIVO (webui.py / Gradio), sem passar por
nenhuma API REST intermediaria (Fooocus-API), usando o `gradio_client` para
disparar exatamente a mesma funcao que o botao "Generate" da interface
disparia -- preservando 100% das funcoes avancadas do Fooocus (styles,
LoRAs, Image Prompt/ControlNet, inpaint/outpaint, upscale/vary, refiner,
sampler/scheduler, ADM guidance, FreeU etc).

## Por que gradio_client e nao REST
O container `ghcr.io/lllyasviel/fooocus` sobe soh `entry_with_update.py
--listen`, que expoe uma app Gradio pura -- nao ha rotas `/v1/generation/...`
(essas sao do projeto de terceiros "Fooocus-API", que NAO esta rodando
aqui). Toda app Gradio, no entanto, expoe automaticamente um endpoint de
fila que o pacote `gradio_client` sabe consumir, chamando a mesma funcao
Python vinculada ao componente `generate_button` no `webui.py`.

## De onde vem a ordem dos campos abaixo
Fooocus NAO documenta essa lista em lugar nenhum -- ela foi extraida
diretamente do parsing feito em `modules/async_worker.py::AsyncTask.__init__`,
que faz `args.pop(0)` (via reverse()+pop()) campo a campo. Essa e a fonte da
verdade mais confiavel que existe: se ela mudar, o parsing do worker tambem
muda, entao qualquer atualizacao do Fooocus que quebre isso vai quebrar a
propria UI dele tambem (ou seja, a ordem tende a ser estavel entre releases
menores). Version de referencia: Fooocus v2.5.5 (a que voce enviou).

## O que falta validar ao vivo (nao da pra confirmar por analise estatica)
1. O NOME do endpoint/fn_index exposto pelo Gradio para a cadeia
   `generate_button.click(...).then(fn=get_task, ...).then(fn=generate_clicked, ...)`.
   Nenhum `api_name=` explicito existe no webui.py, entao o Gradio usa
   nomes automaticos (`/lambda`, `/lambda_1`, ... ou indices numericos) --
   isso varia entre instalacoes/versoes do Gradio. Rode
   `python tools/discover_fooocus_api.py` (incluido) contra o SEU container
   pra descobrir o `api_name` real e cole o resultado em FOOOCUS_API_NAME
   no .env. Ate isso ser confirmado, o client tenta uma lista de candidatos
   comuns e falha com um erro claro se nenhum bater.
2. Os componentes de mascara/inpaint (`tool='sketch'`, Gradio 3.41.2) trocam
   um dict {"image":..., "mask":...}. Mantive o formato mais comum pra essa
   versao, mas teste um job de inpaint real antes de confiar em producao.
"""
import asyncio
import base64
import logging
import tempfile
from typing import Optional

from gradio_client import Client  # gradio_client < 0.8 (compativel com gradio 3.41.2 do servidor):
# arquivos sao passados como caminho de string puro, sem o wrapper handle_file()
# (esse wrapper so existe em gradio_client >= 0.8, para o formato FileData do Gradio 4.x).

from app.config import settings
from app.models import GenerateRequest
from app.providers.base import ImageProvider, ProviderUnavailableError, ResourceExhaustedError

logger = logging.getLogger("nexus.fooocus_gradio")

OOM_SIGNATURES = (
    "cuda out of memory", "cuda error", "outofmemoryerror",
    "not enough memory", "alloc_tensor",
)

# Candidatos tentados em ordem ate um funcionar (ver ponto 1 do docstring).
# FOOOCUS_API_NAME no .env, se definido, sempre tem prioridade sobre esta lista.
_CANDIDATE_API_NAMES = ["/generate_clicked", "/lambda_3", "/lambda_2", "/lambda_1"]

# Estilo que dispara a expansao de prompt via GPT-2 interno do Fooocus.
# Excluido sempre: quem faz esse papel agora e o Ollama (ver ollama_provider.py).
_GPT2_EXPANSION_STYLE = "Fooocus V2"

DEFAULT_MAX_LORA_SLOTS = 5          # modules/config.py: default_max_lora_number
DEFAULT_CONTROLNET_SLOTS = 4        # modules/config.py: default_controlnet_image_count
DEFAULT_ENHANCE_TABS = 3            # modules/config.py: default_enhance_tabs

_IP_TYPE_DEFAULTS = {
    # tipo: (stop_at, weight)  -- modules/flags.py: default_parameters
    "ImagePrompt": (0.5, 0.6),
    "FaceSwap": (0.9, 0.75),
    "PyraCanny": (0.5, 1.0),
    "CPDS": (0.5, 1.0),
}


def _format_aspect_ratio(resolution: str) -> str:
    """
    Replica modules/config.py::add_ratio(). O componente aspect_ratios_selection
    e um gr.Radio cujas choices/value NAO sao "1152*896" cru, e sim esse label
    decorado com HTML -- enviar a string crua nao bate com nenhuma choice valida.
    """
    import math
    a, b = resolution.replace("*", " ").split(" ")[:2]
    a, b = int(a), int(b)
    g = math.gcd(a, b)
    return f'{a}×{b} <span style="color: grey;"> \u2223 {a // g}:{b // g}</span>'


def _b64_to_tempfile(b64_data: str, suffix: str = ".png") -> str:
    raw = base64.b64decode(b64_data)
    fd = tempfile.NamedTemporaryFile(delete=False, suffix=suffix, dir=str(settings.OUTPUT_DIR))
    fd.write(raw)
    fd.close()
    return fd.name


def build_ctrls(refined_prompt: str, req: GenerateRequest, steps: int, resolution: str) -> list:
    """
    Monta a lista posicional EXATA consumida por AsyncTask (ver docstring
    do modulo). Cada bloco abaixo esta comentado com o nome do atributo
    que o async_worker.py atribui a partir dele, na mesma ordem.
    """
    ctrls: list = []

    # generate_image_grid
    ctrls += [False]

    # prompt, negative_prompt, style_selections
    style_selections = [s for s in req.style_selections if s != _GPT2_EXPANSION_STYLE]
    ctrls += [refined_prompt, req.negative_prompt or "", style_selections]

    # performance_selection, aspect_ratios_selection, image_number, output_format,
    # image_seed, read_wildcards_in_order, sharpness, guidance_scale (cfg_scale)
    seed = req.seed if req.seed is not None else -1  # -1 = worker sorteia
    ctrls += [
        "Speed", _format_aspect_ratio(resolution), 1, "png", seed,
        False,
        req.sharpness if req.sharpness is not None else 2.0,
        req.guidance_scale if req.guidance_scale is not None else 7.0,
    ]

    # base_model_name, refiner_model_name, refiner_switch
    ctrls += [
        req.base_model_name or settings.FOOOCUS_BASE_MODEL,
        req.refiner_model_name or "None",
        req.refiner_switch if req.refiner_switch is not None else 0.8,
    ]

    # loras: (enabled, name, weight) x DEFAULT_MAX_LORA_SLOTS -- preenche com "None"
    # os slots que o usuario nao especificou.
    loras = list(req.loras)[:DEFAULT_MAX_LORA_SLOTS]
    while len(loras) < DEFAULT_MAX_LORA_SLOTS:
        loras.append(None)
    for lora in loras:
        if lora is None:
            ctrls += [True, "None", 1.0]
        else:
            ctrls += [lora.enabled, lora.name, lora.weight]

    # --- decide o "modo" ativo: uov (vary/upscale) | inpaint | ip (image prompt) ---
    # Sao mutuamente exclusivos no Fooocus (current_tab so tem um valor).
    # Prioridade se mais de um vier preenchido: inpaint/outpaint > upscale/vary > image_prompt.
    has_inpaint = req.inpaint is not None or req.outpaint is not None
    has_uov = req.upscale_vary is not None
    has_ip = len(req.image_prompts) > 0

    if has_inpaint:
        current_tab = "inpaint"
    elif has_uov:
        current_tab = "uov"
    elif has_ip:
        current_tab = "ip"
    else:
        current_tab = "uov"  # irrelevante quando input_image_checkbox=False

    input_image_checkbox = has_inpaint or has_uov or has_ip

    # input_image_checkbox, current_tab
    ctrls += [input_image_checkbox, current_tab]

    # uov_method, uov_input_image
    if has_uov:
        uov_path = _b64_to_tempfile(req.upscale_vary.input_image_base64)
        ctrls += [req.upscale_vary.method, uov_path]
    else:
        ctrls += ["Disabled", None]

    # outpaint_selections, inpaint_input_image, inpaint_additional_prompt, inpaint_mask_image_upload
    if req.outpaint is not None:
        outpaint_img = _b64_to_tempfile(req.outpaint.input_image_base64)
        ctrls += [
            list(req.outpaint.directions),
            {"image": outpaint_img, "mask": None},
            "",
            None,
        ]
    elif req.inpaint is not None:
        inpaint_img = _b64_to_tempfile(req.inpaint.input_image_base64)
        mask_file = _b64_to_tempfile(req.inpaint.mask_base64) if req.inpaint.mask_base64 else None
        ctrls += [
            [],
            {"image": inpaint_img, "mask": mask_file if mask_file else None},
            req.inpaint.additional_prompt or "",
            mask_file if mask_file else None,
        ]
    else:
        ctrls += [[], None, "", None]

    # disable_preview, disable_intermediate_results, disable_seed_increment, black_out_nsfw
    ctrls += [False, False, False, False]

    # adm_scaler_positive, adm_scaler_negative, adm_scaler_end, adaptive_cfg, clip_skip
    ctrls += [1.5, 0.8, 0.3, 7.0, 2]

    # sampler_name, scheduler_name, vae_name
    ctrls += [settings.FOOOCUS_SAMPLER, settings.FOOOCUS_SCHEDULER, "Default (model)"]

    # overwrite_step, overwrite_switch, overwrite_width, overwrite_height,
    # overwrite_vary_strength, overwrite_upscale_strength
    #
    # IMPORTANTE: o Fooocus nativo nao tem um campo "steps" direto -- steps e
    # DERIVADO de performance_selection (Speed=30, Quality=60, Extreme Speed=8...).
    # `overwrite_step` e o unico jeito de forcar um numero exato, e e o que o
    # resource_manager.py usa para reduzir steps em retries por OOM. Repassamos
    # o `steps` recebido aqui; -1 (comportamento antigo) faria o retry por OOM
    # nunca reduzir nada de verdade.
    ctrls += [steps, -1, -1, -1, -1, -1]

    # mixing_image_prompt_and_vary_upscale, mixing_image_prompt_and_inpaint
    ctrls += [False, False]

    # debugging_cn_preprocessor, skipping_cn_preprocessor, canny_low_threshold, canny_high_threshold
    ctrls += [False, False, 64, 128]

    # refiner_swap_method, controlnet_softness
    ctrls += ["joint", 0.25]

    # freeu_enabled, freeu_b1, freeu_b2, freeu_s1, freeu_s2
    ctrls += [False, 1.01, 1.02, 0.99, 0.95]

    # debugging_inpaint_preprocessor, inpaint_disable_initial_latent, inpaint_engine,
    # inpaint_strength, inpaint_respective_field, inpaint_advanced_masking_checkbox,
    # invert_mask_checkbox, inpaint_erode_or_dilate
    inpaint_engine = req.inpaint.engine if req.inpaint else "v2.6"
    inpaint_strength = req.inpaint.strength if req.inpaint else 1.0
    inpaint_field = req.inpaint.respective_field if req.inpaint else 0.618
    ctrls += [False, False, inpaint_engine, inpaint_strength, inpaint_field, False, False, 0]

    # save_final_enhanced_image_only (assume --disable-image-log NAO setado no container)
    ctrls += [False]

    # save_metadata_to_images, metadata_scheme (assume --disable-metadata NAO setado)
    ctrls += [True, "fooocus"]

    # image prompt / controlnet: (cn_img, cn_stop, cn_weight, cn_type) x DEFAULT_CONTROLNET_SLOTS
    ip_items = list(req.image_prompts)[:DEFAULT_CONTROLNET_SLOTS]
    while len(ip_items) < DEFAULT_CONTROLNET_SLOTS:
        ip_items.append(None)
    for ip in ip_items:
        if ip is None:
            ctrls += [None, 0.5, 0.6, "ImagePrompt"]
        else:
            ip_path = _b64_to_tempfile(ip.image_base64)
            default_stop, default_weight = _IP_TYPE_DEFAULTS[ip.type]
            ctrls += [
                ip_path,
                ip.stop_at if ip.stop_at is not None else default_stop,
                ip.weight if ip.weight is not None else default_weight,
                ip.type,
            ]

    # debugging_dino, dino_erode_or_dilate, debugging_enhance_masks_checkbox
    ctrls += [False, 0, False]

    # enhance_input_image, enhance_checkbox, enhance_uov_method,
    # enhance_uov_processing_order, enhance_uov_prompt_type
    # (Enhance/Detail-Fix tab nao esta no escopo pedido -- fica sempre desligado)
    ctrls += [None, False, "Disabled", "Before First Enhancement", "Original Prompts"]

    # enhance_ctrls: 16 campos x DEFAULT_ENHANCE_TABS, todos desabilitados
    for _ in range(DEFAULT_ENHANCE_TABS):
        ctrls += [
            False,   # enhance_enabled
            "",      # enhance_mask_dino_prompt_text
            "",      # enhance_prompt
            "",      # enhance_negative_prompt
            "sam",   # enhance_mask_model
            "full",  # enhance_mask_cloth_category
            "vit_b", # enhance_mask_sam_model
            0.25,    # enhance_mask_text_threshold
            0.3,     # enhance_mask_box_threshold
            0,       # enhance_mask_sam_max_detections
            False,   # enhance_inpaint_disable_initial_latent
            "v2.6",  # enhance_inpaint_engine
            1.0,     # enhance_inpaint_strength
            0.618,   # enhance_inpaint_respective_field
            0,       # enhance_inpaint_erode_or_dilate
            False,   # enhance_mask_invert
        ]

    return ctrls


class FooocusGradioProvider(ImageProvider):
    def __init__(self, host: str = None):
        self.host = host or settings.FOOOCUS_HOST
        self._client: Optional[Client] = None

    def _get_client(self) -> Client:
        if self._client is None:
            self._client = Client(self.host)
        return self._client

    async def generate(self, refined_prompt: str, req: GenerateRequest,
                        steps: int, resolution: str) -> str:
        ctrls = build_ctrls(refined_prompt, req, steps, resolution)
        try:
            return await asyncio.to_thread(self._submit, ctrls)
        except ResourceExhaustedError:
            raise
        except ProviderUnavailableError:
            raise
        except Exception as e:
            msg = str(e).lower()
            if any(sig in msg for sig in OOM_SIGNATURES):
                raise ResourceExhaustedError(f"Fooocus OOM: {e}") from e
            raise ProviderUnavailableError(f"Fooocus (gradio_client) erro: {e}") from e

    def _submit(self, ctrls: list) -> str:
        client = self._get_client()
        api_name = settings.FOOOCUS_API_NAME or None
        names_to_try = [api_name] if api_name else _CANDIDATE_API_NAMES

        last_error = None
        for name in names_to_try:
            try:
                result = client.predict(*ctrls, api_name=name)
                return self._extract_path(result)
            except Exception as e:
                last_error = e
                logger.warning(f"Fooocus gradio_client: api_name={name} falhou: {e}")
                continue

        raise ProviderUnavailableError(
            "Nao foi possivel encontrar o endpoint de geracao do Fooocus. "
            "Rode tools/discover_fooocus_api.py contra o seu container e "
            f"defina FOOOCUS_API_NAME no .env. Ultimo erro: {last_error}"
        )

    @staticmethod
    def _extract_path(result) -> str:
        # generate_clicked retorna a galeria final; formato tipico do
        # gradio_client: lista de dicts com 'image'/'name' ou tuplas (path, caption).
        if isinstance(result, (list, tuple)) and len(result) > 0:
            item = result[-1]
            if isinstance(item, dict):
                return item.get("image", {}).get("path") if isinstance(item.get("image"), dict) \
                    else item.get("name") or item.get("path")
            if isinstance(item, (list, tuple)):
                return item[0]
            return str(item)
        if isinstance(result, dict):
            return result.get("path") or result.get("name")
        raise ProviderUnavailableError(f"Formato de resultado inesperado do Fooocus: {result!r}")

    async def health_check(self) -> bool:
        try:
            await asyncio.to_thread(self._get_client)
            return True
        except Exception:
            return False
