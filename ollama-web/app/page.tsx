"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import Sidebar from "@/components/Sidebar";
import ChatArea from "@/components/ChatArea";
import ArtifactPanel from "@/components/ArtifactPanel";
import SettingsModal from "@/components/SettingsModal";
import Toaster from "@/components/Toaster";
import AudioStudio from "@/components/AudioStudio";
import { useOllamaStream } from "@/hooks/useOllamaStream";
import { findArtifactCandidates } from "@/lib/parseArtifacts";
import { buildOllamaPayloadMessages } from "@/lib/attachments";
import {
  startVideoJob,
  startImageJob,
  pollVideoJob,
  pollJob,
  videoUrlFromFilePath,
  imageUrlFromFilePath,
  buildInitialVideoGeneration,
  buildInitialImageGeneration,
  ImageGenMode,
} from "@/lib/nexusBridge";
import {
  ChatMessage,
  Conversation,
  Artifact,
  ChatAttachment,
  VideoGeneration,
  ImageGeneration,
  ConversationMode,
} from "@/lib/types";
import {
  getAllConversations,
  putConversation,
  deleteConversationDB,
  migrateFromLocalStorageIfNeeded,
} from "@/lib/db";
import { loadSettings, resolveVideoSettings } from "@/lib/settings";
import { toast } from "@/lib/toast";
import { MessageCircle, Image, Film, Mic2 } from "lucide-react";

