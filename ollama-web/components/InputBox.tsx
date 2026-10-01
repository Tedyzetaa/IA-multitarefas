"use client";

import {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  KeyboardEvent,
  ChangeEvent,
  ClipboardEvent,
} from "react";
import { ArrowUp, Square, Paperclip, X, FileText, FileArchive, Loader2, Film, Image as ImageIcon, Wand2 } from "lucide-react";
import { ChatAttachment } from "@/lib/types";
import {
  ACCEPTED_FILE_EXTENSIONS,
  buildAttachmentFromFile,
  detectAttachmentType,
  formatBytes,
} from "@/lib/attachments";
import { toast } from "@/lib/toast";
import { ImageGenMode } from "@/lib/nexusBridge";

interface InputBoxProps {
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  /** Ausente = recurso de vídeo desligado (ex: nexus-bridge não configurado); o botão some.
   * `image`, quando presente, é o primeiro anexo de imagem pronto na caixa —
   * vira o quadro de referência do fluxo img2video (produto). */
  onGenerateVideo?: (text: string, image?: ChatAttachment) => void;
  /** Ausente = pipeline de imagem via nexus-bridge desligado; os botões T2I/I2I somem.
   * `mode` é o modo escolhido no seletor; `image` é o anexo pronto (obrigatório
   * quando mode === "i2i" -- ver validação em handleGenerateImage). */
  onGenerateImage?: (text: string, mode: ImageGenMode, image?: ChatAttachment) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

/** Anexo em processamento na caixa de input, antes do envio. */
interface PendingAttachment {
  id: string;
  file: File;
  status: "loading" | "ready" | "error";
  errorMessage?: string;
  attachment?: ChatAttachment;
}

export interface InputBoxHandle {
  /** Recebe arquivos vindos de fora (drag & drop na área do chat). */
  addFiles: (files: File[]) => void;
  focus: () => void;
}

const MAX_HEIGHT = 240;

const InputBox = forwardRef<InputBoxHandle, InputBoxProps>(function InputBox(
  { onSend, onGenerateVideo, onGenerateImage, onStop, isStreaming, disabled },
  ref
) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  // Modo do pipeline de geração via nexus-bridge selecionado no momento.
  // "t2i"/"i2i" disparam onGenerateImage; "t2v" continua disparando
  // onGenerateVideo (mantido separado por já ter seu próprio endpoint/job kind).
  const [genMode, setGenMode] = useState<ImageGenMode | "t2v">("t2i");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT) + "px";
  }, [value]);

  const isBusy = pending.some((p) => p.status === "loading");

  /** Núcleo compartilhado por: input de arquivo, colar (paste) e arrastar (drop). */
  const processFiles = (files: File[]) => {
    for (const file of files) {
      if (!detectAttachmentType(file)) {
        setPending((prev) => [
          ...prev,
          {
            id: `${file.name}-${Date.now()}-${Math.random()}`,
            file,
            status: "error",
            errorMessage: "Tipo de arquivo não suportado",
          },
        ]);
        toast(`"${file.name}" não é um tipo de arquivo suportado.`, "error");
        continue;
      }

      const placeholderId = `${file.name}-${Date.now()}-${Math.random()}`;
      setPending((prev) => [...prev, { id: placeholderId, file, status: "loading" }]);

      buildAttachmentFromFile(file)
        .then((attachment) => {
          setPending((prev) =>
            prev.map((p) =>
              p.id === placeholderId
                ? { ...p, id: attachment.id, status: "ready", attachment }
                : p
            )
          );
        })
        .catch((err: Error) => {
          setPending((prev) =>
            prev.map((p) =>
              p.id === placeholderId ? { ...p, status: "error", errorMessage: err.message } : p
            )
          );
          toast(err.message, "error");
        });
    }
  };

  useImperativeHandle(ref, () => ({
    addFiles: processFiles,
    focus: () => textareaRef.current?.focus(),
  }));

  const handleFilesSelected = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // permite selecionar o mesmo arquivo de novo depois
    processFiles(files);
  };

  /** Cola imagens direto da área de transferência (ex.: print/screenshot -> Ctrl+V). */
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    // Só intercepta o paste quando há arquivo de verdade; texto colado
    // continua se comportando normalmente (não faz e.preventDefault()).
    if (files.length > 0) {
      e.preventDefault();
      processFiles(files);
    }
  };

  const removePending = (id: string) => {
    setPending((prev) => prev.filter((p) => p.id !== id));
  };

  const handleSubmit = () => {
    const trimmed = value.trim();
    const readyAttachments = pending
      .filter((p) => p.status === "ready" && p.attachment)
      .map((p) => p.attachment as ChatAttachment);

    if ((!trimmed && readyAttachments.length === 0) || isStreaming || disabled || isBusy) {
      return;
    }

    onSend(trimmed, readyAttachments);
    setValue("");
    setPending([]);
  };

  // Geração de vídeo: texto continua obrigatório (é o prompt), mas agora
  // aceita opcionalmente a 1ª imagem pronta anexada -- ela vira a imagem
  // de referência do fluxo img2video (produto) no ComfyUI/LTX-Video.
  // Anexos de PDF/ZIP não fazem sentido aqui e são ignorados.
  const handleGenerateVideo = () => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming || disabled || isBusy || !onGenerateVideo) return;

    const imageAttachment = pending.find(
      (p) => p.status === "ready" && p.attachment?.type === "image"
    )?.attachment;

    onGenerateVideo(trimmed, imageAttachment);
    setValue("");
    setPending([]);
  };

  // Geração de imagem (T2I/I2I via ComfyUI, ver app/providers/comfyui_provider.py).
  // Reaproveita o mesmo pipeline de anexos do chat/vídeo: em vez de um
  // segundo <input type="file"> dedicado a i2i (duplicando toda a lógica de
  // paste/drag/preview/erro já existente acima), a imagem de referência é
  // sempre "a 1ª imagem pronta anexada na caixa" -- consistente com como
  // handleGenerateVideo já funciona.
  // Recebe `mode` explicitamente (em vez de ler o state `genMode`) porque
  // o botão que aciona isso também acabou de chamar setGenMode(mode) no
  // mesmo clique -- ler o state aqui pegaria o valor ANTERIOR à atualização
  // (setState é assíncrono em React), disparando o modo errado no primeiro
  // clique após trocar de seleção.
  const handleGenerateImage = (mode: ImageGenMode) => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming || disabled || isBusy || !onGenerateImage) return;

    const imageAttachment = pending.find(
      (p) => p.status === "ready" && p.attachment?.type === "image"
    )?.attachment;

    if (mode === "i2i" && !imageAttachment) {
      // Espelha a validação do backend (GenerateRequest.validate_i2i_requires_image
      // em app/models.py) para dar feedback imediato, sem round-trip ao nexus-bridge.
      toast("Anexe uma imagem para usar o modo image-to-image.", "error");
      return;
    }

    onGenerateImage(trimmed, mode, imageAttachment);
    setValue("");
    setPending([]);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const canSubmit =
    (value.trim().length > 0 || pending.some((p) => p.status === "ready")) &&
    !isBusy &&
    !disabled;

  const hasReadyImage = pending.some(
    (p) => p.status === "ready" && p.attachment?.type === "image"
  );

  return (
    <div className="px-4 pb-4 pt-2">
      <div className="max-w-3xl mx-auto">
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {pending.map((p) => (
              <AttachmentCard key={p.id} pending={p} onRemove={() => removePending(p.id)} />
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 rounded-2xl border border-border-light dark:border-border-dark bg-surface-light-raised dark:bg-surface-dark-raised px-3 py-2 shadow-sm focus-within:border-accent transition-colors">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_FILE_EXTENSIONS}
            onChange={handleFilesSelected}
            className="hidden"
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0 p-2 rounded-lg text-ink-muted hover:bg-surface-light-sunken dark:hover:bg-surface-dark-sunken transition-colors"
            title="Anexar arquivo"
            aria-label="Anexar arquivo"
            type="button"
            disabled={disabled}
          >
            <Paperclip size={18} />
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder="Envie uma mensagem, cole uma imagem (Ctrl+V) ou arraste um arquivo..."
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className="flex-1 resize-none bg-transparent outline-none text-sm leading-relaxed py-2 text-ink-light dark:text-ink-dark placeholder:text-ink-muted disabled:opacity-50"
            style={{ maxHeight: MAX_HEIGHT }}
          />

          {(onGenerateImage || onGenerateVideo) && (
            <div className="shrink-0 flex items-center gap-0.5 rounded-full bg-surface-light-sunken dark:bg-surface-dark-sunken p-0.5">
              {onGenerateImage && (
                <button
                  onClick={() => {
                    setGenMode("t2i");
                    handleGenerateImage("t2i");
                  }}
                  disabled={!canSubmit}
                  className={`w-8 h-8 flex items-center justify-center rounded-full transition-colors disabled:opacity-30 ${
                    genMode === "t2i"
                      ? "bg-surface-light dark:bg-surface-dark text-ink-light dark:text-ink-dark shadow-sm"
                      : "text-ink-muted hover:bg-surface-light dark:hover:bg-surface-dark"
                  }`}
                  aria-label="Gerar imagem a partir deste texto (text-to-image, via nexus-bridge)"
                  title="Texto -> imagem (T2I, via nexus-bridge)"
                  type="button"
                >
                  <ImageIcon size={16} />
                </button>
              )}

              {onGenerateImage && (
                <button
                  onClick={() => {
                    setGenMode("i2i");
                    handleGenerateImage("i2i");
                  }}
                  disabled={!canSubmit}
                  className={`w-8 h-8 flex items-center justify-center rounded-full transition-colors disabled:opacity-30 ${
                    genMode === "i2i"
                      ? "bg-surface-light dark:bg-surface-dark text-ink-light dark:text-ink-dark shadow-sm"
                      : "text-ink-muted hover:bg-surface-light dark:hover:bg-surface-dark"
                  }`}
                  aria-label="Gerar imagem a partir deste texto e da imagem anexada (image-to-image, via nexus-bridge)"
                  title={
                    hasReadyImage
                      ? "Transformar a imagem anexada (I2I, via nexus-bridge)"
                      : "Image-to-image -- anexe uma imagem primeiro"
                  }
                  type="button"
                >
                  <Wand2 size={16} />
                </button>
              )}

              {onGenerateVideo && (
                <button
                  onClick={() => {
                    setGenMode("t2v");
                    handleGenerateVideo();
                  }}
                  disabled={!canSubmit}
                  className={`w-8 h-8 flex items-center justify-center rounded-full transition-colors disabled:opacity-30 ${
                    genMode === "t2v"
                      ? "bg-surface-light dark:bg-surface-dark text-ink-light dark:text-ink-dark shadow-sm"
                      : "text-ink-muted hover:bg-surface-light dark:hover:bg-surface-dark"
                  }`}
                  aria-label="Gerar vídeo a partir deste texto e da imagem anexada (se houver)"
                  title={
                    hasReadyImage
                      ? "Gerar vídeo do produto (img2video, via nexus-bridge)"
                      : "Gerar vídeo (texto -> vídeo, via nexus-bridge)"
                  }
                  type="button"
                >
                  <Film size={16} />
                </button>
              )}
            </div>
          )}

          {isStreaming ? (
            <button
              onClick={onStop}
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-ink-light dark:bg-ink-dark text-surface-light dark:text-surface-dark hover:opacity-85 transition-opacity"
              aria-label="Parar geração"
              title="Parar"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-accent text-white hover:bg-accent-hover disabled:opacity-30 disabled:hover:bg-accent transition-colors"
              aria-label="Enviar mensagem"
              title="Enviar"
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
        <p className="text-center text-[11px] text-ink-muted mt-2">
          As respostas são geradas localmente pelo Ollama. Verifique
          informações importantes.
        </p>
      </div>
    </div>
  );
});

export default InputBox;

function AttachmentCard({
  pending,
  onRemove,
}: {
  pending: PendingAttachment;
  onRemove: () => void;
}) {
  const { file, status, errorMessage, attachment } = pending;
  const type = attachment?.type ?? detectAttachmentType(file);

  // Imagens: miniatura quadrada com botão de remover sobreposto
  if (type === "image") {
    return (
      <div className="relative w-16 h-16 rounded-lg overflow-hidden border border-border-light dark:border-border-dark shrink-0 group">
        {attachment?.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={attachment.previewUrl} alt={file.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-surface-light-sunken dark:bg-surface-dark-sunken">
            <Loader2 size={16} className="animate-spin text-ink-muted" />
          </div>
        )}
        {status === "loading" && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <Loader2 size={16} className="animate-spin text-white" />
          </div>
        )}
        <button
          onClick={onRemove}
          type="button"
          aria-label={`Remover ${file.name}`}
          className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X size={11} />
        </button>
        {status === "error" && (
          <div className="absolute inset-0 bg-red-500/20 flex items-center justify-center" title={errorMessage}>
            <X size={16} className="text-red-600" />
          </div>
        )}
      </div>
    );
  }

  // PDF / ZIP / erro genérico: card informativo com nome + tamanho
  const Icon = type === "zip" ? FileArchive : FileText;
  return (
    <div
      className={`flex items-center gap-2 pl-2 pr-1.5 py-1.5 rounded-lg border shrink-0 max-w-[220px] ${
        status === "error"
          ? "border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800"
          : "border-border-light dark:border-border-dark bg-surface-light-sunken dark:bg-surface-dark-sunken"
      }`}
    >
      <div className="shrink-0 w-7 h-7 rounded-md bg-surface-light dark:bg-surface-dark flex items-center justify-center">
        {status === "loading" ? (
          <Loader2 size={14} className="animate-spin text-ink-muted" />
        ) : (
          <Icon size={14} className={status === "error" ? "text-red-500" : "text-ink-muted"} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate text-ink-light dark:text-ink-dark">
          {file.name}
        </p>
        <p className="text-[10px] text-ink-muted">
          {status === "error" ? errorMessage ?? "Erro ao processar" : formatBytes(file.size)}
        </p>
      </div>
      <button
        onClick={onRemove}
        type="button"
        aria-label={`Remover ${file.name}`}
        className="shrink-0 p-1 rounded-md text-ink-muted hover:bg-surface-light dark:hover:bg-surface-dark transition-colors"
      >
        <X size={12} />
      </button>
    </div>
  );
}
