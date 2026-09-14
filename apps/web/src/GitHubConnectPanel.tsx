import React, { FormEvent, useEffect, useMemo, useState } from "react";

const api = "/api";

type RepositoryChoice = {
  installationId: number;
  repositoryId: number;
  fullName: string;
  url: string;
  visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
  defaultBranch: string;
};

type DiscoveredService = {
  name: string;
  path: string;
  dockerfile: string | null;
  manifest: string | null;
  containerPorts: number[];
  buildArgumentNames: string[];
  environmentVariableNames: string[];
  healthcheckPath: string | null;
  confidence: "CONFIRMED" | "HIGH_CONFIDENCE" | "NEEDS_CONFIRMATION";
  evidence: string[];
};

type ProjectSource = {
  projectId: string;
  repositoryFullName: string;
  repositoryUrl: string;
  selectedBranch: string;
  revisionSha: string;
  reviewState: "READY_FOR_REVIEW" | "NEEDS_CONFIRMATION";
  discovery: {
    services?: DiscoveredService[];
  };
};

type CandidateDraft = {
  selected: boolean;
  path: string;
  name: string;
  slug: string;
  containerPort: string;
  healthcheckPath: string;
  dockerfile: string | null;
  buildArgumentNames: string[];
  environmentVariableNames: string[];
  confidence: DiscoveredService["confidence"];
};

type ConfirmedService = {
  id: string;
  name: string;
  slug: string;
  sourcePath: string;
};

type ApiError = { error?: string };

