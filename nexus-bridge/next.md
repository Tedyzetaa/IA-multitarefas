# PAPEL
Você é um engenheiro sênior (nível big tech) especialista em Python/FastAPI, pipelines de áudio/TTS (XTTS v2, Whisper), LLMs locais (Ollama) e UX em Next.js/React/Tailwind. Vou anexar dois projetos. Analise o código real antes de propor qualquer coisa, implemente as melhorias abaixo e verifique com testes o que for possível. Diga explicitamente o que você NÃO conseguiu executar ou validar.

# PROJETOS ANEXOS
1. nexus-bridge (backend FastAPI, Windows, Python 3.11): orquestra Ollama, Fooocus/ComfyUI (imagem/vídeo) e dublagem local. Fila com worker único (asyncio.Queue).
2. ollama-web (frontend Next.js 14 + React 18 + Tailwind, TypeScript strict): UI estilo Claude.ai. O app/page.tsx atual NÃO está no zip; só a versão antiga dentro de appfront.zip (usa <AudioDubber /> quando activeMode === "audio").

Hardware alvo: notebook com RTX 3050 6GB de VRAM, 16GB de RAM. Nunca deixar dois modelos pesados na VRAM ao mesmo tempo (XTTS + Ollama 7B + Fooocus/Comfy).

# FLUXO ATUAL DE DUBLAGEM
Áudio (mp3/wav/m4a) -> Whisper (faster-whisper, processo isolado por causa de conflito de cuDNN) -> Ollama traduz en->pt -> XTTS v2 (coqui-tts 0.27.5) clona a voz do próprio áudio original (ou de um áudio de referência opcional).
Arquivos principais: app/providers/translation_dubbing_provider.py, xtts_provider.py, whisper_stt.py, ollama_provider.py, app/workers/whisper_worker.py, app/main.py, app/services/orchestrator.py, app/queue_manager.py. Front: components/AudioDubber.tsx, hooks/useAudioDubbing.ts, lib/nexusBridge.ts, lib/types.ts.

# PROBLEMA PRINCIPAL
A voz dublada sai "robótica". Abaixo estão as causas que identifiquei lendo o código do coqui-tts 0.27.5 (confirme por conta própria):
1. Referência crua e curta: por padrão o XttsConfig usa max_ref_len=10 e gpt_cond_len=12, então só os ~10 s iniciais do arquivo entram na clonagem (frequentemente intro, música, silêncio ou ruído). A referência é em inglês e o texto em português (sotaque e prosódia achatados).
2. O Synthesizer de alto nível divide em sentenças (pysbd) e cola tudo com PAD_SILENCE_SAMPLES=10000 amostras de zero (~0,42 s a 24 kHz), fixo, sem crossfade. O ritmo fica metronômico.
3. Tradução ruim para fala: o modelo do .env é um custom "jarvis:latest" (o exemplo usa qwen2.5-coder), nenhum deles é modelo de tradução. O prompt passa códigos crus ("pt-BR"), sem temperatura baixa, e pode voltar preâmbulo ("Claro! Aqui está…") que o TTS leria. Textos longos estouram num_ctx=2048 e saem truncados sem erro. Whisper transcreve tudo como um bloco (descarta timestamps).
4. Parâmetros de inferência padrão (temperature 0.85, repetition_penalty 2.0 no config), nenhum controle. O limite de caracteres do XTTS em pt é 203, e o texto em bloco degrada a prosódia.
5. Sem pós-processamento: saída 24 kHz sem nivelamento nem corte de silêncio nas pontas.

# PROBLEMAS DE CONFIABILIDADE
- Os endpoints /api/v1/dubbing/process (<10MB), /preview e /synthesize chamam os providers direto, FORA da fila, e podem rodar junto com jobs de Fooocus/Comfy, disputando VRAM. É uma causa provável do "processo fecha sozinho" descrito em need-fix.md (crash nativo de CUDA sem traceback).
- whisper_stt._resolve_device_compute importa torch só para detectar CUDA, inclusive no worker "isolado", o que pode reintroduzir o conflito de cuDNN.
- XTTS carrega e descarrega a cada requisição (~2 GB).
- requirements.txt pina nvidia-cudnn-cu12>=9.3.0 junto com torch==2.5.1 (que pede 9.1.0.70 em algumas plataformas); reavaliar se ainda é necessário com o Whisper isolado.
- O zip do backend contém __pycache__, .bak, backend.patch e um .env com chave real de API (ElevenLabs). Trate como comprometida: nunca a reproduza, recomende rotação e .gitignore.
- Sessões de preview ficam em memória (_SESSIONS); aceitável localmente, mas documente.
- Existe um teste que já falhava antes: test_translation_dubbing_full_pipeline (mocka whisper_stt.transcribe, mas o código chama transcribe_isolated; e asserta unload_whisper, que não é mais chamado).