const SAVE_DEBOUNCE_MS = 400;

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selectedModel, setSelectedModel] = useState("");
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [pendingMode, setPendingMode] = useState<ConversationMode | null>(null);
  const [modeSwitcherOpen, setModeSwitcherOpen] = useState(false);

  const { send, stop, isStreaming } = useOllamaStream();
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Carrega conversas do IndexedDB na montagem (com migração automática do
  // localStorage legado, se existir).
  useEffect(() => {
    (async () => {
      try {
        await migrateFromLocalStorageIfNeeded();
        const stored = await getAllConversations();
        setConversations(stored);
        if (stored.length > 0) setActiveId(stored[0].id);
      } catch (err) {
        console.error(err);
        toast("Não foi possível carregar o histórico salvo.", "error");
      } finally {
        setIsLoaded(true);
      }
    })();
  }, []);

  // Atalho Ctrl+K (ou Cmd+K no Mac) para novo chat
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Fechar drawer automaticamente em desktop (md+)
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) {
        setSidebarOpen(true);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;
  const messages = activeConversation?.messages ?? [];
  const activeMode = activeConversation?.mode ?? pendingMode;

  /** Persiste uma conversa específica no IndexedDB, com debounce por conversa
   * (evita gravar a cada token individual durante o streaming). */
  const persist = useCallback((conversation: Conversation) => {
    const timers = saveTimers.current;
    const existing = timers.get(conversation.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      putConversation(conversation).catch(() => {
        toast("Falha ao salvar a conversa localmente.", "error");
      });
      timers.delete(conversation.id);
    }, SAVE_DEBOUNCE_MS);
    timers.set(conversation.id, timer);
  }, []);

  const updateConversation = useCallback(
    (id: string, updater: (c: Conversation) => Conversation) => {
      setConversations((prev) => {
        const next = prev.map((c) => (c.id === id ? updater(c) : c));
        const updated = next.find((c) => c.id === id);
        if (updated) persist(updated);
        return next;
      });
    },
    [persist]
  );

  const handleNewChat = useCallback(() => {
    const newConv: Conversation = {
      id: uuid(),
      title: "Nova conversa",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    setConversations((prev) => [newConv, ...prev]);
    setActiveId(newConv.id);
    setActiveArtifact(null);
    setPendingMode(null);
    setModeSwitcherOpen(false);
    // Fecha drawer em mobile ao criar novo chat
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, []);

  const handleSelectMode = useCallback((mode: ConversationMode) => {
    setPendingMode(mode);
    setModeSwitcherOpen(false);
  }, []);

  const handleDeleteChat = (id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
    deleteConversationDB(id).catch(() => {
      toast("Falha ao excluir a conversa.", "error");
    });
  };

  const handleRenameChat = (id: string, newTitle: string) => {
    updateConversation(id, (c) => ({ ...c, title: newTitle }));
  };

  /** Executa uma rodada de geração dado o histórico de mensagens já montado */
  const runGeneration = useCallback(
    (convId: string, history: ChatMessage[]) => {
      const assistantId = uuid();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        streaming: true,
        model: selectedModel,
      };

      updateConversation(convId, (c) => ({
        ...c,
        messages: [...history, assistantMsg],
        updatedAt: Date.now(),
      }));

      const { systemPrompt, temperature } = loadSettings();

      send(
        {
          model: selectedModel,
          messages: buildOllamaPayloadMessages(history),
          systemPrompt,
          temperature,
        },
        {
          onToken: (fullText) => {
            updateConversation(convId, (c) => ({
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantId ? { ...m, content: fullText } : m
              ),
            }));
          },
          onDone: (fullText) => {
            updateConversation(convId, (c) => ({
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantId
                  ? { ...m, content: fullText, streaming: false }
                  : m
              ),
            }));
            const found = findArtifactCandidates(fullText, assistantId);
            if (found.length > 0) {
              setArtifacts((prev) => [...prev, ...found]);
              setActiveArtifact(found[found.length - 1]);
            }
          },
          onError: (err) => {
            updateConversation(convId, (c) => ({
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content: `⚠️ Erro ao conversar com o Ollama: ${err.message}`,
                      streaming: false,
                    }
                  : m
              ),
            }));
            toast(err.message, "error");
          },
        }
      );
    },
    [selectedModel, send, updateConversation]
  );

  const handleSend = (text: string, attachments: ChatAttachment[] = []) => {
    if (!selectedModel) {
      toast("Selecione um modelo antes de enviar uma mensagem.", "error");
      return;
    }

    let convId = activeId;
    let baseMessages = messages;

    // título da conversa: usa o texto digitado, ou o nome do 1º anexo
    // quando o usuário manda só arquivo(s) sem legenda
    const conversationTitle =
      text.slice(0, 40) || (attachments[0] ? `📎 ${attachments[0].name}` : "Nova conversa");

    if (!convId) {
      const newConv: Conversation = {
        id: uuid(),
        title: conversationTitle,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        mode: pendingMode || "text", // Trava o modo na primeira mensagem
      };
      setConversations((prev) => [newConv, ...prev]);
      convId = newConv.id;
      baseMessages = [];
      setActiveId(convId);
      setPendingMode(null);
    }

    const userMsg: ChatMessage = {
      id: uuid(),
      role: "user",
      content: text,
      createdAt: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    const isFirstMessage = baseMessages.length === 0;
    const nextHistory = [...baseMessages, userMsg];

    updateConversation(convId, (c) => ({
      ...c,
      title: isFirstMessage ? conversationTitle : c.title,
      messages: nextHistory,
      updatedAt: Date.now(),
    }));

    runGeneration(convId, nextHistory);

    // Fecha drawer em mobile ao enviar mensagem
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  /** Atualiza só o campo `video` de uma mensagem específica, preservando o resto. */
  const patchVideoMessage = useCallback(
    (convId: string, messageId: string, patch: Partial<VideoGeneration>) => {
      updateConversation(convId, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === messageId && m.video ? { ...m, video: { ...m.video, ...patch } } : m
        ),
      }));
    },
    [updateConversation]
  );

  /**
   * Dispara uma geração de vídeo via nexus-bridge (LTX-Video) e acompanha
   * o job até completar. `image`, quando presente (produto anexado no
   * InputBox), vira o quadro de referência do fluxo img2video — igual ao
   * nó "9" (LoadImage) do _workflow.json — em vez de gerar do zero.
   */
  const handleGenerateVideo = (text: string, image?: ChatAttachment) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    let convId = activeId;
    let baseMessages = messages;

    const conversationTitle = `🎬 ${trimmed.slice(0, 40)}`;

    if (!convId) {
      const newConv: Conversation = {
        id: uuid(),
        title: conversationTitle,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        mode: "video", // Trava o modo em vídeo
      };
      setConversations((prev) => [newConv, ...prev]);
      convId = newConv.id;
      baseMessages = [];
      setActiveId(convId);
      setPendingMode(null);
    }

    const targetConvId = convId;
    const isFirstMessage = baseMessages.length === 0;

    const userMsg: ChatMessage = {
      id: uuid(),
      role: "user",
      content: trimmed,
      createdAt: Date.now(),
      // mostra a miniatura do produto na mensagem, igual ao chat normal
      attachments: image ? [image] : undefined,
    };

    const assistantId = uuid();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      video: buildInitialVideoGeneration(trimmed),
    };

    updateConversation(targetConvId, (c) => ({
      ...c,
      title: isFirstMessage ? conversationTitle : c.title,
      messages: [...baseMessages, userMsg, assistantMsg],
      updatedAt: Date.now(),
    }));

    // Fecha drawer em mobile ao gerar vídeo
    if (window.innerWidth < 768) setSidebarOpen(false);

    const videoSettings = resolveVideoSettings(loadSettings());

    startVideoJob({
      prompt: trimmed,
      image: image ? { base64: image.data, mimeType: image.mimeType } : undefined,
      settings: videoSettings,
    })
      .then((job) => {
        patchVideoMessage(targetConvId, assistantId, { jobId: job.id, status: job.status });

        pollVideoJob(
          job.id,
          (updatedJob) => {
            patchVideoMessage(targetConvId, assistantId, {
              status: updatedJob.status,
              error: updatedJob.error ?? undefined,
            });
          },
          (finalJob) => {
            if (finalJob.status === "completed" && finalJob.file_path) {
              patchVideoMessage(targetConvId, assistantId, {
                status: "completed",
                url: videoUrlFromFilePath(finalJob.file_path),
              });
            } else {
              const errorMsg = finalJob.error ?? "Falha desconhecida ao gerar o vídeo.";
              patchVideoMessage(targetConvId, assistantId, { status: "failed", error: errorMsg });
              toast(errorMsg, "error");
            }
          }
        );
      })
      .catch((err: Error) => {
        patchVideoMessage(targetConvId, assistantId, { status: "failed", error: err.message });
        toast(`Não foi possível iniciar a geração de vídeo: ${err.message}`, "error");
      });
  };

  /** Atualiza só o campo `image` de uma mensagem específica, preservando o resto. */
  const patchImageMessage = useCallback(
    (convId: string, messageId: string, patch: Partial<ImageGeneration>) => {
      updateConversation(convId, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === messageId && m.image ? { ...m, image: { ...m.image, ...patch } } : m
        ),
      }));
    },
    [updateConversation]
  );

  /**
   * Dispara uma geração de imagem (t2i/i2i) via nexus-bridge e acompanha
   * o job até completar. Espelha handleGenerateVideo quase linha a linha --
   * a diferença é o endpoint (startImageJob em vez de startVideoJob) e que
   * `image`, quando presente, é obrigatório no modo i2i (já validado antes
   * de chegar aqui, em InputBox.handleGenerateImage).
   */
  const handleGenerateImage = (text: string, mode: ImageGenMode, image?: ChatAttachment) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    let convId = activeId;
    let baseMessages = messages;

    const conversationTitle = `🖼️ ${trimmed.slice(0, 40)}`;

    if (!convId) {
      const newConv: Conversation = {
        id: uuid(),
        title: conversationTitle,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        mode: "image", // Trava o modo em imagem
      };
      setConversations((prev) => [newConv, ...prev]);
      convId = newConv.id;
      baseMessages = [];
      setActiveId(convId);
      setPendingMode(null);
    }

    const targetConvId = convId;
    const isFirstMessage = baseMessages.length === 0;

    const userMsg: ChatMessage = {
      id: uuid(),
      role: "user",
      content: trimmed,
      createdAt: Date.now(),
      attachments: image ? [image] : undefined,
    };

    const assistantId = uuid();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      image: buildInitialImageGeneration(trimmed, mode),
    };

    updateConversation(targetConvId, (c) => ({
      ...c,
      title: isFirstMessage ? conversationTitle : c.title,
      messages: [...baseMessages, userMsg, assistantMsg],
      updatedAt: Date.now(),
    }));

    // Fecha drawer em mobile ao gerar imagem
    if (window.innerWidth < 768) setSidebarOpen(false);

    startImageJob({
      prompt: trimmed,
      mode,
      image: image ? { base64: image.data, mimeType: image.mimeType } : undefined,
    })
      .then((job) => {
        patchImageMessage(targetConvId, assistantId, { jobId: job.id, status: job.status });

        pollJob(
          job.id,
          (updatedJob) => {
            patchImageMessage(targetConvId, assistantId, {
              status: updatedJob.status,
              error: updatedJob.error ?? undefined,
            });
          },
          (finalJob) => {
            if (finalJob.status === "completed" && finalJob.file_path) {
              patchImageMessage(targetConvId, assistantId, {
                status: "completed",
                url: imageUrlFromFilePath(finalJob.file_path),
              });
            } else {
              const errorMsg = finalJob.error ?? "Falha desconhecida ao gerar a imagem.";
              patchImageMessage(targetConvId, assistantId, { status: "failed", error: errorMsg });
              toast(errorMsg, "error");
            }
          }
        );
      })
      .catch((err: Error) => {
        patchImageMessage(targetConvId, assistantId, { status: "failed", error: err.message });
        toast(`Não foi possível iniciar a geração de imagem: ${err.message}`, "error");
      });
  };

  const handleRegenerate = () => {
    if (!activeConversation) return;
    // remove a última resposta do assistente e regenera
    const withoutLastAssistant = [...messages];
    if (withoutLastAssistant[withoutLastAssistant.length - 1]?.role === "assistant") {
      withoutLastAssistant.pop();
    }
    updateConversation(activeConversation.id, (c) => ({
      ...c,
      messages: withoutLastAssistant,
    }));
    runGeneration(activeConversation.id, withoutLastAssistant);
  };

  /** Edita uma mensagem do usuário e reenvia a partir dela, descartando
   * tudo que veio depois (igual ao comportamento do Claude.ai). */
  const handleEditMessage = (messageId: string, newContent: string) => {
    if (!activeConversation) return;
    const index = messages.findIndex((m) => m.id === messageId);
    if (index === -1) return;

    const edited: ChatMessage = { ...messages[index], content: newContent };
    const truncated = [...messages.slice(0, index), edited];

    updateConversation(activeConversation.id, (c) => ({
      ...c,
      messages: truncated,
    }));
    runGeneration(activeConversation.id, truncated);
  };

  const handleDeleteMessage = (messageId: string) => {
    if (!activeConversation) return;
    updateConversation(activeConversation.id, (c) => ({
      ...c,
      messages: c.messages.filter((m) => m.id !== messageId),
    }));
  };

  const handleDataCleared = () => {
    setConversations([]);
    setActiveId(null);
    setArtifacts([]);
    setActiveArtifact(null);
  };

  const conversationArtifacts = artifacts.filter((a) =>
    messages.some((m) => m.id === a.messageId)
  );

  if (!isLoaded) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-surface-light dark:bg-surface-dark">
        <div className="w-6 h-6 rounded-full border-2 border-accent border-t-transparent animate-spin" />
      </div>
    );
  }

  // Seletor de modos: mostrado quando não há mensagens, o modo não está
  // travado por uma conversa existente E nenhum modo foi escolhido ainda.
  // Bug corrigido aqui: antes só checava `activeConversation?.mode`, então
  // clicar num card só fazia `setPendingMode(...)` e a tela de seleção
  // continuava para sempre, escondendo o ChatArea/InputBox por baixo.
  const showModeSelector =
    messages.length === 0 && !activeConversation?.mode && !pendingMode;

  // Modo "escolhido mas ainda não travado": conversa ainda não existe (ou
  // existe mas sem `mode`), então dá pra trocar de ideia sem perder o texto
  // já digitado no InputBox (que fica montado o tempo todo nesse caso).
  const canSwitchMode = !activeConversation?.mode && !!pendingMode;
  const modeLabels: Record<ConversationMode, string> = {
    text: "Texto",
    image: "Imagem",
    video: "Vídeo",
    audio: "Áudio",
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-light dark:bg-surface-dark glass-panel">
      {/* Backdrop do Drawer (mobile) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 backdrop-modal md:hidden z-30"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar com Drawer em mobile */}
      <div
        className={`fixed md:relative w-72 h-full z-40 transition-transform duration-200 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <Sidebar
          conversations={conversations}
          activeId={activeId}
          collapsed={false}
          onToggleCollapse={() => {}}
          onNewChat={() => {
            handleNewChat();
            if (window.innerWidth < 768) setSidebarOpen(false);
          }}
          onSelect={(id) => {
            setActiveId(id);
            setActiveArtifact(null);
            if (window.innerWidth < 768) setSidebarOpen(false);
          }}
          onDelete={handleDeleteChat}
          onRename={handleRenameChat}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>

      {/* Área Principal */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Seletor de Modos (mostrado inicialmente) */}
        {showModeSelector && (
          <div className="flex-1 flex flex-col items-center justify-center gap-8 px-4 py-12">
            <div className="text-center">
              <h1 className="text-3xl md:text-4xl font-bold text-ink-light dark:text-ink-dark mb-2">
                Escolha um modo
              </h1>
              <p className="text-ink-muted">Como você gostaria de começar?</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 max-w-4xl">
              {/* Modo Texto */}
              <button
                onClick={() => handleSelectMode("text")}
                className="group relative overflow-hidden rounded-2xl p-6 bg-surface-light-raised dark:bg-surface-dark-raised border border-border-light dark:border-border-dark hover:border-accent transition-all duration-200 flex flex-col items-center gap-3 text-center"
              >
                <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <MessageCircle className="w-6 h-6 text-accent" />
                </div>
                <div>
                  <h3 className="font-semibold text-ink-light dark:text-ink-dark">Texto</h3>
                  <p className="text-sm text-ink-muted mt-1">
                    Chat com análise de texto
                  </p>
                </div>
              </button>

              {/* Modo Imagem */}
              <button
                onClick={() => handleSelectMode("image")}
                className="group relative overflow-hidden rounded-2xl p-6 bg-surface-light-raised dark:bg-surface-dark-raised border border-border-light dark:border-border-dark hover:border-accent transition-all duration-200 flex flex-col items-center gap-3 text-center"
              >
                <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Image className="w-6 h-6 text-accent" />
                </div>
                <div>
                  <h3 className="font-semibold text-ink-light dark:text-ink-dark">Imagem</h3>
                  <p className="text-sm text-ink-muted mt-1">
                    Análise multimodal com imagens
                  </p>
                </div>
              </button>

              {/* Modo Vídeo */}
              <button
                onClick={() => handleSelectMode("video")}
                className="group relative overflow-hidden rounded-2xl p-6 bg-surface-light-raised dark:bg-surface-dark-raised border border-border-light dark:border-border-dark hover:border-accent transition-all duration-200 flex flex-col items-center gap-3 text-center"
              >
                <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Film className="w-6 h-6 text-accent" />
                </div>
                <div>
                  <h3 className="font-semibold text-ink-light dark:text-ink-dark">Vídeo</h3>
                  <p className="text-sm text-ink-muted mt-1">
                    Gerar vídeos com IA
                  </p>
                </div>
              </button>

              {/* Modo Áudio */}
              <button
                onClick={() => handleSelectMode("audio")}
                className="group relative overflow-hidden rounded-2xl p-6 bg-surface-light-raised dark:bg-surface-dark-raised border border-border-light dark:border-border-dark hover:border-accent transition-all duration-200 flex flex-col items-center gap-3 text-center"
              >
                <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Mic2 className="w-6 h-6 text-accent" />
                </div>
                <div>
                  <h3 className="font-semibold text-ink-light dark:text-ink-dark">Áudio</h3>
                  <p className="text-sm text-ink-muted mt-1">
                    Dublagem expressiva em português
                  </p>
                </div>
              </button>
            </div>

            <p className="text-xs text-ink-muted mt-4">
              💡 Dica: Pressione <kbd className="px-2 py-1 rounded bg-border-light dark:bg-border-dark">Ctrl+K</kbd> para novo chat
            </p>
          </div>
        )}

        {/* Chat Area (oculto quando seletor está visible) */}
        {!showModeSelector && (
          <>
            {/* Aviso de modo escolhido, com opção de trocar sem perder o texto
                digitado -- só aparece antes da 1ª mensagem, quando o modo
                ainda não travou numa conversa existente (ver canSwitchMode). */}
            {canSwitchMode && pendingMode && (
              <div className="shrink-0 flex items-center justify-center gap-2 px-4 py-1.5 text-xs bg-accent-soft/60 dark:bg-accent/10 border-b border-border-light dark:border-border-dark text-ink-muted">
                {modeSwitcherOpen ? (
                  <>
                    <span>Trocar para:</span>
                    {(["text", "image", "video"] as ConversationMode[])
                      .filter((m) => m !== pendingMode)
                      .map((m) => (
                        <button
                          key={m}
                          onClick={() => handleSelectMode(m)}
                          className="px-2 py-0.5 rounded-full border border-border-light dark:border-border-dark hover:border-accent hover:text-accent transition-colors"
                        >
                          {modeLabels[m]}
                        </button>
                      ))}
                    <button
                      onClick={() => setModeSwitcherOpen(false)}
                      className="px-2 py-0.5 text-ink-muted hover:text-ink-light dark:hover:text-ink-dark"
                    >
                      cancelar
                    </button>
                  </>
                ) : (
                  <>
                    <span>
                      Modo: <span className="font-medium text-ink-light dark:text-ink-dark">{modeLabels[pendingMode]}</span>
                    </span>
                    <button
                      onClick={() => setModeSwitcherOpen(true)}
                      className="underline hover:text-accent transition-colors"
                    >
                      trocar
                    </button>
                  </>
                )}
              </div>
            )}

            {activeMode === "audio" ? (
              <AudioStudio />
            ) : (
              <>
                <ChatArea
                  messages={messages}
                  artifacts={conversationArtifacts}
                  selectedModel={selectedModel}
                  onModelChange={setSelectedModel}
                  onSend={handleSend}
                  onGenerateVideo={activeMode === "video" ? handleGenerateVideo : undefined}
                  onGenerateImage={activeMode === "image" ? handleGenerateImage : undefined}
                  onStop={stop}
                  onRegenerate={handleRegenerate}
                  onOpenArtifact={setActiveArtifact}
                  onEditMessage={handleEditMessage}
                  onDeleteMessage={handleDeleteMessage}
                  isStreaming={isStreaming}
                  sidebarCollapsed={false}
                  onExpandSidebar={() => setSidebarOpen(true)}
                />

                <ArtifactPanel
                  artifact={activeArtifact}
                  artifacts={conversationArtifacts}
                  onSelect={setActiveArtifact}
                  onClose={() => setActiveArtifact(null)}
                />
              </>
            )}
          </>
        )}
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onDataCleared={handleDataCleared}
      />

      <Toaster />
    </div>
  );
}
