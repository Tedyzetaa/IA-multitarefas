"""
Diagnostico: descobre por que o ctranslate2 (faster-whisper) nao carrega o
cublas64_12.dll nesta venv.

Uso (na raiz do projeto, com a venv ATIVA):
    python diag_whisper_cuda.py

Nao altera nada: so procura DLLs, tenta carrega-las e tenta subir o WhisperModel.
Cole a saida inteira.
"""
import ctypes
import os
import site
import sys
import sysconfig
from pathlib import Path

LOAD_WITH_ALTERED_SEARCH_PATH = 0x00000008

DLLS = [
    "cudart64_12.dll",
    "cublasLt64_12.dll",
    "cublas64_12.dll",
    "cudnn64_9.dll",
]

CANDIDATE_SUBDIRS = [
    ("nvidia", "cudnn", "bin"),
    ("nvidia", "cublas", "bin"),
    ("nvidia", "cuda_runtime", "bin"),
    ("torch", "lib"),
]


def site_packages_dirs():
    dirs = []
    try:
        dirs.append(sysconfig.get_paths()["purelib"])
    except Exception as exc:
        print("  ! sysconfig falhou:", exc)
    try:
        dirs.extend(site.getsitepackages())
    except Exception as exc:
        print("  ! site.getsitepackages falhou:", exc)
    out, seen = [], set()
    for d in dirs:
        if d and d not in seen and Path(d).is_dir():
            seen.add(d)
            out.append(d)
    return out


def main() -> int:
    print("=" * 70)
    print("PYTHON")
    print("=" * 70)
    print("executable :", sys.executable)
    print("version    :", sys.version.replace("\n", " "))
    print("platform   :", sys.platform)

    print()
    print("=" * 70)
    print("SITE-PACKAGES")
    print("=" * 70)
    bases = site_packages_dirs()
    for b in bases:
        print(" -", b)

    print()
    print("=" * 70)
    print("PASTAS CANDIDATAS")
    print("=" * 70)
    existing_dirs = []
    for parts in CANDIDATE_SUBDIRS:
        rel = "\\".join(parts)
        found = False
        for base in bases:
            d = Path(base, *parts)
            if d.is_dir():
                n = len(list(d.glob("*.dll")))
                print(f"  [OK]    {d}  ({n} .dll)")
                existing_dirs.append(d)
                found = True
                break
        if not found:
            print(f"  [FALTA] {rel}  -- nao existe em nenhum site-packages")

    print()
    print("=" * 70)
    print("ONDE ESTA CADA DLL")
    print("=" * 70)
    located = {}
    for name in DLLS:
        hits = [d / name for d in existing_dirs if (d / name).exists()]
        if hits:
            located[name] = hits[0]
            for h in hits:
                print(f"  [OK]    {name}: {h}")
        else:
            print(f"  [FALTA] {name}: nao encontrado nas pastas acima")

    print()
    print("=" * 70)
    print("VERSOES DOS PACOTES")
    print("=" * 70)
    for pkg in ("ctranslate2", "faster-whisper", "torch",
                "nvidia-cublas-cu12", "nvidia-cudnn-cu12"):
        try:
            from importlib.metadata import version
            print(f"  {pkg:20s} {version(pkg)}")
        except Exception:
            print(f"  {pkg:20s} (nao instalado)")

    print()
    print("=" * 70)
    print("TENTANDO PRE-CARREGAR AS DLLs (caminho absoluto)")
    print("=" * 70)
    for d in existing_dirs:
        try:
            os.add_dll_directory(str(d))
        except OSError as exc:
            print(f"  ! add_dll_directory({d}) falhou: {exc}")
    for name in DLLS:
        path = located.get(name)
        if path is None:
            print(f"  [PULADO] {name}")
            continue
        try:
            ctypes.WinDLL(str(path), winmode=LOAD_WITH_ALTERED_SEARCH_PATH)
            print(f"  [OK]     {name} carregada de {path.parent}")
        except OSError as exc:
            print(f"  [ERRO]   {name}: {exc}")

    print()
    print("=" * 70)
    print("TESTE REAL: ctranslate2 + WhisperModel")
    print("=" * 70)
    try:
        import ctranslate2
        print("  ctranslate2 importado. CUDA devices:",
              ctranslate2.get_cuda_device_count())
    except Exception as exc:
        print("  ! import ctranslate2 falhou:", repr(exc))
        return 1

    try:
        from faster_whisper import WhisperModel
        model = WhisperModel("small", device="cuda", compute_type="float16")
        print("  [OK] WhisperModel('small', cuda, float16) carregou sem erro.")
        del model
    except Exception as exc:
        print("  [ERRO] WhisperModel em CUDA:", repr(exc))
        try:
            from faster_whisper import WhisperModel
            WhisperModel("small", device="cpu", compute_type="int8")
            print("  [OK] Em CPU/int8 funciona -- o problema e so das DLLs CUDA.")
        except Exception as exc2:
            print("  [ERRO] Ate em CPU falhou:", repr(exc2))
        return 1

    print()
    print("Tudo certo aqui. Se o servidor ainda falhar, o subprocesso do worker")
    print("nao esta usando este mesmo python:", sys.executable)
    return 0


if __name__ == "__main__":
    sys.exit(main())