# O QUE IMPLEMENTAR (BACKEND)
A) app/audio/voice_prep.py (numpy/scipy, sem torch): decodificar áudio (soundfile -> ffmpeg se disponível), converter para mono 22,05 kHz, aplicar passa-altas de 70 Hz, detectar fala com limiar adaptativo (piso de ruído estimado + faixa dinâmica), escolher os melhores ~15 s (máx. 20 s) de fala contígua, normalizar (RMS -20 dBFS, pico <= -1 dBFS) e devolver métricas e avisos legíveis (pouca fala <6 s, SNR <15 dB, clipping >0,5%). Rejeitar com erro claro áudio vazio, silêncio ou ruído indistinguível da fala. Limitação assumida: não separa música nem detecta 2+ falantes.
B) app/audio/text_prep.py: limpar markdown/emoji/URLs, remover preâmbulos de LLM sem cortar "Claro que sim…", dividir em trechos de ~80% do limite do XTTS por idioma (pt=203), agrupar frases curtas, quebrar frases longas em vírgulas, respeitar abreviações (Dr., Sr.), e atribuir pausa por pontuação/parágrafo com jitter sutil (~±12%).
C) app/audio/postprocess.py: aparar silêncio nas pontas, juntar com pausas próprias e crossfade, passa-altas de 60 Hz, nivelamento por RMS só nas regiões com fala, limitador suave.
D) xtts_provider: nova synthesize_chunks() que usa tts.synthesizer.tts_model.get_conditioning_latents(...) (cache por arquivo+mtime) e xtts.inference(...) diretamente, com presets (fast/balanced/max), temperature configurável, speed (0.7–1.4), seed reprodutível e várias tentativas por trecho, escolhendo o take com duração plausível (7–26 caracteres/s). Manter a assinatura antiga de synthesize() (usada pelo fluxo de dublagem) e fazê-la usar a referência preparada, com fallback para o arquivo cru se o preparo falhar. Adicionar schedule_idle_unload (XTTS_IDLE_UNLOAD_S, padrão 300 s) e unload().
   Valores iniciais sugeridos (NÃO validados, exigem A/B de ouvido): temperature 0.70–0.72, repetition_penalty 5.0, top_p 0.85, top_k 50, referência de até 20 s (gpt_cond_len 18, chunk 6).
E) app/gpu_lock.py: asyncio.Lock global; a fila e TODOS os endpoints diretos de dublagem/TTS devem usar "async with gpu_lock". O orchestrator deve descarregar o XTTS antes de jobs de imagem/vídeo e o Ollama antes de jobs de TTS.
F) Tradução (ollama_provider.translate_text): nomes de idioma por extenso ("Brazilian Portuguese (pt-BR)"), prompt de tradutor de dublagem (fala natural, frases curtas, manter pontuação, escrever números/símbolos por extenso, saída somente com a tradução), temperature 0.2, num_ctx >= 4096, tradução em lotes de ~1200 caracteres em fronteira de sentença e limpeza da saída. Documentar no README que se deve usar um modelo instruct multilíngue dedicado (TRANSLATION_OLLAMA_MODEL), e não o modelo "jarvis" nem coder.
G) Whisper: detectar CUDA por ctranslate2.get_cuda_device_count() (sem importar torch), beam_size=5, condition_on_previous_text=False. Como evolução, guardar segmentos com timestamps para dublagem sincronizada (traduzir por segmento com orçamento de duração, usar o parâmetro speed do XTTS com limites 0.85–1.25 e, opcionalmente, separar fundo com Demucs).
H) Novo estúdio de TTS (texto + referência -> áudio, SEM Whisper e SEM tradução):
   - Biblioteca de vozes em disco (voices/<uuid32>/reference.wav + meta.json), com validação de id para evitar path traversal.
   - Endpoints: POST/GET /api/v1/voices, PATCH/DELETE /api/v1/voices/{id}, GET /api/v1/voices/{id}/sample, POST /api/v1/tts (job na fila, kind="tts").
   - Model Job ganha progress (0–1) e progress_detail; JobStatus ganha generating_tts.
   - TTSRequest: text (<=20000), language, voice_id, preset, speed, expressiveness (mapeia para temperature), seed.
