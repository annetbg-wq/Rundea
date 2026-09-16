import React, { FormEvent, useEffect, useState } from "react";

const api = "/api";

type Volume = {
  id: string;
  name: string;
  mountPath: string;
  nodeId: string | null;
  nodeName: string | null;
  createdAt: string;
};

type ApiError = { error?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

function selectedServiceId(): string {
  return localStorage.getItem("rundea:service") ?? "";
}

export function PersistentVolumesPanel() {
  const [serviceId, setServiceId] = useState(selectedServiceId);
  const [open, setOpen] = useState(false);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [name, setName] = useState("data");
  const [mountPath, setMountPath] = useState("/data");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = selectedServiceId();
      setServiceId((current) => current === next ? current : next);
    }, 700);
    return () => window.clearInterval(timer);
  }, []);

  async function refresh(id = serviceId) {
    if (!id) { setVolumes([]); return; }
    const body = await request<{ volumes: Volume[] }>(`/v0/services/${encodeURIComponent(id)}/volumes`);
    setVolumes(body.volumes);
  }

  useEffect(() => {
    if (!open || !serviceId) return;
    void refresh(serviceId).catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [open, serviceId]);

  async function createVolume(event: FormEvent) {
    event.preventDefault();
    if (!serviceId || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await request(`/v0/services/${encodeURIComponent(serviceId)}/volumes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), mountPath: mountPath.trim() }),
      });
      setName("data");
      setMountPath("/data");
      await refresh();
      setMessage("Persistent volume created. Future deployments and rollbacks use the same node-local data.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!serviceId) return null;

  return <>
    <button className="pvTrigger" onClick={() => setOpen(true)}>Persistent storage</button>
    {open && <div className="pvBackdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setOpen(false); }}>
      <section className="pvPanel" role="dialog" aria-modal="true" aria-label="Persistent storage">
        <header>
          <div><small>Stateful runtime</small><h2>Persistent storage</h2><p>Named data volumes survive restart, redeploy and rollback. Once used, they pin this service to the same node.</p></div>
          <button className="pvClose" onClick={() => setOpen(false)} aria-label="Close">×</button>
        </header>

        {message && <div className="pvMessage">{message}</div>}

        <form className="pvCreate" onSubmit={createVolume}>
          <label>Name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="data"/></label>
          <label>Container mount path<input required value={mountPath} onChange={(event) => setMountPath(event.target.value)} placeholder="/var/lib/app/data"/></label>
          <button disabled={busy}>{busy ? "Creating…" : "Create volume"}</button>
        </form>

        <div className="pvSafety"><strong>Data safety</strong><span>Normal deploy, rollback and service archive never delete persistent volumes. Destructive deletion is intentionally not available in this version.</span></div>
        <div className="pvSafety"><strong>Single writer</strong><span>For a stateful revision switch, Rundea stops the previous backend before the new revision mounts the same writable data. This trades a brief restart window for data integrity.</span></div>

        <div className="pvList">
          <div className="pvListHead"><h3>Volumes</h3><button className="pvGhost" onClick={() => void refresh().catch((error) => setMessage(String(error)))}>Refresh</button></div>
          {volumes.length === 0 ? <p className="pvEmpty">No persistent volumes for this service.</p> : volumes.map((volume) => <article key={volume.id} className="pvVolume">
            <div><strong>{volume.name}</strong><code>{volume.mountPath}</code></div>
            <div><small>{volume.nodeName ? `Pinned to ${volume.nodeName}` : "Will pin to the node on first deploy"}</small><small>Created {new Date(volume.createdAt).toLocaleString()}</small></div>
          </article>)}
        </div>
      </section>
    </div>}
  </>;
}
