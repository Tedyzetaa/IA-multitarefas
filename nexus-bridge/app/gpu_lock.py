import asyncio

# Lock global para serializar uso de VRAM em modelos pesados locais.
# A RTX 3050 6GB exige exclusão mútua entre XTTS, Ollama e Fooocus para
# evitar OOM e conflitos de CUDA/cuDNN.
gpu_vram_lock = asyncio.Lock()
