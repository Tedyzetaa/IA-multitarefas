"use client";

type Props = { value:string; mode:"image"|"video"; busy:boolean; onChange:(value:string)=>void; onModeChange:(mode:"image"|"video")=>void; onSubmit:()=>void };
export function InputBox({ value, mode, busy, onChange, onModeChange, onSubmit }:Props) {
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder="Descreva a próxima cena..." maxLength={2000} />
    <div className="composer-footer"><div className="mode"><button type="button" className={mode === "image" ? "selected" : ""} onClick={() => onModeChange("image")}>Imagem</button><button type="button" className={mode === "video" ? "selected" : ""} onClick={() => onModeChange("video")}>Vídeo</button></div><button className="primary" disabled={busy || value.trim().length < 2}>{busy ? "Processando..." : "Enviar para Nexus"}</button></div>
  </form>;
}
