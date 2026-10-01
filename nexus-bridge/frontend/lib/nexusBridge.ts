export type JobKind = "image" | "video";
export type JobStatus = "queued" | "refining_prompt" | "unloading_llm" | "generating_image" | "generating_video" | "completed" | "failed";
export type Job = { id:string; kind:JobKind; user_prompt:string; refined_prompt?:string|null; status:JobStatus; file_path?:string|null; error?:string|null; created_at:string; updated_at:string; };
export type SystemStatus = { ollama:string; fooocus:string; ltx_video:string; queue_length:number; processing_job_id?:string|null };

type GenerateInput = { user_prompt:string; skip_refinement?:boolean };

const baseUrl = process.env.NEXT_PUBLIC_NEXUS_BRIDGE_URL ?? "http://127.0.0.1:8000";

export function artifactUrl(job:Pick<Job, "kind"|"file_path">):string {
  if (!job.file_path) return "";
  const fileName = job.file_path.split(/[\\/]/).pop() ?? "";
  return `${baseUrl}/${job.kind === "video" ? "videos" : "images"}/${encodeURIComponent(fileName)}`;
}

async function request<T>(path:string, init?:RequestInit):Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers:{ "Content-Type":"application/json", ...(init?.headers ?? {}) }, cache:"no-store" });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `Nexus Bridge error (${response.status})`);
  return response.json() as Promise<T>;
}

export const nexusBridge = {
  createJob(input:GenerateInput, kind:JobKind) { return request<Job>(kind === "video" ? "/api/generate-video" : "/api/generate", { method:"POST", body:JSON.stringify(input) }); },
  getJob(id:string) { return request<Job>(`/api/jobs/${id}`); },
  getGallery() { return request<Job[]>("/api/gallery"); },
  getStatus() { return request<SystemStatus>("/api/status"); },
  connectChat(onEvent:(event:unknown) => void, onError?:(event:Event) => void) {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws/chat";
    const socket = new WebSocket(url);
    socket.onmessage = (message) => { try { onEvent(JSON.parse(message.data)); } catch { onEvent(message.data); } };
    if (onError) socket.onerror = onError;
    return socket;
  },
};
