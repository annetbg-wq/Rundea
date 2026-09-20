import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createNodeInstallCommand } from "./node-install-command";

const api = "/api";

type Section = "overview" | "deploy" | "variables" | "domains" | "nodes" | "observability" | "settings";
type Workspace = { id: string; slug: string; name: string };
type Project = { id: string; workspaceId: string; slug: string; name: string; status: "ACTIVE" | "ARCHIVED" };
type Service = { id: string; projectId: string; slug: string; name: string; status: "ACTIVE" | "ARCHIVED" };
type NodeRow = {
  id: string;
  workspaceId: string;
  name: string;
  status: "ONLINE" | "OFFLINE";
  lifecycleStatus: "ACTIVE" | "MAINTENANCE" | "ARCHIVED";
  lastSeenAt?: string;
  agentVersion?: string;
  agentBuildSha?: string;
  agentCapabilities: string[];
  publicAddresses: string[];
  compatibilityError?: string;
};
type Deployment = {
  id: string;
  service_id: string;
  node_id: string;
  source_repository: string;
  source_ref: string;
  source_delivery: "DIRECT" | "BROKER";
  dockerfile?: string;
  build_args?: Record<string, string>;
  container_port: number;
  healthcheck_path?: string;
  status: string;
  operation: "DEPLOY" | "ROLLBACK";
  source_commit_sha?: string;
  image_id?: string;
  created_at: string;
  updated_at: string;
};
type RuntimeVariable = { key: string; secret: boolean; value?: string };
type VariableDraft = { key: string; value: string; secret: boolean };
type BuildVariableDraft = { key: string; value: string };
type Domain = {
  id: string;
  hostname: string;
  service_id: string;
  node_id: string;
  status: string;
  last_error?: string;
  verified_at?: string;
};
type DeploymentEvent = { id?: number; kind?: string; status?: string; stream?: string; message?: string; created_at?: string };
type Metrics = {
  deploymentId: string;
  deploymentStatus: string;
  runtimeHealth: "HEALTHY" | "DEGRADED" | "DOWN" | null;
  runtimeHealthCheckedAt: string | null;
  restartCount: number;
  uptimeSeconds: number;
  healthError: string | null;
  latest: null | {
    at: string;
    cpuPercent: number;
    memoryUsageBytes: number;
    memoryLimitBytes: number;
    networkRxBytes: number;
    networkTxBytes: number;
  };
  points: unknown[];
};
type Bootstrap = { id: string; name: string; token: string };

type ApiError = { error?: string };

function slugify(value: string) {
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug.length >= 3 ? slug : `${slug || "app"}-01`;
}

function shortId(value?: string) {
  return value ? value.slice(0, 8) : "—";
}

