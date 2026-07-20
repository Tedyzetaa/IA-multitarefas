"""
Roda contra o SEU container Fooocus real e imprime:
  1. Todos os endpoints/api_names que o Gradio expoe.
  2. Uma tentativa de identificar qual deles corresponde a cadeia
     generate_button -> get_task -> generate_clicked (heuristica pelo
     numero de inputs esperados, que deve bater com len(build_ctrls(...))
     em fooocus_gradio_provider.py).

Uso:
    cd backend
    python tools/discover_fooocus_api.py [http://127.0.0.1:7865]

Depois de identificar o nome certo, cole em FOOOCUS_API_NAME no .env.
"""
import sys

from gradio_client import Client

# build_ctrls() em fooocus_gradio_provider.py produz exatamente 152 campos
# para esta versao do Fooocus (v2.5.5, conferido rodando build_ctrls() localmente).
# A funcao get_task() do webui.py descarta soh o "currentTask" (1 campo) do
# inicio da lista ligada ao generate_button antes de repassar pro worker,
# entao o endpoint certo deve aceitar 152 ou 153 inputs.
EXPECTED_ARG_COUNT_HINT_RANGE = (150, 154)


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7865"
    print(f"Conectando em {host} ...")
    client = Client(host)

    api_info = client.view_api(print_info=False, return_format="dict")
    endpoints = api_info.get("named_endpoints", {}) or {}
    unnamed = api_info.get("unnamed_endpoints", {}) or {}

    print(f"\n{len(endpoints)} endpoints NOMEADOS encontrados:")
    for name, spec in endpoints.items():
        n_inputs = len(spec.get("parameters", []))
        flag = " <-- candidato provavel" if EXPECTED_ARG_COUNT_HINT_RANGE[0] <= n_inputs <= EXPECTED_ARG_COUNT_HINT_RANGE[1] else ""
        print(f"  {name:35s} inputs={n_inputs}{flag}")

    print(f"\n{len(unnamed)} endpoints SEM NOME (acessiveis por indice fn_index):")
    for idx, spec in unnamed.items():
        n_inputs = len(spec.get("parameters", []))
        flag = " <-- candidato provavel" if EXPECTED_ARG_COUNT_HINT_RANGE[0] <= n_inputs <= EXPECTED_ARG_COUNT_HINT_RANGE[1] else ""
        print(f"  fn_index={idx:5s} inputs={n_inputs}{flag}")

    print(
        "\nProximo passo: pegue o nome (ou fn_index) marcado como candidato "
        "provavel, defina FOOOCUS_API_NAME=<nome> no .env, e rode um job de "
        "teste simples (so prompt, sem loras/inpaint) para confirmar antes "
        "de usar em producao. Se nao houver candidato claro, rode com "
        "print_info=True (edite este script) para ver a assinatura completa "
        "de parametros de cada endpoint e comparar manualmente com "
        "modules/async_worker.py::AsyncTask.__init__."
    )


if __name__ == "__main__":
    main()
