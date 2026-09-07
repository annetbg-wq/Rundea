import React, { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const api = "/api";
type NodeRow = { id:string; name:string; status:string };
type Deployment = { id:string; service_name:string; source_ref:string; status:string; created_at:string };
type VariableDraft = { key:string; value:string; secret:boolean };
type SavedVariable = { key:string; secret:boolean; value?:string };

function App() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [message, setMessage] = useState("");
  const [variables, setVariables] = useState<VariableDraft[]>([]);
  const [savedVariables, setSavedVariables] = useState<SavedVariable[]>([]);
  const [form, setForm] = useState({ serviceName:"", nodeId:"", sourceRepository:"", sourceRef:"main", dockerfile:"", containerPort:"8080", hostPort:"18080", healthcheckPath:"" });

  async function refresh() {
    const [n,d] = await Promise.all([fetch(`${api}/v0/nodes`), fetch(`${api}/v0/deployments`)]);
    if (n.ok) setNodes(await n.json());
    if (d.ok) setDeployments(await d.json());
  }
  useEffect(() => { void refresh(); const id=setInterval(()=>void refresh(), 2500); return()=>clearInterval(id); }, []);

  async function refreshVariables() {
    if (!form.serviceName.trim()) { setSavedVariables([]); return; }
    const response = await fetch(`${api}/v0/services/${encodeURIComponent(form.serviceName.trim())}/variables`);
    if (!response.ok) return;
    const body = await response.json() as { variables: SavedVariable[] };
    setSavedVariables(body.variables);
  }

  function addVariable() {
    setVariables(rows => [...rows, { key:"", value:"", secret:true }]);
  }

  function updateVariable(index:number, patch:Partial<VariableDraft>) {
    setVariables(rows => rows.map((row,i)=>i===index?{...row,...patch}:row));
  }

  async function deleteVariable(key:string) {
    if (!form.serviceName.trim()) return;
    const response = await fetch(`${api}/v0/services/${encodeURIComponent(form.serviceName.trim())}/variables/${encodeURIComponent(key)}`, { method:"DELETE" });
    if (response.ok) void refreshVariables();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage("Preparing deployment…");
    const serviceName = form.serviceName.trim();
    const variableChanges = variables.filter(v=>v.key.trim()).map(v=>({key:v.key.trim(),value:v.value,secret:v.secret}));
    if (variableChanges.length) {
      const variablesResponse = await fetch(`${api}/v0/services/${encodeURIComponent(serviceName)}/variables`, {
        method:"PUT", headers:{"content-type":"application/json"}, body:JSON.stringify({variables:variableChanges}),
      });
      const variablesBody = await variablesResponse.json();
      if (!variablesResponse.ok) { setMessage(variablesBody.error ?? "Variables could not be saved"); return; }
      setSavedVariables(variablesBody.variables);
      setVariables([]);
    }

    setMessage("Creating deployment…");
    const payload = {
      serviceName,
      nodeId: form.nodeId,
      sourceRepository: form.sourceRepository.trim(),
      sourceRef: form.sourceRef.trim(),
      dockerfile: form.dockerfile.trim(),
      containerPort:Number(form.containerPort),
      hostPort:Number(form.hostPort),
      healthcheckPath:form.healthcheckPath.trim(),
    };
    const response = await fetch(`${api}/v0/deployments`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(payload) });
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
          <label>Service name<input required value={form.serviceName} onBlur={()=>void refreshVariables()} onChange={e=>setForm({...form,serviceName:e.target.value})}/></label>
          <label>Repository<input required placeholder="https://github.com/org/repo.git" value={form.sourceRepository} onChange={e=>setForm({...form,sourceRepository:e.target.value})}/></label>
          <div className="row"><label>Branch<input required value={form.sourceRef} onChange={e=>setForm({...form,sourceRef:e.target.value})}/></label><label>Dockerfile <em>optional</em><input placeholder="Auto-detect" value={form.dockerfile} onChange={e=>setForm({...form,dockerfile:e.target.value})}/></label></div>
          <label>Node<select required value={form.nodeId} onChange={e=>setForm({...form,nodeId:e.target.value})}><option value="">Select node</option>{nodes.map(n=><option key={n.id} value={n.id}>{n.name} · {n.status}</option>)}</select></label>
          <div className="row"><label>Container port<input required type="number" value={form.containerPort} onChange={e=>setForm({...form,containerPort:e.target.value})}/></label><label>Host port<input required type="number" value={form.hostPort} onChange={e=>setForm({...form,hostPort:e.target.value})}/></label></div>
          <label>Healthcheck path <em>optional</em><input placeholder="Auto-detect / fallback /health" value={form.healthcheckPath} onChange={e=>setForm({...form,healthcheckPath:e.target.value})}/></label>

          <div className="sectionHead"><div><strong>Environment</strong><small>encrypted at rest · secrets never read back</small></div><button type="button" className="quiet" onClick={addVariable}>+ Add variable</button></div>
          {savedVariables.length>0 && <div className="savedVars">{savedVariables.map(v=><span key={v.key}><b>{v.key}</b><i>{v.secret?"secret":"variable"}</i><button type="button" aria-label={`Delete ${v.key}`} onClick={()=>void deleteVariable(v.key)}>×</button></span>)}</div>}
          {variables.map((variable,index)=><div className="variableRow" key={index}>
            <input aria-label="Variable key" placeholder="KEY" value={variable.key} onChange={e=>updateVariable(index,{key:e.target.value})}/>
            <input aria-label="Variable value" placeholder={variable.secret?"secret value":"value"} type={variable.secret?"password":"text"} value={variable.value} onChange={e=>updateVariable(index,{value:e.target.value})}/>
            <label className="secretToggle"><input type="checkbox" checked={variable.secret} onChange={e=>updateVariable(index,{secret:e.target.checked})}/><span>Secret</span></label>
            <button type="button" className="remove" onClick={()=>setVariables(rows=>rows.filter((_,i)=>i!==index))}>×</button>
          </div>)}

          <button className="deploy" type="submit">Deploy</button>{message && <p className="message">{message}</p>}
        </form>
        <div className="card list"><div className="cardTitle"><h2>Deployments</h2><span>live state</span></div>{deployments.length===0?<div className="empty">No deployments yet.</div>:deployments.map(d=><article key={d.id}><div><strong>{d.service_name}</strong><small>{d.source_ref} · {new Date(d.created_at).toLocaleString()}</small></div><span className={`status ${d.status.toLowerCase()}`}>{d.status}</span></article>)}</div>
      </section>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