function formatDate(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function bytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    const message = typeof body === "object" && body && "error" in body ? String((body as ApiError).error) : text || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function Status({ value }: { value: string }) {
  return <span className={`cStatus cStatus-${value.toLowerCase()}`}>{value}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="cEmpty">{children}</div>;
}

function domainDnsInstruction(domain: Domain, nodes: NodeRow[]): string {
  const node = nodes.find((item) => item.id === domain.node_id);
  const addresses = node?.publicAddresses ?? [];
  if (!addresses.length) return "DNS target is not available yet; reconnect or update the node Agent so Rundea can discover its public address.";
  return addresses.map((address) => `${address.includes(":") ? "AAAA" : "A"} → ${address}`).join(" · ");
}

export default function CanonicalApp() {
  const [section, setSection] = useState<Section>("overview");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [runtimeVariables, setRuntimeVariables] = useState<RuntimeVariable[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [workspaceId, setWorkspaceId] = useState(() => localStorage.getItem("rundea:workspace") ?? "");
  const [projectId, setProjectId] = useState(() => localStorage.getItem("rundea:project") ?? "");
  const [serviceId, setServiceId] = useState(() => localStorage.getItem("rundea:service") ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);

  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [projectDraft, setProjectDraft] = useState("");
  const [serviceDraft, setServiceDraft] = useState("");
  const [nodeDraft, setNodeDraft] = useState("");
  const [domainDraft, setDomainDraft] = useState("");
  const [runtimeDrafts, setRuntimeDrafts] = useState<VariableDraft[]>([]);
  const [buildDrafts, setBuildDrafts] = useState<BuildVariableDraft[]>([]);
  const [deployForm, setDeployForm] = useState({
    repository: "",
    revision: "main",
    delivery: "DIRECT" as "DIRECT" | "BROKER",
    dockerfile: "",
    containerPort: "8080",
    healthcheckPath: "/health",
    nodeId: "",
  });

  const workspace = workspaces.find((item) => item.id === workspaceId);
  const project = projects.find((item) => item.id === projectId);
  const service = services.find((item) => item.id === serviceId);
  const onlineNodes = nodes.filter((item) => item.lifecycleStatus === "ACTIVE" && item.status === "ONLINE");
  const latestDeployment = deployments[0];
  const readyDeployment = deployments.find((item) => item.status === "READY");
  const secretRuntimeKeys = useMemo(() => new Set(runtimeVariables.filter((item) => item.secret).map((item) => item.key)), [runtimeVariables]);
  const bootstrapInstallCommand = bootstrap ? createNodeInstallCommand(window.location.origin, bootstrap) : null;

  async function refreshWorkspaces() {
    const body = await jsonRequest<{ workspaces: Workspace[] }>("/v0/workspaces");
    setWorkspaces(body.workspaces);
    if (!body.workspaces.some((item) => item.id === workspaceId)) setWorkspaceId(body.workspaces[0]?.id ?? "");
  }

  async function refreshWorkspaceScope(id = workspaceId) {
    if (!id) {
      setProjects([]); setNodes([]); return;
    }
    const [projectBody, nodeBody] = await Promise.all([
      jsonRequest<{ projects: Project[] }>(`/v0/workspaces/${encodeURIComponent(id)}/projects`),
      jsonRequest<{ nodes: NodeRow[] }>(`/v0/workspaces/${encodeURIComponent(id)}/nodes`),
    ]);
    setProjects(projectBody.projects);
    setNodes(nodeBody.nodes);
    if (!projectBody.projects.some((item) => item.id === projectId)) setProjectId(projectBody.projects[0]?.id ?? "");
  }

  async function refreshProjectScope(id = projectId) {
    if (!id) { setServices([]); return; }
    const body = await jsonRequest<{ services: Service[] }>(`/v0/projects/${encodeURIComponent(id)}/services`);
    setServices(body.services);
    if (!body.services.some((item) => item.id === serviceId)) setServiceId(body.services[0]?.id ?? "");
  }

  async function refreshServiceScope(id = serviceId) {
    if (!id) {
      setDeployments([]); setRuntimeVariables([]); setDomains([]); setEvents([]); setMetrics(null); return;
    }
    const [deploymentBody, variableBody, domainBody] = await Promise.all([
      jsonRequest<{ deployments: Deployment[] }>(`/v0/services/${encodeURIComponent(id)}/deployments`),
      jsonRequest<{ variables: RuntimeVariable[] }>(`/v0/services/${encodeURIComponent(id)}/config/variables`),
      jsonRequest<{ domains: Domain[] }>(`/v0/services/${encodeURIComponent(id)}/domains`),
    ]);
    setDeployments(deploymentBody.deployments);
    setRuntimeVariables(variableBody.variables);
    setDomains(domainBody.domains);
  }

  useEffect(() => { void refreshWorkspaces().catch((error) => setMessage(error.message)); }, []);
  useEffect(() => {
    localStorage.setItem("rundea:workspace", workspaceId);
    setProjectId(""); setServiceId(""); setDeployments([]); setRuntimeVariables([]); setDomains([]);
    void refreshWorkspaceScope(workspaceId).catch((error) => setMessage(error.message));
  }, [workspaceId]);
  useEffect(() => {
    localStorage.setItem("rundea:project", projectId);
    setServiceId(""); setDeployments([]); setRuntimeVariables([]); setDomains([]);
    void refreshProjectScope(projectId).catch((error) => setMessage(error.message));
  }, [projectId]);
  useEffect(() => {
    localStorage.setItem("rundea:service", serviceId);
    void refreshServiceScope(serviceId).catch((error) => setMessage(error.message));
  }, [serviceId]);

  useEffect(() => {
    if (!workspaceId) return;
    const timer = window.setInterval(() => void refreshWorkspaceScope(workspaceId).catch(() => undefined), 5000);
    return () => window.clearInterval(timer);
  }, [workspaceId, projectId]);
  useEffect(() => {
    if (!serviceId) return;
    const timer = window.setInterval(() => void refreshServiceScope(serviceId).catch(() => undefined), 3500);
    return () => window.clearInterval(timer);
  }, [serviceId]);

  useEffect(() => {
    const deployment = deployments[0];
    if (!deployment || section !== "observability") { setEvents([]); setMetrics(null); return; }
    let cancelled = false;
    const refreshObservability = async () => {
      try {
        const [eventRows, metricBody] = await Promise.all([
          jsonRequest<DeploymentEvent[]>(`/v0/deployments/${deployment.id}/events`),
          jsonRequest<Metrics>(`/v0/deployments/${deployment.id}/metrics?minutes=60`),
        ]);
        if (!cancelled) { setEvents(eventRows); setMetrics(metricBody); }
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      }
    };
    void refreshObservability();
    const timer = window.setInterval(() => void refreshObservability(), 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [section, deployments[0]?.id]);

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(true); setMessage(label);
    try { await fn(); setMessage(""); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    const name = workspaceDraft.trim(); if (!name) return;
    await act("Creating workspace…", async () => {
      const created = await jsonRequest<Workspace>("/v0/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, slug: slugify(name) }) });
      setWorkspaceDraft(""); await refreshWorkspaces(); setWorkspaceId(created.id);
    });
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    const name = projectDraft.trim(); if (!workspaceId || !name) return;
    await act("Creating project…", async () => {
      const created = await jsonRequest<Project>(`/v0/workspaces/${workspaceId}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, slug: slugify(name) }) });
      setProjectDraft(""); await refreshWorkspaceScope(); setProjectId(created.id);
    });
  }

  async function createService(event: FormEvent) {
    event.preventDefault();
    const name = serviceDraft.trim(); if (!projectId || !name) return;
    await act("Creating service…", async () => {
      const created = await jsonRequest<Service>(`/v0/projects/${projectId}/services`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, slug: slugify(name) }) });
      setServiceDraft(""); await refreshProjectScope(); setServiceId(created.id);
    });
  }

  async function createNode(event: FormEvent) {
    event.preventDefault();
    const name = nodeDraft.trim(); if (!workspaceId || !name) return;
    await act("Creating node…", async () => {
      const created = await jsonRequest<NodeRow & { token: string }>(`/v0/workspaces/${workspaceId}/nodes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      setBootstrap({ id: created.id, name: created.name, token: created.token }); setNodeDraft(""); await refreshWorkspaceScope();
    });
  }

  async function copyBootstrapCommand() {
    if (!bootstrapInstallCommand) {
      setMessage("Open Rundea through its canonical HTTPS address to generate a safe installation command.");
      return;
    }
    try {
      await navigator.clipboard.writeText(bootstrapInstallCommand);
      setMessage("Installation command copied.");
    } catch {
      setMessage("Copy failed. Select the installation command manually.");
    }
  }

  async function archiveNode(node: NodeRow) {
    if (!confirm(`Archive stale node “${node.name}”? Its credential will be revoked.`)) return;
    await act("Archiving node…", async () => {
      await jsonRequest(`/v0/nodes/${node.id}/archive`, { method: "POST" }); await refreshWorkspaceScope();
    });
  }

  async function updateNodeAgent(node: NodeRow) {
    await act(`Updating Agent on ${node.name}…`, async () => {
      await jsonRequest(`/v0/nodes/${node.id}/maintenance/update`, { method: "POST" });
      await refreshWorkspaceScope();
    });
  }

  async function cleanupNode(node: NodeRow) {
    if (!confirm(`Clean and archive node “${node.name}”? Rundea will remove non-durable workload runtime state, revoke the node credential and take the node out of scheduling. Persistent volumes, managed Redis, READY deployments and active domains must be removed first.`)) return;
    await act(`Cleaning ${node.name}…`, async () => {
      await jsonRequest(`/v0/nodes/${node.id}/maintenance/cleanup`, { method: "POST" });
      await refreshWorkspaceScope();
    });
  }

  async function saveRuntimeVariables(event: FormEvent) {
    event.preventDefault(); if (!serviceId) return;
    const variables = runtimeDrafts.filter((row) => row.key.trim()).map((row) => ({ key: row.key.trim(), value: row.value, secret: row.secret }));
    if (!variables.length) return;
    await act("Saving runtime variables…", async () => {
      await jsonRequest(`/v0/services/${serviceId}/config/variables`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ variables }) });
      setRuntimeDrafts([]); await refreshServiceScope();
    });
  }

  async function deleteVariable(key: string) {
    if (!serviceId) return;
    await act("Removing variable…", async () => {
      await jsonRequest(`/v0/services/${serviceId}/config/variables/${encodeURIComponent(key)}`, { method: "DELETE" }); await refreshServiceScope();
    });
  }

  async function deploy(event: FormEvent) {
    event.preventDefault(); if (!serviceId) return;
    const buildArgs = Object.fromEntries(buildDrafts.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));
    const conflicting = Object.keys(buildArgs).find((key) => secretRuntimeKeys.has(key));
    if (conflicting) { setMessage(`${conflicting} is a runtime secret and cannot be exposed as a build variable.`); return; }
    if (deployForm.delivery === "BROKER" && !/^[0-9a-f]{40}$/i.test(deployForm.revision.trim())) {
      setMessage("Brokered delivery requires an exact 40-character commit SHA."); return;
    }
    await act("Queueing deployment…", async () => {
      await jsonRequest(`/v0/services/${serviceId}/deployments`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(deployForm.nodeId ? { nodeId: deployForm.nodeId } : {}),
          sourceRepository: deployForm.repository.trim(), sourceRef: deployForm.revision.trim(), sourceDelivery: deployForm.delivery,
          dockerfile: deployForm.dockerfile.trim(), buildArgs, containerPort: Number(deployForm.containerPort), healthcheckPath: deployForm.healthcheckPath.trim(),
        }),
      });
      await refreshServiceScope(); setSection("overview");
    });
  }

  async function attachDomain(event: FormEvent) {
    event.preventDefault(); if (!serviceId || !domainDraft.trim()) return;
    await act("Attaching domain…", async () => {
      await jsonRequest(`/v0/services/${serviceId}/domains`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostname: domainDraft.trim() }) });
      setDomainDraft(""); await refreshServiceScope();
    });
  }

  async function verifyDomain(domain: Domain) {
    if (!serviceId) return;
    await act(`Verifying ${domain.hostname}…`, async () => {
      await jsonRequest(`/v0/services/${serviceId}/domains/${domain.id}/reconcile`, { method: "POST" });
      await refreshServiceScope();
    });
  }

  async function removeDomain(domain: Domain) {
    if (!serviceId || !confirm(`Remove domain “${domain.hostname}” from this service?`)) return;
    await act(`Removing ${domain.hostname}…`, async () => {
      await jsonRequest(`/v0/services/${serviceId}/domains/${domain.id}`, { method: "DELETE" });
      await refreshServiceScope();
    });
  }

  async function renameProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!project) return;
    const data = new FormData(event.currentTarget); const name = String(data.get("name") ?? "").trim(); if (!name) return;
    await act("Renaming project…", async () => {
      await jsonRequest(`/v0/projects/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); await refreshWorkspaceScope();
    });
  }

  async function archiveProject() {
    if (!project || !confirm(`Archive project “${project.name}” and all of its services?`)) return;
    await act("Archiving project…", async () => {
      await jsonRequest(`/v0/projects/${project.id}/archive`, { method: "POST" }); setProjectId(""); await refreshWorkspaceScope();
    });
  }

  async function archiveService() {
    if (!service || !confirm(`Archive service “${service.name}”?`)) return;
    await act("Archiving service…", async () => {
      await jsonRequest(`/v0/services/${service.id}/archive`, { method: "POST" }); setServiceId(""); await refreshProjectScope();
    });
  }

  const nav: Array<[Section, string]> = [
    ["overview", "Overview"], ["deploy", "Deploy"], ["variables", "Runtime variables"], ["domains", "Domains"],
    ["nodes", "Nodes"], ["observability", "Observability"], ["settings", "Settings"],
  ];

  return <div className="cApp">
    <aside className="cSidebar">
      <div className="cBrand"><span>R</span><div><strong>Rundea</strong><small>Dogfood Gate</small></div></div>
      <div className="cScope">
        <label>Workspace<select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="">Select workspace</option>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Project<select value={projectId} disabled={!workspaceId} onChange={(event) => setProjectId(event.target.value)}><option value="">Select project</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Service<select value={serviceId} disabled={!projectId} onChange={(event) => setServiceId(event.target.value)}><option value="">Select service</option>{services.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
      <nav>{nav.map(([id, label]) => <button key={id} className={section === id ? "active" : ""} disabled={!serviceId && !["nodes", "settings"].includes(id)} onClick={() => setSection(id)}>{label}</button>)}</nav>
      <div className="cSidebarFooter"><span className={onlineNodes.length ? "cDot online" : "cDot"}/>{onlineNodes.length} online node{onlineNodes.length === 1 ? "" : "s"}</div>
    </aside>

    <main className="cMain">
      <header className="cHeader"><div><small>{workspace?.name ?? "No workspace"} / {project?.name ?? "No project"}</small><h1>{service?.name ?? "Rundea setup"}</h1></div><div className="cHeaderMeta">{service && <code>{shortId(service.id)}</code>}{readyDeployment && <Status value="READY"/>}</div></header>
      {message && <div className="cNotice">{message}</div>}

      {!workspaceId && <section className="cPanel cSetup"><h2>Create your first workspace</h2><p>A workspace owns projects, services and nodes. Infrastructure is no longer global.</p><form onSubmit={createWorkspace}><input value={workspaceDraft} onChange={(e) => setWorkspaceDraft(e.target.value)} placeholder="Workspace name"/><button disabled={busy}>Create workspace</button></form></section>}
      {workspaceId && !projectId && <section className="cPanel cSetup"><h2>Create a project</h2><p>Each project gets its own service namespace. Two projects can both have a service called <code>api</code>.</p><form onSubmit={createProject}><input value={projectDraft} onChange={(e) => setProjectDraft(e.target.value)} placeholder="Project name"/><button disabled={busy}>Create project</button></form></section>}
      {projectId && !serviceId && <section className="cPanel cSetup"><h2>Create a service</h2><p>A service owns deployments, variables and domains through a stable UUID.</p><form onSubmit={createService}><input value={serviceDraft} onChange={(e) => setServiceDraft(e.target.value)} placeholder="Service name, e.g. api"/><button disabled={busy}>Create service</button></form></section>}

      {serviceId && section === "overview" && <div className="cGrid">
        <section className="cPanel cHero"><div><small>Current state</small><h2>{readyDeployment ? "Service is live" : latestDeployment ? `Deployment ${latestDeployment.status.toLowerCase()}` : "Ready for first deploy"}</h2><p>{readyDeployment ? `Revision ${shortId(readyDeployment.source_commit_sha ?? readyDeployment.source_ref)} is serving on ${nodes.find((n) => n.id === readyDeployment.node_id)?.name ?? "workspace node"}.` : "Rundea will select an ONLINE workspace node and reserve infrastructure ports automatically."}</p></div><button onClick={() => setSection("deploy")}>{readyDeployment ? "Deploy new revision" : "Deploy service"}</button></section>
        <section className="cPanel cStat"><small>Deployments</small><strong>{deployments.length}</strong><span>{latestDeployment ? `Latest: ${latestDeployment.status}` : "No revisions yet"}</span></section>
        <section className="cPanel cStat"><small>Runtime variables</small><strong>{runtimeVariables.length}</strong><span>{runtimeVariables.filter((v) => v.secret).length} encrypted secret(s)</span></section>
        <section className="cPanel cStat"><small>Domains</small><strong>{domains.length}</strong><span>{domains.filter((d) => d.status === "ACTIVE").length} active</span></section>
        <section className="cPanel cWide"><div className="cPanelTitle"><h3>Recent revisions</h3><button className="ghost" onClick={() => void refreshServiceScope()}>Refresh</button></div>{deployments.length ? <div className="cTable">{deployments.slice(0, 8).map((row) => <div className="cRow" key={row.id}><div><strong>{shortId(row.source_commit_sha ?? row.source_ref)}</strong><small>{row.operation} · {formatDate(row.created_at)}</small></div><code>{nodes.find((n) => n.id === row.node_id)?.name ?? shortId(row.node_id)}</code><Status value={row.status}/></div>)}</div> : <Empty>No deployments yet.</Empty>}</section>
      </div>}

      {serviceId && section === "deploy" && <section className="cPanel"><div className="cPanelTitle"><div><h2>Deploy a revision</h2><p>No host port or infrastructure routing fields are exposed. Node selection defaults to Auto.</p></div></div><form className="cForm" onSubmit={deploy}>
        <label className="span2">Repository URL<input required value={deployForm.repository} onChange={(e) => setDeployForm({ ...deployForm, repository: e.target.value })} placeholder="https://github.com/org/repository.git"/></label>
        <label>Revision<input required value={deployForm.revision} onChange={(e) => setDeployForm({ ...deployForm, revision: e.target.value })} placeholder="main or exact SHA"/></label>
        <label>Source delivery<select value={deployForm.delivery} onChange={(e) => setDeployForm({ ...deployForm, delivery: e.target.value as "DIRECT" | "BROKER" })}><option value="DIRECT">Direct Git</option><option value="BROKER">Rundea broker</option></select></label>
        <label>Node<select value={deployForm.nodeId} onChange={(e) => setDeployForm({ ...deployForm, nodeId: e.target.value })}><option value="">Auto — choose best ONLINE node</option>{onlineNodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label>
        <label>Container port<input required type="number" min="1" max="65535" value={deployForm.containerPort} onChange={(e) => setDeployForm({ ...deployForm, containerPort: e.target.value })}/></label>
        <label>Dockerfile<input value={deployForm.dockerfile} onChange={(e) => setDeployForm({ ...deployForm, dockerfile: e.target.value })} placeholder="auto / Dockerfile"/></label>
        <label>Health path<input value={deployForm.healthcheckPath} onChange={(e) => setDeployForm({ ...deployForm, healthcheckPath: e.target.value })} placeholder="/health"/></label>
        <div className="span2 cSubsection"><div className="cPanelTitle"><div><h3>Build variables</h3><p>Public build-time values only. Never place passwords, tokens or runtime secrets here.</p></div><button type="button" className="ghost" onClick={() => setBuildDrafts((rows) => [...rows, { key: "", value: "" }])}>Add build variable</button></div>{buildDrafts.map((row, index) => <div className="cInline" key={index}><input value={row.key} onChange={(e) => setBuildDrafts((rows) => rows.map((item, i) => i === index ? { ...item, key: e.target.value } : item))} placeholder="NEXT_PUBLIC_API_URL"/><input value={row.value} onChange={(e) => setBuildDrafts((rows) => rows.map((item, i) => i === index ? { ...item, value: e.target.value } : item))} placeholder="value"/><button type="button" className="danger ghost" onClick={() => setBuildDrafts((rows) => rows.filter((_, i) => i !== index))}>Remove</button></div>)}</div>
        <div className="span2 cActions"><button disabled={busy || !onlineNodes.length}>{onlineNodes.length ? "Deploy" : "No ONLINE workspace node"}</button></div>
      </form></section>}

      {serviceId && section === "variables" && <section className="cPanel"><div className="cPanelTitle"><div><h2>Runtime variables</h2><p>Runtime secrets are encrypted. Secret plaintext is never returned by the API after save.</p></div><button className="ghost" onClick={() => setRuntimeDrafts((rows) => [...rows, { key: "", value: "", secret: true }])}>Add variable</button></div>{runtimeVariables.length > 0 && <div className="cTable">{runtimeVariables.map((row) => <div className="cRow cVar" key={row.key}><div><strong>{row.key}</strong><small>{row.secret ? "Encrypted secret" : row.value ?? "Public runtime value"}</small></div><Status value={row.secret ? "SECRET" : "PUBLIC"}/><button className="danger ghost" onClick={() => void deleteVariable(row.key)}>Delete</button></div>)}</div>}<form onSubmit={saveRuntimeVariables}>{runtimeDrafts.map((row, index) => <div className="cInline" key={index}><input value={row.key} onChange={(e) => setRuntimeDrafts((rows) => rows.map((item, i) => i === index ? { ...item, key: e.target.value } : item))} placeholder="DATABASE_URL"/><input type={row.secret ? "password" : "text"} value={row.value} onChange={(e) => setRuntimeDrafts((rows) => rows.map((item, i) => i === index ? { ...item, value: e.target.value } : item))} placeholder="value"/><label className="cCheck"><input type="checkbox" checked={row.secret} onChange={(e) => setRuntimeDrafts((rows) => rows.map((item, i) => i === index ? { ...item, secret: e.target.checked } : item))}/>Secret</label><button type="button" className="danger ghost" onClick={() => setRuntimeDrafts((rows) => rows.filter((_, i) => i !== index))}>Remove</button></div>)}{runtimeDrafts.length > 0 && <div className="cActions"><button disabled={busy}>Save runtime variables</button></div>}</form>{!runtimeVariables.length && !runtimeDrafts.length && <Empty>No runtime variables configured.</Empty>}</section>}

      {serviceId && section === "domains" && <section className="cPanel"><div className="cPanelTitle"><div><h2>Domains</h2><p>Add the hostname, point its DNS A/AAAA record to the selected server’s public IP, then verify. Rundea owns Caddy, obtains TLS automatically and marks the domain ACTIVE only after public HTTPS verification succeeds.</p></div></div><form className="cInline" onSubmit={attachDomain}><input value={domainDraft} onChange={(e) => setDomainDraft(e.target.value)} placeholder="app.example.com"/><button disabled={busy || !readyDeployment}>Add domain</button></form>{domains.length ? <div className="cTable">{domains.map((domain) => <div className="cRow cDomain" key={domain.id}><div><strong>{domain.hostname}</strong><small>{domainDnsInstruction(domain, nodes)}</small><small>{domain.last_error ?? (domain.verified_at ? `Verified over public HTTPS ${formatDate(domain.verified_at)}` : "DNS/TLS verification pending")}</small></div><code>{nodes.find((node) => node.id === domain.node_id)?.name ?? shortId(domain.node_id)}</code><Status value={domain.status}/><div className="cDomainActions">{domain.status !== "DELETING" && <button type="button" className="ghost" disabled={busy} onClick={() => void verifyDomain(domain)}>Verify now</button>}<button type="button" className="danger ghost" disabled={busy || domain.status === "DELETING"} onClick={() => void removeDomain(domain)}>Remove</button></div></div>)}</div> : <Empty>No domains attached.</Empty>}</section>}

      {workspaceId && section === "nodes" && <section className="cPanel"><div className="cPanelTitle"><div><h2>Workspace nodes</h2><p>Only ACTIVE + ONLINE nodes in this workspace are eligible for automatic deployment. Agent update and safe node cleanup are product operations once the node reports the <code>nodeMaintenance</code> capability.</p></div></div><form className="cInline" onSubmit={createNode}><input value={nodeDraft} onChange={(e) => setNodeDraft(e.target.value)} placeholder="Node name"/><button disabled={busy}>Create node</button></form>{bootstrap && <div className="cBootstrap"><strong>Install {bootstrap.name}</strong><p>Run this command once on the target Linux host with sudo access. It contains only the one-time node bootstrap credential; Rundea rotates it before the node becomes ONLINE.</p>{bootstrapInstallCommand ? <><code>{bootstrapInstallCommand}</code><button type="button" className="ghost" onClick={() => void copyBootstrapCommand()}>Copy install command</button></> : <p>Open Rundea through its canonical HTTPS address to generate the installer command.</p>}</div>}<div className="cTable">{nodes.map((node) => { const maintenanceReady = node.agentCapabilities.includes("nodeMaintenance"); return <div className="cRow cNode" key={node.id}><div><strong>{node.name}</strong><small>Last seen: {formatDate(node.lastSeenAt)} · Agent {node.agentVersion ?? "not connected"} {node.agentBuildSha ? `· ${shortId(node.agentBuildSha)}` : ""}</small>{node.publicAddresses?.length > 0 && <small>Public: {node.publicAddresses.join(", ")}</small>}{node.compatibilityError && <em>{node.compatibilityError}</em>}</div><div className="cCaps">{node.agentCapabilities.slice(0, 5).map((cap) => <span key={cap}>{cap}</span>)}</div><Status value={node.lifecycleStatus === "MAINTENANCE" ? "MAINTENANCE" : node.lifecycleStatus === "ARCHIVED" ? "ARCHIVED" : node.status}/><div className="cNodeActions">{node.status === "ONLINE" && node.lifecycleStatus === "ACTIVE" && maintenanceReady ? <><button type="button" className="ghost" disabled={busy} onClick={() => void updateNodeAgent(node)}>Update Agent</button><button type="button" className="danger ghost" disabled={busy} onClick={() => void cleanupNode(node)}>Clean & archive</button></> : node.status === "OFFLINE" && node.lifecycleStatus === "ACTIVE" ? <button className="danger ghost" onClick={() => void archiveNode(node)}>Archive</button> : <span/>}</div></div>; })}</div>{!nodes.length && <Empty>No nodes in this workspace yet.</Empty>}</section>}

      {serviceId && section === "observability" && <section className="cPanel"><div className="cPanelTitle"><div><h2>Observability</h2><p>Live health, restart recovery, runtime telemetry and the exact event/log stream for the latest revision.</p></div></div>{latestDeployment ? <><div className="cMetricGrid"><div data-testid="runtime-health"><small>Runtime health</small><strong><Status value={metrics?.runtimeHealth ?? "UNKNOWN"}/></strong><em>{metrics?.healthError ?? (metrics?.runtimeHealthCheckedAt ? `Checked ${formatDate(metrics.runtimeHealthCheckedAt)}` : "Waiting for health sample")}</em></div><div data-testid="runtime-restarts"><small>Restarts</small><strong>{metrics?.restartCount ?? 0}</strong><em>Automatic recoveries</em></div><div data-testid="runtime-uptime"><small>Uptime</small><strong>{metrics ? `${Math.floor(metrics.uptimeSeconds / 60)}m` : "—"}</strong><em>Current container</em></div><div><small>CPU</small><strong>{metrics?.latest ? `${metrics.latest.cpuPercent.toFixed(1)}%` : "No sample"}</strong></div><div><small>Memory</small><strong>{metrics?.latest ? bytes(metrics.latest.memoryUsageBytes) : "No sample"}</strong></div><div><small>RX / TX</small><strong>{metrics?.latest ? `${bytes(metrics.latest.networkRxBytes)} / ${bytes(metrics.latest.networkTxBytes)}` : "No sample"}</strong></div><div><small>Latest sample</small><strong>{metrics?.latest ? formatDate(metrics.latest.at) : "—"}</strong></div></div><div className="cLogs">{events.map((event, index) => <div key={event.id ?? index}><time>{formatDate(event.created_at)}</time><b>{event.stream ?? event.status ?? event.kind ?? "event"}</b><pre>{event.message ?? event.status ?? ""}</pre></div>)}</div>{!events.length && <Empty>No events yet for the latest revision.</Empty>}</> : <Empty>Deploy a revision to start runtime observability.</Empty>}</section>}

      {workspaceId && section === "settings" && <div className="cGrid"><section className="cPanel"><h2>Create project</h2><form className="cInline" onSubmit={createProject}><input value={projectDraft} onChange={(e) => setProjectDraft(e.target.value)} placeholder="Project name"/><button disabled={busy}>Create</button></form></section>{project && <section className="cPanel"><h2>Project settings</h2><form className="cInline" onSubmit={renameProject}><input name="name" defaultValue={project.name}/><button disabled={busy}>Rename</button></form><button className="danger" onClick={() => void archiveProject()}>Archive project</button></section>}{project && <section className="cPanel"><h2>Create service</h2><form className="cInline" onSubmit={createService}><input value={serviceDraft} onChange={(e) => setServiceDraft(e.target.value)} placeholder="Service name"/><button disabled={busy}>Create</button></form></section>}{service && <section className="cPanel"><h2>Service settings</h2><p><code>{service.id}</code></p><button className="danger" onClick={() => void archiveService()}>Archive service</button></section>}<section className="cPanel"><h2>Create workspace</h2><form className="cInline" onSubmit={createWorkspace}><input value={workspaceDraft} onChange={(e) => setWorkspaceDraft(e.target.value)} placeholder="Workspace name"/><button disabled={busy}>Create</button></form></section></div>}
    </main>
  </div>;
}
