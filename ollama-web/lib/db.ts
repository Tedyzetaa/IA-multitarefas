import { Conversation } from "./types";

/**
 * Banco de dados interno (IndexedDB) para as conversas.
 *
 * Por que trocar o localStorage por IndexedDB:
 *  - localStorage tem limite de ~5-10MB e guarda tudo como UMA string só;
 *    cada save serializa/deserializa o histórico INTEIRO (incluindo anexos
 *    em base64), o que trava a thread principal conforme o histórico cresce.
 *  - IndexedDB é assíncrono (não bloqueia a UI), tem limite na casa de
 *    centenas de MB/GB (depende do navegador/disco), e permite gravar/ler
 *    UMA conversa por vez em vez do dataset inteiro.
 *  - Isso é essencial aqui porque anexos (imagens em base64) podem ser
 *    grandes — no localStorage isso estourava a quota rapidinho.
 */

const DB_NAME = "ollama-chat-db";
const DB_VERSION = 1;
const STORE = "conversations";
const LEGACY_LOCALSTORAGE_KEY = "ollama-chat-conversations";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB indisponível neste ambiente"));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Falha ao abrir o banco de dados local"));
  });

  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode) {
  const transaction = db.transaction(STORE, mode);
  return transaction.objectStore(STORE);
}

/** Retorna todas as conversas, ordenadas da mais recente para a mais antiga. */
export async function getAllConversations(): Promise<Conversation[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "readonly");
    const req = store.getAll();
    req.onsuccess = () => {
      const list = (req.result as Conversation[]) ?? [];
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Grava (cria ou atualiza) uma conversa inteira. */
export async function putConversation(conversation: Conversation): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "readwrite");
    const req = store.put(conversation);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteConversationDB(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "readwrite");
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearAllConversations(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "readwrite");
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Migração única: se existir histórico salvo no formato antigo
 * (localStorage) e o IndexedDB ainda estiver vazio, importa tudo e
 * remove a chave antiga. Roda de forma transparente, sem intervenção
 * do usuário — ninguém perde histórico ao atualizar o app.
 */
export async function migrateFromLocalStorageIfNeeded(): Promise<void> {
  if (typeof window === "undefined") return;

  let legacyRaw: string | null = null;
  try {
    legacyRaw = localStorage.getItem(LEGACY_LOCALSTORAGE_KEY);
  } catch {
    return;
  }
  if (!legacyRaw) return;

  const existing = await getAllConversations().catch(() => []);
  if (existing.length > 0) {
    // Já existem dados no IndexedDB — não sobrescreve, só limpa o legado.
    try {
      localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    const parsed = JSON.parse(legacyRaw);
    const conversations: Conversation[] = Array.isArray(parsed)
      ? parsed
      : parsed?.conversations ?? [];

    for (const conversation of conversations) {
      await putConversation(conversation);
    }
  } catch {
    // dado corrompido: não há o que migrar
  } finally {
    try {
      localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

/** Exporta o banco inteiro como um objeto serializável (para backup manual). */
export async function exportAllConversationsAsJSON(): Promise<string> {
  const conversations = await getAllConversations();
  return JSON.stringify({ version: DB_VERSION, exportedAt: Date.now(), conversations }, null, 2);
}
