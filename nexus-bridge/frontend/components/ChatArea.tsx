import type { Job } from "@/lib/nexusBridge";
import { Message } from "./Message";
export function ChatArea({ jobs }:{ jobs:Job[] }) { return <section className="jobs"><div className="eyebrow">Activity / {jobs.length.toString().padStart(2, "0")}</div>{jobs.length === 0 ? <p className="empty">Nenhuma solicitação nesta sessão.</p> : jobs.map((job) => <Message key={job.id} job={job} />)}</section>; }
