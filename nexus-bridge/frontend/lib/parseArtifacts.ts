export type Artifact = { type:"image"|"video"|"code"|"tool"; id?:string; content?:string; url?:string; jobId?:string };

export function parseArtifacts(value:unknown):Artifact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item):Artifact[] => {
    if (!item || typeof item !== "object") return [];
    const event = item as Record<string, unknown>;
    if (event.type === "artifact_ready") return [{ type:event.kind === "video" ? "video" : "image", id:String(event.id ?? ""), url:typeof event.url === "string" ? event.url : undefined, jobId:typeof event.job_id === "string" ? event.job_id : undefined }];
    if (event.type === "code") return [{ type:"code", content:typeof event.content === "string" ? event.content : "" }];
    if (event.type === "tool_call") return [{ type:"tool", content:typeof event.name === "string" ? event.name : "" }];
    return [];
  });
}
