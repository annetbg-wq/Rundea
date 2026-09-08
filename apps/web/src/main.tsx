import React, { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const api = "/api";
type NodeRow = { id:string; name:string; status:string };
type Deployment = { id:string; service_name:string; source_ref:string; status:string; created_at:string };
type VariableDraft = { key:string; value:string; secret:boolean };
type SavedVariable = { key:string; secret:boolean; value?:string };
type Probe = { name:string; host:string; port:number; ok:boolean; latencyMs?:number; error?:string };
type Qualification = { id:string; status:"RUNNING"|"PASSED"|"FAILED"; failure_reason?:string; started_at:string; completed_at?:string; probes:Probe[] };

const probeLabels:Record<string,string> = {"smtp-tls":"SMTP 465","smtp-starttls":"SMTP 587","imap-tls":"IMAP 993"};

function App() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [message, setMessage] = useState("");
  const [variables, setVariables] = useState<VariableDraft[]>([]);
  const [savedVariables, setSavedVariables] = useState<SavedVariable[]>([]);
  const [qualificationNodeId, setQualificationNodeId] = useState("");
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [qualificationMessage, setQualificationMessage] = useState("");
  const [form, setForm] = useState({ serviceName:"", nodeId:"", sourceRepository:"", sourceRef:"main", dockerfile:"", containerPort:"8080", hostPort:"18080", healthcheckPath:"" });

  async function refresh() {
    const [n,d] = await Promise.all([fetch(`${api}/v0/nodes`), fetch(`${api}/v0/deployments`)]);
    if (n.ok) setNodes(await n.json());
    if (d.ok) setDeployments(await d.json());
  }
  useEffect(() => { void refresh(); const id=setInterval(()=>void refresh(), 2500); return()=>clearInterval(id); }, []);

  async function refreshQualifications(nodeId=qualificationNodeId) {
    if (!nodeId) { setQualifications([]); return; }
    const response = await fetch(`${api}/v0/nodes/${encodeURIComponent(nodeId)}/qualifications`);
    if (!response.ok) return;
    const body = await response.json() as { qualifications:Qualification[] };
    setQualifications(body.qualifications);
  }
  useEffect(() => {
    if (!qualificationNodeId) { setQualifications([]); return; }
    void refreshQualifications(qualificationNodeId);
    const id=setInterval(()=>void refreshQualifications(qualificationNodeId), 2500);
    return()=>clearInterval(id);
  }, [qualificationNodeId]);

  async function runQualification() {
    if (!qualificationNodeId) return;
    setQualificationMessage("Testing real outbound connectivity…");
    const response = await fetch(`${api}/v0/nodes/${encodeURIComponent(qualificationNodeId)}/qualifications`, {method:"POST"});
    const body = await response.json();
    setQualificationMessage(response.ok ? "Qualification started on the selected node." : body.error ?? "Qualification could not start");
    if (response.ok) void refreshQualifications(qualificationNodeId);
  }

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

  const latestQualification=qualifications[0];
  const selectedNode=nodes.find(node=>node.id===qualificationNodeId);

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

        <div className="rightStack">
          <div className="card readiness">
            <div className="cardTitle"><div><h2>Node readiness</h2><p>Prove network access before moving Sendina.</p></div>{latestQualification&&<span className={`status ${latestQualification.status.toLowerCase()}`}>{latestQualification.status}</span>}</div>
            <label>Node<select value={qualificationNodeId} onChange={e=>{setQualificationNodeId(e.target.value);setQualificationMessage("");}}><option value="">Select node</option>{nodes.map(n=><option key={n.id} value={n.id}>{n.name} · {n.status}</option>)}</select></label>
            <div className="readinessAction"><div>{selectedNode?<><strong>{selectedNode.name}</strong><small>{selectedNode.status==='ONLINE'?"Agent connected":"Agent offline"}</small></>:<><strong>Sendina egress</strong><small>SMTP 465/587 · IMAP 993</small></>}</div><button type="button" className="qualify" disabled={!qualificationNodeId||selectedNode?.status!=="ONLINE"||latestQualification?.status==="RUNNING"} onClick={()=>void runQualification()}>{latestQualification?.status==="RUNNING"?"Testing…":"Test egress"}</button></div>
            {latestQualification?<>
              <div className="probeGrid">{latestQualification.probes.length?latestQualification.probes.map(probe=><div className={`probe ${probe.ok?"pass":"fail"}`} key={probe.name}><div><strong>{probeLabels[probe.name]??probe.name}</strong><small>{probe.host}:{probe.port}</small></div><div className="probeResult"><b>{probe.ok?"PASS":"FAIL"}</b><small>{probe.latencyMs!=null?`${probe.latencyMs} ms`:probe.error??"—"}</small></div></div>):<div className="probePending">{latestQualification.status==="RUNNING"?"Agent is testing the three required routes…":latestQualification.failure_reason??"No probe results returned."}</div>}</div>
              <div className="qualificationMeta"><span>{latestQualification.status==="PASSED"?"This node passes the current Sendina network gate.":latestQualification.status==="FAILED"?"Do not migrate Sendina to this node yet.":"Qualification is running on the node."}</span><time>{new Date(latestQualification.completed_at??latestQualification.started_at).toLocaleString()}</time></div>
            </>:<div className="empty compact">No qualification yet. Run the real egress test on an online node.</div>}
            {qualificationMessage&&<p className="message">{qualificationMessage}</p>}
          </div>

          <div className="card list"><div className="cardTitle"><h2>Deployments</h2><span>live state</span></div>{deployments.length===0?<div className="empty">No deployments yet.</div>:deployments.map(d=><article key={d.id}><div><strong>{d.service_name}</strong><small>{d.source_ref} · {new Date(d.created_at).toLocaleString()}</small></div><span className={`status ${d.status.toLowerCase()}`}>{d.status}</span></article>)}</div>
        </div>
      </section>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
