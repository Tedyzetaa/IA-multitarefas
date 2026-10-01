"""
Constantes fixas do pipeline de video (LTX-Video via ComfyUI).

Ficam isoladas deste modulo (em vez de config.py) de proposito: NAO sao
configuraveis via .env/Settings e NAO tem correspondente em nenhum schema
de request (models.py). O objetivo e estrutural -- o sistema nunca deve
depender do usuario (ou de um client de API mal-intencionado) para digitar
um prompt negativo decente. Se em algum momento isso precisar virar
configuravel por ambiente, mova para config.py com um default igual a este
valor; nunca exponha como campo em GenerateRequest/VideoGenerateRequest.
"""

NEGATIVE_PROMPT_DEFAULT = (
    "human, person, people, hand, hands, arm, arms, finger, fingers, "
    "face, body part, model, worst quality, low quality, blurry, "
    "deformed, morphing, warping, changing shape, distorted label, "
    "distorted logo, inconsistent object, extra objects, text artifacts, "
    "watermark, jittery, flickering"
)
