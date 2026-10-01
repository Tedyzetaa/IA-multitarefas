"use client";
import { useEffect, useState } from "react";
import { ArtifactPanel } from "@/components/ArtifactPanel";
import { ChatArea } from "@/components/ChatArea";
import { InputBox } from "@/components/InputBox";
import { nexusBridge, type Job, type SystemStatus } from "@/lib/nexusBridge";

const active = new Set(["queued", "refining_prompt", "unloading_llm", "generating_image", "generating_video"]);
export default function Home() {
  const [prompt, setPrompt] = useState(""); const [mode, setMode] = useState<"image"|"video">("image"); const [jobs, setJobs] = useState<Job[]>([]); const [status, setStatus] = useState<SystemStatus>(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { nexusBridge.getGallery().then(setJobs).catch(() => undefined); nexusBridge.getStatus().then(setStatus).catch(() => undefined); }, []);
  useEffect(() => { const timer = window.setInterval(() => { nexusBridge.getStatus().then(setStatus).catch(() => undefined); setJobs((current) => { current.filter((job) => active.has(job.status)).forEach((job) => nexusBridge.getJob(job.id).then((updated) => setJobs((items) => items.map((item) => item.id === updated.id ? updated : item))).catch(() => undefined)); return current; }); }, 1500); return () => window.clearInterval(timer); }, []);
  async function submit() { setBusy(true); setError(""); try { const job = await nexusBridge.createJob({ user_prompt:prompt.trim() }, mode); setJobs((current) => [job, ...current]); setPrompt(""); } catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível contactar o Nexus Bridge."); } finally { setBusy(false); } }
  return <div className="shell"><aside className="sidebar"><div className="brand">NEXUS<span>_</span>STUDIO</div><nav className="nav"><button className="active">Workspace</button><button>Gallery</button><button>Settings</button></nav><div className="status"><span className="eyebrow">Bridge status</span><div className="status-row"><span><i className={`dot ${status?.ollama === "ready" ? "ready" : ""}`} />LLM</span><strong>{status?.ollama ?? "..."}</strong></div><div className="status-row"><span><i className={`dot ${status?.fooocus === "ready" ? "ready" : ""}`} />Image</span><strong>{status?.fooocus ?? "..."}</strong></div><div className="status-row"><span><i className={`dot ${status?.ltx_video === "ready" ? "ready" : ""}`} />Video</span><strong>{status?.ltx_video ?? "..."}</strong></div></div></aside><main className="main"><header className="heading"><div><span className="eyebrow">Presentation layer / 01</span><h1>Make something<br />worth seeing.</h1></div><span className="counter">QUEUE {status?.queue_length ?? 0}</span></header><InputBox value={prompt} mode={mode} busy={busy} onChange={setPrompt} onModeChange={setMode} onSubmit={submit} />{error && <p className="error">{error}</p>}<ChatArea jobs={jobs} /></main><ArtifactPanel jobs={jobs} /></div>;
}