function slugify(value: string) {
  let slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (slug.length < 3) slug = `${slug || "app"}-svc`.slice(0, 64);
  return slug;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    const message = typeof body === "object" && body && "error" in body
      ? String((body as ApiError).error)
      : text || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function draftsFromSource(source: ProjectSource): CandidateDraft[] {
  return (source.discovery.services ?? []).map((service) => ({
    selected: true,
    path: service.path,
    name: service.name,
    slug: slugify(service.name),
    containerPort: service.containerPorts.length === 1 ? String(service.containerPorts[0]) : "",
    healthcheckPath: service.healthcheckPath ?? "",
    dockerfile: service.dockerfile,
    buildArgumentNames: service.buildArgumentNames ?? [],
    environmentVariableNames: service.environmentVariableNames ?? [],
    confidence: service.confidence,
  }));
}

export function GitHubConnectPanel() {
  const [projectId, setProjectId] = useState(() => localStorage.getItem("rundea:project") ?? "");
  const [open, setOpen] = useState(false);
  const [repositories, setRepositories] = useState<RepositoryChoice[]>([]);
  const [selectedRepository, setSelectedRepository] = useState("");
  const [selectedBranch, setSelectedBranch] = useState("");
  const [source, setSource] = useState<ProjectSource | null>(null);
  const [drafts, setDrafts] = useState<CandidateDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState<ConfirmedService[]>([]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = localStorage.getItem("rundea:project") ?? "";
      setProjectId((current) => current === next ? current : next);
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setSource(null);
    setDrafts([]);
    setConfirmed([]);
    if (!projectId) return;
    void request<{ source: ProjectSource | null }>(`/v0/projects/${encodeURIComponent(projectId)}/source`)
      .then((body) => {
        setSource(body.source);
        if (body.source) {
          setSelectedRepository(body.source.repositoryFullName);
          setSelectedBranch(body.source.selectedBranch);
          setDrafts(draftsFromSource(body.source));
        }
      })
      .catch(() => undefined);
  }, [projectId]);

  const selectedCount = drafts.filter((draft) => draft.selected).length;
  const repository = useMemo(
    () => repositories.find((item) => item.fullName === selectedRepository),
    [repositories, selectedRepository],
  );

  async function loadRepositories() {
    if (!projectId) return;
    setBusy(true); setMessage("Loading repositories available to the Rundea GitHub App…");
    try {
      const body = await request<{ repositories: RepositoryChoice[] }>(`/v0/projects/${encodeURIComponent(projectId)}/github/repositories`);
      setRepositories(body.repositories);
      const preferred = body.repositories.find((item) => item.fullName === source?.repositoryFullName) ?? body.repositories[0];
      if (preferred) {
        setSelectedRepository(preferred.fullName);
        setSelectedBranch(source?.repositoryFullName === preferred.fullName ? source.selectedBranch : preferred.defaultBranch);
      }
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function showPanel() {
    setOpen(true);
    if (!repositories.length && projectId) await loadRepositories();
  }

  async function discover(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !selectedRepository) return;
    setBusy(true); setMessage("Inspecting repository and discovering services…"); setConfirmed([]);
    try {
      const body = await request<{ source: ProjectSource }>(`/v0/projects/${encodeURIComponent(projectId)}/source/github`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryFullName: selectedRepository, selectedBranch: selectedBranch || repository?.defaultBranch }),
      });
      setSource(body.source);
      setDrafts(draftsFromSource(body.source));
      setSelectedBranch(body.source.selectedBranch);
      setMessage(body.source.discovery.services?.length ? "Discovery complete. Review the services below before importing." : "No concrete deployable services were discovered.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function updateDraft(index: number, patch: Partial<CandidateDraft>) {
    setDrafts((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  async function confirmServices() {
    if (!projectId) return;
    const selections = drafts.filter((draft) => draft.selected).map((draft) => ({
      path: draft.path,
      name: draft.name.trim(),
      slug: draft.slug.trim(),
      ...(draft.containerPort ? { containerPort: Number(draft.containerPort) } : {}),
      healthcheckPath: draft.healthcheckPath.trim(),
    }));
    if (!selections.length) { setMessage("Select at least one service to import."); return; }
    setBusy(true); setMessage("Creating confirmed Rundea services…");
    try {
      const body = await request<{ services: ConfirmedService[] }>(`/v0/projects/${encodeURIComponent(projectId)}/source/github/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ services: selections }),
      });
      setConfirmed(body.services);
      if (body.services[0]?.id) localStorage.setItem("rundea:service", body.services[0].id);
      setMessage(`${body.services.length} service${body.services.length === 1 ? "" : "s"} imported. Reload Rundea to use them.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button className="ghConnectTrigger" disabled={!projectId} onClick={() => void showPanel()}>
      {source ? `GitHub · ${source.repositoryFullName}` : "Connect GitHub"}
    </button>
    {open && <div className="ghBackdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <section className="ghPanel" role="dialog" aria-modal="true" aria-label="Connect GitHub repository">
        <header><div><small>Project source</small><h2>Connect GitHub</h2><p>Choose a repository. Rundea inspects it and proposes concrete services; nothing is deployed until you confirm.</p></div><button className="ghClose" onClick={() => setOpen(false)}>×</button></header>
        {!projectId && <div className="ghEmpty">Select a project first.</div>}
        {projectId && <form className="ghConnectForm" onSubmit={discover}>
          <label>Repository<select value={selectedRepository} onChange={(event) => {
            const fullName = event.target.value;
            const match = repositories.find((item) => item.fullName === fullName);
            setSelectedRepository(fullName); setSelectedBranch(match?.defaultBranch ?? "");
          }}><option value="">Choose repository</option>{repositories.map((item) => <option key={`${item.installationId}:${item.repositoryId}`} value={item.fullName}>{item.fullName} · {item.visibility.toLowerCase()}</option>)}</select></label>
          <label>Branch<input value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)} placeholder="main"/></label>
          <button disabled={busy || !selectedRepository}>{source?.repositoryFullName === selectedRepository ? "Discover again" : "Connect & discover"}</button>
        </form>}
        {source && <div className="ghSourceMeta"><span><b>{source.repositoryFullName}</b> · {source.selectedBranch}</span><code>{source.revisionSha.slice(0, 12)}</code><span>{source.reviewState.replaceAll("_", " ")}</span></div>}
        {message && <div className="ghMessage">{message}</div>}
        {drafts.length > 0 && <div className="ghCandidates">
          <div className="ghSectionTitle"><div><h3>Discovered services</h3><p>Confirm the name, port and health path. Build/runtime variable names are suggestions only; values are never invented.</p></div><strong>{selectedCount}/{drafts.length} selected</strong></div>
          {drafts.map((draft, index) => <article className={`ghCandidate ${draft.selected ? "selected" : ""}`} key={draft.path}>
            <div className="ghCandidateHead"><label className="ghToggle"><input type="checkbox" checked={draft.selected} onChange={(event) => updateDraft(index, { selected: event.target.checked })}/><span/></label><div><b>{draft.path}</b><small>{draft.dockerfile ?? "No Dockerfile discovered"}</small></div><em>{draft.confidence.replaceAll("_", " ")}</em></div>
            {draft.selected && <div className="ghCandidateGrid">
              <label>Name<input value={draft.name} onChange={(event) => updateDraft(index, { name: event.target.value, slug: slugify(event.target.value) })}/></label>
              <label>Slug<input value={draft.slug} onChange={(event) => updateDraft(index, { slug: event.target.value })}/></label>
              <label>Container port<input type="number" min="1" max="65535" value={draft.containerPort} onChange={(event) => updateDraft(index, { containerPort: event.target.value })} placeholder="confirm port"/></label>
              <label>Health path<input value={draft.healthcheckPath} onChange={(event) => updateDraft(index, { healthcheckPath: event.target.value })} placeholder="/health"/></label>
              <div className="ghSuggestions"><span>Build</span>{draft.buildArgumentNames.length ? draft.buildArgumentNames.map((name) => <code key={name}>{name}</code>) : <small>none</small>}</div>
              <div className="ghSuggestions"><span>Runtime</span>{draft.environmentVariableNames.length ? draft.environmentVariableNames.map((name) => <code key={name}>{name}</code>) : <small>none</small>}</div>
            </div>}
          </article>)}
          <footer><button disabled={busy || selectedCount === 0} onClick={() => void confirmServices()}>Confirm & create services</button></footer>
        </div>}
        {confirmed.length > 0 && <div className="ghConfirmed"><b>Imported:</b>{confirmed.map((item) => <span key={item.id}>{item.name} · {item.sourcePath}</span>)}<button onClick={() => window.location.reload()}>Reload Rundea</button></div>}
      </section>
    </div>}
  </>;
}
