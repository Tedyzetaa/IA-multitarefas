"""
Garante que o ctranslate2 (faster-whisper) encontre as DLLs de CUDA no Windows.

POR QUE add_dll_directory SOZINHO NAO BASTA
-------------------------------------------
O ctranslate2 nao linka o cuBLAS/cuDNN estaticamente: ele chama LoadLibrary
em tempo de execucao, pelo nome base ("cublas64_12.dll"). Essa chamada usa a
ordem de busca PADRAO do Windows (pasta do .exe, System32, diretorio atual,
PATH) -- e NAO os diretorios registrados com os.add_dll_directory(), que so
valem para quem carrega com a flag LOAD_LIBRARY_SEARCH_USER_DIRS (o import de
modulos de extensao do CPython, por exemplo).

A solucao que funciona em qualquer caso: PRE-CARREGAR as DLLs pelo caminho
ABSOLUTO com ctypes. Uma vez carregado, o Windows indexa o modulo pelo nome
base, e o LoadLibrary("cublas64_12.dll") posterior do ctranslate2 recebe o
handle do que ja esta na memoria, sem busca nenhuma.

De quebra tambem registramos as pastas (add_dll_directory) e as colocamos no
PATH do processo, que cobre os caminhos alternativos.

Ordem importa: o cuDNN e pre-carregado a partir de nvidia/cudnn/bin ANTES de
qualquer coisa vinda de torch/lib, para que a build >= 9.3 (com
cudnnGetLibConfig) ganhe do cudnn64_9.dll 9.1.0.70 embutido no torch.

USO
---
    from app.providers.cuda_dlls import ensure_cuda_dlls
    ensure_cuda_dlls()   # idempotente; no-op fora do Windows
"""
import ctypes
import logging
import os
import site
import sys
import sysconfig
from pathlib import Path

logger = logging.getLogger("nexus.cuda_dlls")

LOAD_WITH_ALTERED_SEARCH_PATH = 0x00000008

# Ordem de prioridade das pastas onde procurar cada DLL.
_CANDIDATE_SUBDIRS = (
    ("nvidia", "cudnn", "bin"),
    ("nvidia", "cublas", "bin"),
    ("nvidia", "cuda_runtime", "bin"),
    ("torch", "lib"),          # fallback: o torch cu12x embute cuBLAS e cuDNN
)

# Ordem de carga importa: dependencias primeiro.
_DLLS = (
    "cudart64_12.dll",
    "cublasLt64_12.dll",
    "cublas64_12.dll",
    "cudnn64_9.dll",
)

_applied: dict[str, str] | None = None


def _site_packages_dirs() -> list[str]:
    dirs: list[str] = []
    try:
        dirs.append(sysconfig.get_paths()["purelib"])
    except Exception:  # noqa: BLE001
        pass
    try:
        dirs.extend(site.getsitepackages())
    except Exception:  # noqa: BLE001
        pass
    out, seen = [], set()
    for d in dirs:
        if d and d not in seen and Path(d).is_dir():
            seen.add(d)
            out.append(d)
    return out


def _candidate_dirs() -> list[Path]:
    bases = _site_packages_dirs()
    dirs: list[Path] = []
    for parts in _CANDIDATE_SUBDIRS:
        for base in bases:
            d = Path(base, *parts)
            if d.is_dir():
                dirs.append(d)
                break
    return dirs


def ensure_cuda_dlls() -> dict[str, str]:
    """Pre-carrega as DLLs CUDA necessarias ao ctranslate2. Idempotente."""
    global _applied
    if _applied is not None:
        return _applied
    if sys.platform != "win32":
        _applied = {}
        return _applied

    dirs = _candidate_dirs()
    if not dirs:
        logger.warning(
            "Nenhuma pasta de DLL CUDA encontrada na venv (nvidia/*/bin, torch/lib). "
            "Instale 'nvidia-cublas-cu12' e 'nvidia-cudnn-cu12>=9.3.0' ou use "
            "WHISPER_DEVICE=cpu."
        )
        _applied = {}
        return _applied

    # 1) Registra as pastas e poe no PATH (cobre buscas que nao passam pelo preload).
    for d in dirs:
        try:
            os.add_dll_directory(str(d))
        except OSError as exc:
            logger.debug("add_dll_directory(%s) falhou: %s", d, exc)
    os.environ["PATH"] = os.pathsep.join(
        [str(d) for d in dirs] + [os.environ.get("PATH", "")]
    )

    # 2) Pre-carrega cada DLL pelo caminho absoluto -- este e o passo que resolve.
    loaded: dict[str, str] = {}
    for name in _DLLS:
        for d in dirs:
            path = d / name
            if not path.exists():
                continue
            try:
                ctypes.WinDLL(str(path), winmode=LOAD_WITH_ALTERED_SEARCH_PATH)
                loaded[name] = str(path)
                logger.info("DLL pre-carregada: %s", path)
            except OSError as exc:
                logger.warning("Falha ao pre-carregar %s: %s", path, exc)
            break  # primeira ocorrencia na ordem de prioridade ganha

    faltando = [n for n in ("cublas64_12.dll", "cudnn64_9.dll") if n not in loaded]
    if faltando:
        logger.warning(
            "DLLs CUDA nao encontradas: %s. Procurei em: %s",
            ", ".join(faltando), ", ".join(str(d) for d in dirs),
        )

    _applied = loaded
    return loaded