I) Testes: unidade para text_prep/voice_prep/postprocess/voice_store, e integração da API com XTTS mockado (sintetizador de seno em 24 kHz), cobrindo fila, progresso, validações 400/404/422. Corrigir o teste legado citado acima. Nas fixtures, recriar a fila/worker por TestClient (cada um tem seu event loop).

# O QUE IMPLEMENTAR (FRONTEND)
Objetivo de UX: o usuário NÃO precisa mais enviar um áudio para traduzir. Pode escrever o texto e fornecer uma voz de referência.
- Novo wrapper components/AudioStudio.tsx com abas (role="tablist"): "Texto → Voz" (padrão) e "Dublar áudio" (o AudioDubber atual, mantido). Trocar <AudioDubber /> por <AudioStudio /> no page.tsx.
- components/TextToSpeechStudio.tsx no estilo visual atual (cards rounded-[24px], tokens accent/surface/ink já existentes):
  * Textarea grande com contador (n/20000) e duração estimada; Ctrl+Enter gera; seletor de idioma.
  * Voz de referência: lista de vozes salvas (radiogroup acessível) com selo de qualidade (Boa/Média/Baixa), segundos de fala usados, player da referência JÁ PREPARADA e avisos do backend; excluir; "Nova voz" por upload (drag & drop) ou gravação no microfone.
  * Gravador em WAV no navegador (AudioWorklet + codificação RIFF 16-bit, sem MediaRecorder/webm para não exigir ffmpeg), com noiseSuppression/autoGainControl/echoCancellation desligados, medidor de nível, timer e limite de 60 s, mais um texto sugerido para ler.
  * Ajustes recolhíveis: qualidade (Rápido/Equilibrado/Máximo), velocidade, expressividade, seed.
  * Botão gerar com motivo de desabilitado ("Escolha uma voz"/"Escreva um texto"), barra de progresso role="progressbar" com o progresso REAL do backend ("Sintetizando trecho 3/8"), player, download, "Gerar outra versão" (nova seed) e histórico da sessão.
  * Dicas de referência: 10–20 s, uma só voz, sem música, idealmente no idioma do texto.
- Hooks: useVoiceLibrary (persistir voz selecionada em localStorage), useTextToSpeech (POST /api/v1/tts + pollJob), useVoiceRecorder.
- lib/nexusBridge.ts: listVoices/createVoice/deleteVoice/renameVoice/voiceSampleUrl/startTtsJob (mapear snake_case -> camelCase). NexusJob ganha progress e progress_detail. Erros devem usar o readErrorMessage existente.
- lib/types.ts: JobStatus ganha "generating_audio" e "generating_tts" (o front estava defasado do backend); tipos VoiceProfile, TtsOptions, TtsPreset, TtsStatus.
- Melhorias no AudioDubber existente: escolher/gravar a voz ANTES de transcrever, stepper (Enviar -> Revisar -> Voz -> Resultado), progresso real no lugar de porcentagens fixas por estado, remover "XTTS v2" do texto do botão, botão de download, unificar os DEFAULT_SETTINGS duplicados.
- Rodar npm install + tsc --noEmit (restaurando app/ a partir de appfront.zip) e next build. Sem novas dependências, se possível.

# REQUISITOS GERAIS
- Não quebrar as assinaturas públicas existentes nem os fluxos de imagem/vídeo.
- Comentários explicando o "porquê", no estilo do código atual (pt-BR).
- Ao final, entregue: (1) lista de arquivos novos/alterados, (2) resultado dos testes e do typecheck, (3) o que ficou sem validação (em especial a inferência real do XTTS, que exige o modelo baixado e a GPU), (4) roteiro de A/B de ouvido para calibrar presets (referência crua vs preparada; pausas fixas vs por pontuação; temperatura; modelo de tradução).
- Alternativas de motor a comparar depois do pipeline corrigido (não substituir de saída): Chatterbox Multilingual (MIT, verificar VRAM em 6 GB), F5-TTS com fine-tune pt-BR (pesos CC-BY-NC), ElevenLabs TTS com voz clonada (a chave já existe; hoje só o Speech-to-Speech está implementado e ele não traduz). Sugira uma interface TTSEngine para comparar motores lado a lado. Lembre que o XTTS v2 tem licença CPML (não comercial).