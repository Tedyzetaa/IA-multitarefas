"use client";

import { useCallback, useEffect, useState } from "react";
import { v4 as uuid } from "uuid";
import Sidebar from "@/components/Sidebar";
import ChatArea from "@/components/ChatArea";
import ArtifactPanel from "@/components/ArtifactPanel";
import { useOllamaStream } from "@/hooks/useOllamaStream";
import { findArtifactCandidates } from "@/lib/parseArtifacts";
import { ChatMessage, Conversation, Artifact } from "@/lib/types";

const STORAGE_KEY = "ollama-chat-conversations";

function loadConversations(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  const { send, stop, isStreaming } = useOllamaStream();

  // Carrega conversas salvas localmente na montagem
  useEffect(() => {
    const stored = loadConversations();
    setConversations(stored);
    if (stored.length > 0) setActiveId(stored[0].id);
  }, []);

  // Persiste conversas a cada alteração
  useEffect(() => {
    if (conversations.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    }
  }, [conversations]);

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;
  const messages = activeConversation?.messages ?? [];

  const updateConversation = useCallback(
    (id: string, updater: (c: Conversation) => Conversation) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? updater(c) : c))
      );
    },
    []
  );

  const handleNewChat = () => {
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
  };

  const handleDeleteChat = (id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
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

      send(
        {
          model: selectedModel,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
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
          },
        }
      );
    },
    [selectedModel, send, updateConversation]
  );

  const handleSend = (text: string) => {
    let convId = activeId;
    let baseMessages = messages;

    if (!convId) {
      const newConv: Conversation = {
        id: uuid(),
        title: text.slice(0, 40),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      setConversations((prev) => [newConv, ...prev]);
      convId = newConv.id;
      baseMessages = [];
      setActiveId(convId);
    }

    const userMsg: ChatMessage = {
      id: uuid(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };

    const isFirstMessage = baseMessages.length === 0;
    const nextHistory = [...baseMessages, userMsg];

    updateConversation(convId, (c) => ({
      ...c,
      title: isFirstMessage ? text.slice(0, 40) : c.title,
      messages: nextHistory,
      updatedAt: Date.now(),
    }));

    runGeneration(convId, nextHistory);
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

  const conversationArtifacts = artifacts.filter((a) =>
    messages.some((m) => m.id === a.messageId)
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-light dark:bg-surface-dark">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((s) => !s)}
        onNewChat={handleNewChat}
        onSelect={(id) => {
          setActiveId(id);
          setActiveArtifact(null);
        }}
        onDelete={handleDeleteChat}
        onOpenSettings={() => {}}
      />

      <ChatArea
        messages={messages}
        artifacts={conversationArtifacts}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        onSend={handleSend}
        onStop={stop}
        onRegenerate={handleRegenerate}
        onOpenArtifact={setActiveArtifact}
        isStreaming={isStreaming}
        sidebarCollapsed={sidebarCollapsed}
        onExpandSidebar={() => setSidebarCollapsed(false)}
      />

      <ArtifactPanel
        artifact={activeArtifact}
        artifacts={conversationArtifacts}
        onSelect={setActiveArtifact}
        onClose={() => setActiveArtifact(null)}
      />
    </div>
  );
}
