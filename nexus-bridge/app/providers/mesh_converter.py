"""
Conversao GLB -> FBX via Blender headless (subprocess).

## Por que isso existe
Nem o ComfyUI nem o Hunyuan3D exportam .fbx nativamente -- o unico no de
export disponivel no pipeline nativo do ComfyUI-Core e o SaveGLB (.glb).
O formato FBX e proprietario da Autodesk; a unica forma confiavel e de
codigo aberto de gera-lo de verdade (sem reimplementar o parser binario
da Autodesk) e via um programa que ja sabe escrever FBX -- o Blender e
esse programa aqui, rodando sem interface grafica (`--background`).

## IMPORTANTE: Roblox aceita .glb diretamente
Antes de configurar isso, considere: o 3D Importer do Roblox Studio aceita
.fbx, .gltf/.glb E .obj com o MESMO nivel de suporte (multiplos objetos,
hierarquias, texturas PBR -- ver https://create.roblox.com/docs/art/modeling/3d-importer).
Ou seja, pular esta conversao e importar o .glb que o ComfyUI ja gera
direto no Studio funciona igualmente bem, e evita esta dependencia extra
(Blender instalado no host). Use export_format="fbx" só se você
especificamente precisa desse formato (ex: pipeline downstream que só
aceita .fbx).

## Requisitos
Blender instalado no host e no PATH (ou aponte o caminho completo em
BLENDER_EXECUTABLE no .env). Testado com Blender 3.6+/4.x (a API bpy usada
no script abaixo -- bpy.ops.import_scene.gltf / export_scene.fbx -- e
estavel nessas versoes). NAO precisa do Blender Python (bpy) instalado via
pip -- rodamos o executavel completo do Blender como subprocesso, que ja
vem com seu proprio Python embutido.
"""
import logging
import subprocess
import sys
import textwrap
import uuid
from pathlib import Path

from app.config import settings

logger = logging.getLogger("nexus.mesh_converter")


class MeshConversionError(Exception):
    """Levantada quando a conversao GLB->FBX falha (Blender ausente, script com erro, timeout)."""
    pass


# Script executado DENTRO do Blender (--python-expr), nao no processo do
# nexus-bridge -- roda no interpretador Python embutido do Blender, que
# tem o modulo `bpy` disponivel (nao instalavel via pip fora do Blender).
_BLENDER_SCRIPT_TEMPLATE = """
import bpy
import sys

input_path = {input_path!r}
output_path = {output_path!r}

# Limpa a cena padrao (cubo/camera/luz que o Blender cria por default)
bpy.ops.wm.read_factory_settings(use_empty=True)

bpy.ops.import_scene.gltf(filepath=input_path)

bpy.ops.export_scene.fbx(
    filepath=output_path,
    use_selection=False,
    global_scale=1.0,
    apply_unit_scale=True,
    bake_space_transform=True,
    object_types={{'MESH'}},
    mesh_smooth_type='FACE',
    add_leaf_bones=False,
    path_mode='COPY',
    embed_textures=True,
)
print("NEXUS_BRIDGE_FBX_EXPORT_OK")
"""


class BlenderMeshConverter:
    def __init__(self, blender_executable: str | None = None, timeout_s: int | None = None):
        self.blender_executable = blender_executable or settings.BLENDER_EXECUTABLE
        self.timeout_s = timeout_s or settings.BLENDER_TIMEOUT_S

    def convert_glb_to_fbx(self, glb_path: Path) -> str:
        if not glb_path.exists():
            raise MeshConversionError(f"Arquivo GLB de entrada nao encontrado: {glb_path}")

        settings.OUTPUT_DIR_MESHES.mkdir(parents=True, exist_ok=True)
        output_path = settings.OUTPUT_DIR_MESHES / f"{uuid.uuid4()}.fbx"

        script = _BLENDER_SCRIPT_TEMPLATE.format(
            input_path=str(glb_path.resolve()),
            output_path=str(output_path.resolve()),
        )

        cmd = [self.blender_executable, "--background", "--python-expr", script]
        logger.info("[Blender] Convertendo %s -> %s...", glb_path.name, output_path.name)

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=self.timeout_s,
            )
        except FileNotFoundError as e:
            raise MeshConversionError(
                f"Executavel do Blender ('{self.blender_executable}') nao encontrado no PATH. "
                f"Instale o Blender (https://www.blender.org/download/) e/ou defina "
                f"BLENDER_EXECUTABLE no .env com o caminho completo (ex: "
                f"'C:\\\\Program Files\\\\Blender Foundation\\\\Blender 4.2\\\\blender.exe')."
            ) from e
        except subprocess.TimeoutExpired as e:
            raise MeshConversionError(
                f"Conversao GLB->FBX excedeu {self.timeout_s}s (Blender travado ou malha "
                f"grande demais). Ajuste BLENDER_TIMEOUT_S no .env se necessario."
            ) from e

        if "NEXUS_BRIDGE_FBX_EXPORT_OK" not in result.stdout or not output_path.exists():
            raise MeshConversionError(
                f"Conversao GLB->FBX falhou (Blender saiu com codigo {result.returncode}). "
                f"stderr: {result.stderr[-1500:]}"
            )

        logger.info("[Blender] Conversao concluida: %s", output_path)
        return str(output_path)
