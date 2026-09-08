import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { formatMetricBytes, memoryPercent, metricIsStale, networkRateBytesPerSecond, sparklinePath, type MetricPoint } from "./runtime-metrics-utils";

type Deployment = {
  id: string;
  service_name: string;
  source_commit_sha?: string;
  source_ref: string;
  status: string;
  created_at: string;
};

type MetricsResponse = {
  deploymentId: string;
  deploymentStatus: string;
  minutes: number;
  bucketSeconds: number;
  retentionHours: number;
  latest: MetricPoint | null;
  points: MetricPoint[];
};

type Locale = "en" | "ru";

function currentLocale(): Locale {
  return window.localStorage.getItem("rundea:locale:v1") === "ru" ? "ru" : "en";
}

function shortSha(deployment: Deployment): string {
  return deployment.source_commit_sha?.slice(0, 7) ?? deployment.source_ref.slice(0, 12);
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${formatMetricBytes(value)}/s`;
}

function MetricSparkline({ values, label }: { values: number[]; label: string }) {
  const path = sparklinePath(values, 340, 76);
  return <svg className="runtimeSparkline" viewBox="0 0 340 76" role="img" aria-label={label} preserveAspectRatio="none">
    <path className="sparkGrid" d="M 0 75 L 340 75"/>
    {path && <path className="sparkValue" d={path}/>} 
  </svg>;
}

function RuntimeMetricsPanel() {
  const [locale, setLocale] = useState<Locale>(currentLocale);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const copy = locale === "ru" ? {
    title: "Метрики runtime",
    subtitle: "Реальные данные Docker с управляемого сервера",
    deployment: "Развёртывание",
    cpu: "CPU",
    memory: "Память",
    network: "Сеть",
    total: "всего",
    waiting: "Ждём первый реальный sample от Agent…",
    unavailable: "Метрики пока недоступны",
    live: "LIVE",
    stale: "STALE",
    retention: "Сырые samples хранятся 48 часов; длинные окна агрегируются сервером.",
    samples: "samples",
    noDeployments: "Нет развёртываний для наблюдения.",
  } : {
    title: "Runtime metrics",
    subtitle: "Real Docker telemetry from the managed node",
    deployment: "Deployment",
    cpu: "CPU",
    memory: "Memory",
    network: "Network",
    total: "total",
    waiting: "Waiting for the first real Agent sample…",
    unavailable: "Metrics are currently unavailable",
    live: "LIVE",
    stale: "STALE",
    retention: "Raw samples are retained for 48 hours; longer windows are server-downsampled.",
    samples: "samples",
    noDeployments: "No deployments available for observation.",
  };

  useEffect(() => {
    const id = window.setInterval(() => setLocale(currentLocale()), 750);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadDeployments() {
      try {
        const response = await fetch("/api/v0/deployments");
        if (!response.ok) throw new Error(`deployments ${response.status}`);
        const rows = await response.json() as Deployment[];
        if (cancelled) return;
        setDeployments(rows);
        setSelectedId(current => {
          if (current && rows.some(row => row.id === current)) return current;
          return rows.find(row => row.status === "READY")?.id ?? rows[0]?.id ?? "";
        });
      } catch {
        if (!cancelled) setError(copy.unavailable);
      }
    }
    void loadDeployments();
    const id = window.setInterval(() => void loadDeployments(), 10_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [locale]);

  useEffect(() => {
    if (!selectedId) {
      setMetrics(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function loadMetrics() {
      try {
        const response = await fetch(`/api/v0/deployments/${encodeURIComponent(selectedId)}/metrics?minutes=${minutes}`);
        if (!response.ok) throw new Error(`metrics ${response.status}`);
        const body = await response.json() as MetricsResponse;
        if (cancelled) return;
        setMetrics(body);
        setError("");
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError(copy.unavailable);
          setLoading(false);
        }
      }
    }
    setLoading(true);
    void loadMetrics();
    const id = window.setInterval(() => void loadMetrics(), 5_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [selectedId, minutes, locale]);

  const selected = deployments.find(row => row.id === selectedId);
  const points = metrics?.points ?? [];
  const latest = metrics?.latest ?? null;
  const memPercent = memoryPercent(latest);
  const networkRate = networkRateBytesPerSecond(points);
  const stale = metricIsStale(latest);
  const cpuSeries = useMemo(() => points.map(point => point.cpuPercent), [points]);
  const memorySeries = useMemo(() => points.map(point => memoryPercent(point) ?? 0), [points]);
  const sampleCount = points.reduce((sum, point) => sum + point.sampleCount, 0);

  return <div className="runtimeMetricsLive">
    <div className="runtimeMetricsHeader">
      <div><span className="runtimeMetricsEyebrow">TELEMETRY</span><h2>{copy.title}</h2><p>{copy.subtitle}</p></div>
      <span className={`runtimeFreshness ${stale ? "stale" : "live"}`}><i></i>{stale ? copy.stale : copy.live}</span>
    </div>

    <div className="runtimeControls">
      <label>{copy.deployment}<select value={selectedId} onChange={event => setSelectedId(event.target.value)}><option value="">—</option>{deployments.map(row => <option value={row.id} key={row.id}>{row.service_name} · {shortSha(row)} · {row.status}</option>)}</select></label>
      <div className="runtimeWindows" aria-label="Metrics time window">{[15, 60, 360].map(value => <button type="button" key={value} className={minutes === value ? "active" : ""} onClick={() => setMinutes(value)}>{value < 60 ? `${value}m` : `${value / 60}h`}</button>)}</div>
    </div>

    {!selectedId ? <div className="runtimeNoData">{copy.noDeployments}</div> : error ? <div className="runtimeNoData error">{error}</div> : loading && !latest ? <div className="runtimeNoData">{copy.waiting}</div> : !latest ? <div className="runtimeNoData">{copy.waiting}</div> : <>
      <div className="runtimeMetricCards">
        <div><span>{copy.cpu}</span><strong>{latest.cpuPercent.toFixed(1)}%</strong><small>{sampleCount} {copy.samples}</small></div>
        <div><span>{copy.memory}</span><strong>{formatMetricBytes(latest.memoryUsageBytes)}</strong><small>{memPercent === null ? "—" : `${memPercent.toFixed(1)}%`} · {formatMetricBytes(latest.memoryLimitBytes)}</small></div>
        <div><span>{copy.network}</span><strong>{formatRate(networkRate)}</strong><small>↓ {formatMetricBytes(latest.networkRxBytes)} · ↑ {formatMetricBytes(latest.networkTxBytes)} {copy.total}</small></div>
      </div>
      <div className="runtimeCharts">
        <div><div className="runtimeChartLabel"><span>CPU</span><strong>{latest.cpuPercent.toFixed(1)}%</strong></div><MetricSparkline values={cpuSeries} label={`CPU ${minutes} minute history`}/></div>
        <div><div className="runtimeChartLabel"><span>{copy.memory}</span><strong>{memPercent === null ? "—" : `${memPercent.toFixed(1)}%`}</strong></div><MetricSparkline values={memorySeries} label={`Memory ${minutes} minute history`}/></div>
      </div>
    </>}

    <div className="runtimeMetricsFooter"><span>{selected ? `${selected.service_name} · ${shortSha(selected)}` : "—"}</span><span>{copy.retention}</span></div>
  </div>;
}

export function RuntimeMetricsMount() {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    const sync = () => {
      const next = document.querySelector<HTMLElement>(".metricsPanel");
      if (next === current) return;
      current?.classList.remove("metricsLiveMounted");
      current = next;
      current?.classList.add("metricsLiveMounted");
      setTarget(current);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      current?.classList.remove("metricsLiveMounted");
    };
  }, []);

  return target ? createPortal(<RuntimeMetricsPanel/>, target) : null;
}
