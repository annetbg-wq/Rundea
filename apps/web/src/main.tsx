import React, { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const controlToken = import.meta.env.VITE_CONTROL_TOKEN ?? "";
type NodeRow = { id:string; name:string; status:string };
type Deployment = { id:string; service_name:string; source_ref:string; status:string; created_at:string };

function App() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ serviceName:"", nodeId:"", sourceRepository:"", sourceRef:"main", dockerfile:"Dockerfile", containerPort:"8080", hostPort:"18080", healthcheckPath:"/health" });

  async function refresh() {
    const [n,d] = await Promise.all([fetch(`${api}/v0/nodes`), fetch(`${api}/v0/deployments`)]);
    if (n.ok) setNodes(await n.json());
    if (d.ok) setDeployments(await d.json());
  }
  useEffect(() => { void refresh(); const id=setInterval(()=>void refresh(), 2500); return()=>clearInterval(id); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); setMessage("Creating deployment…");
    const response = await fetch(`${api}/v0/deployments`, { method:"POST", headers:{"content-type":"application/json", ...(controlToken ? {authorization:`Bearer ${controlToken}`} : {})}, body:JSON.stringify({...form, containerPort:Number(form.containerPort), hostPort:Number(form.hostPort)}) });
    const body = await response.json();
    setMessage(response.ok ? `Deployment ${body.id} queued` : body.error ?? "Request failed");
    if (response.ok) void refresh();
  }

  return <div className="shell">
    <aside><div className="brand">Rundea</div><nav><button className="active">Deployments</button><button>Projects</button><button>Nodes</button><button>Domains</button></nav><div className="foot">infrastructure, without the tax</div></aside>
    <main>
      <header><div><span className="eyebrow">PROJECT</span><h1>Foundation</h1></div><span className="env">v0 control plane</span></header>
      <section className="grid">
        <form className="card" onSubmit={submit}>
          <div className="cardTitle"><h2>New deployment</h2><span>Git → Docker</span></div>
          <label>Service name<input required value={form.serviceName} onChange={e=>setForm({...form,serviceName:e.target.value})}/></label>
          <label>Repository<input required placeholder="https://github.com/org/repo.git" value={form.sourceRepository} onChange={e=>setForm({...form,sourceRepository:e.target.value})}/></label>
          <div className="row"><label>Branch<input required value={form.sourceRef} onChange={e=>setForm({...form,sourceRef:e.target.value})}/></label><label>Dockerfile<input required value={form.dockerfile} onChange={e=>setForm({...form,dockerfile:e.target.value})}/></label></div>
          <label>Node<select required value={form.nodeId} onChange={e=>setForm({...form,nodeId:e.target.value})}><option value="">Select node</option>{nodes.map(n=><option key={n.id} value={n.id}>{n.name} · {n.status}</option>)}</select></label>
          <div className="row"><label>Container port<input required type="number" value={form.containerPort} onChange={e=>setForm({...form,containerPort:e.target.value})}/></label><label>Host port<input required type="number" value={form.hostPort} onChange={e=>setForm({...form,hostPort:e.target.value})}/></label></div>
          <label>Healthcheck path<input required value={form.healthcheckPath} onChange={e=>setForm({...form,healthcheckPath:e.target.value})}/></label>
          <button className="deploy" type="submit">Deploy</button>{message && <p className="message">{message}</p>}
        </form>
        <div className="card list"><div className="cardTitle"><h2>Deployments</h2><span>live state</span></div>{deployments.length===0?<div className="empty">No deployments yet.</div>:deployments.map(d=><article key={d.id}><div><strong>{d.service_name}</strong><small>{d.source_ref} · {new Date(d.created_at).toLocaleString()}</small></div><span className={`status ${d.status.toLowerCase()}`}>{d.status}</span></article>)}</div>
      </section>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
