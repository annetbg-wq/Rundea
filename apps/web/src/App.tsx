import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { getHelpCopy, normalizeLocale, type HelpTopicId, type Locale } from "./help-registry";
import {
  currentGuideStep,
  getGuideCopy,
  guideSteps,
  initialGuideProgress,
  reconcileGuideProgress,
  restartGuide,
  skipGuideStep,
  type GuideProgress,
  type GuideState,
  type GuideTarget,
} from "./guide";

const api = "/api";
const projectName = "Foundation";
const guideStorageKey = "rundea:guide:foundation:v1";
const localeStorageKey = "rundea:locale:v1";

type Section = "overview" | "deployments" | "variables" | "domains" | "observability" | "nodes" | "settings";
type NodeRow = { id: string; name: string; status: string };
type Deployment = {
  id: string;
  service_name: string;
  node_id: string;
  source_repository?: string;
  source_ref: string;
  source_delivery?: "DIRECT" | "BROKER";
  status: string;
  operation: "DEPLOY" | "ROLLBACK";
  rollback_target_id?: string;
  environment_snapshot_at?: string;
  source_commit_sha?: string;
  image_id?: string;
  created_at: string;
};
type RuntimeAction = {
  id: string;
  deployment_id: string;
  node_id: string;
  kind: "RESTART";
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  error?: string;
  created_at: string;
  completed_at?: string;
};
type VariableDraft = { key: string; value: string; secret: boolean };
type SavedVariable = { key: string; secret: boolean; value?: string };
type Probe = { name: string; host: string; port: number; ok: boolean; latencyMs?: number; error?: string };
type Qualification = {
  id: string;
  status: "RUNNING" | "PASSED" | "FAILED";
  failure_reason?: string;
  started_at: string;
  completed_at?: string;
  probes: Probe[];
};
type Domain = {
  id: string;
  hostname: string;
  service_name: string;
  node_id: string;
  status: "PENDING" | "CONFIGURING" | "ACTIVE" | "FAILED" | "DELETING";
  last_error?: string;
  verified_at?: string;
};
type DeploymentEvent = {
  id?: string;
  kind?: string;
  status?: string;
  stream?: string;
  message?: string;
  created_at?: string;
};
type NodeBootstrap = { id: string; name: string; token: string };

type UiCopy = {
  workspace: string;
  projects: string;
  nodes: string;
  help: string;
  project: string;
  overview: string;
  deployments: string;
  variables: string;
  domains: string;
  observability: string;
  settings: string;
  newDeployment: string;
  live: string;
  noService: string;
  service: string;
  repository: string;
  revision: string;
  delivery: string;
  node: string;
  healthcheck: string;
  deploy: string;
  addVariable: string;
  secret: string;
  readiness: string;
  testEgress: string;
  testing: string;
  customDomains: string;
  attach: string;
  remove: string;
  retry: string;
  openHttps: string;
  recentDeployments: string;
  allDeployments: string;
  restart: string;
  rollback: string;
  logs: string;
  metrics: string;
  comingNext: string;
  createNode: string;
  nodeName: string;
  oneTimeToken: string;
  copyCommand: string;
  language: string;
  guide: string;
  resumeGuide: string;
  restartGuide: string;
  exitGuide: string;
  skipStep: string;
  showMe: string;
  done: string;
  healthy: string;
  onlineNodes: string;
  activeDomains: string;
  nextAction: string;
  immutableRevisions: string;
  encryptedSnapshots: string;
  deploymentStream: string;
  sourceBroker: string;
};

const uiCopy: Record<Locale, UiCopy> = {
  en: {
    workspace: "Default workspace",
    projects: "Projects",
    nodes: "Nodes",
    help: "Help",
    project: "Project",
    overview: "Overview",
    deployments: "Deployments",
    variables: "Variables",
    domains: "Domains",
    observability: "Observability",
    settings: "Settings",
    newDeployment: "New deployment",
    live: "Live control plane",
    noService: "No service yet",
    service: "Service",
    repository: "Repository",
    revision: "Revision",
    delivery: "Source delivery",
    node: "Node",
    healthcheck: "Healthcheck path",
    deploy: "Deploy",
    addVariable: "Add variable",
    secret: "Secret",
    readiness: "Node readiness",
    testEgress: "Test egress",
    testing: "Testing…",
    customDomains: "Custom domains",
    attach: "Attach domain",
    remove: "Remove",
    retry: "Retry",
    openHttps: "Open HTTPS",
    recentDeployments: "Recent deployments",
    allDeployments: "Deployment history",
    restart: "Restart",
    rollback: "Rollback",
    logs: "Deployment events & logs",
    metrics: "Runtime metrics",
    comingNext: "Next observability layer",
    createNode: "Add node",
    nodeName: "Node name",
    oneTimeToken: "One-time bootstrap token",
    copyCommand: "Copy bootstrap command",
    language: "Language",
    guide: "Guided mode",
    resumeGuide: "Resume guide",
    restartGuide: "Restart guide",
    exitGuide: "Exit",
    skipStep: "Skip step",
    showMe: "Show me",
    done: "Guide complete",
    healthy: "Healthy services",
    onlineNodes: "Online nodes",
    activeDomains: "Active domains",
    nextAction: "Next useful action",
    immutableRevisions: "Exact source + image identity",
    encryptedSnapshots: "Encrypted environment snapshot per revision",
    deploymentStream: "State changes and runtime output for one exact revision.",
    sourceBroker: "Brokered source keeps GitHub credentials off your node.",
  },
  ru: {
    workspace: "Рабочее пространство",
    projects: "Проекты",
    nodes: "Серверы",
    help: "Помощь",
    project: "Проект",
    overview: "Обзор",
    deployments: "Развёртывания",
    variables: "Переменные",
    domains: "Домены",
    observability: "Наблюдаемость",
    settings: "Настройки",
    newDeployment: "Новое развёртывание",
    live: "Control Plane активен",
    noService: "Сервис ещё не создан",
    service: "Сервис",
    repository: "Репозиторий",
    revision: "Версия",
    delivery: "Доставка исходников",
    node: "Сервер",
    healthcheck: "Путь проверки здоровья",
    deploy: "Развернуть",
    addVariable: "Добавить переменную",
    secret: "Секрет",
    readiness: "Готовность сервера",
    testEgress: "Проверить сеть",
    testing: "Проверяем…",
    customDomains: "Пользовательские домены",
    attach: "Подключить домен",
    remove: "Удалить",
    retry: "Повторить",
    openHttps: "Открыть HTTPS",
    recentDeployments: "Последние развёртывания",
    allDeployments: "История развёртываний",
    restart: "Перезапуск",
    rollback: "Откат",
    logs: "События и логи развёртывания",
    metrics: "Метрики runtime",
    comingNext: "Следующий слой наблюдаемости",
    createNode: "Добавить сервер",
    nodeName: "Название сервера",
    oneTimeToken: "Одноразовый токен подключения",
    copyCommand: "Скопировать команду подключения",
    language: "Язык",
    guide: "Пошаговый режим",
    resumeGuide: "Продолжить подсказки",
    restartGuide: "Начать подсказки заново",
    exitGuide: "Выйти",
    skipStep: "Пропустить шаг",
    showMe: "Показать",
    done: "Путь завершён",
    healthy: "Рабочие сервисы",
    onlineNodes: "Серверы ONLINE",
    activeDomains: "Активные домены",
    nextAction: "Следующее полезное действие",
    immutableRevisions: "Точная версия исходников и образа",
    encryptedSnapshots: "Зашифрованный снимок окружения для каждой версии",
    deploymentStream: "Переходы состояний и runtime-вывод одной точной версии.",
    sourceBroker: "Брокерская доставка не отдаёт GitHub-доступ вашему серверу.",
  },
};

const probeLabels: Record<string, string> = {
  "smtp-tls": "SMTP 465",
  "smtp-starttls": "SMTP 587",
  "imap-tls": "IMAP 993",
};

function loadGuideProgress(): GuideProgress {
  try {
    const raw = window.localStorage.getItem(guideStorageKey);
    if (!raw) return { ...initialGuideProgress, active: true };
    const parsed = JSON.parse(raw) as Partial<GuideProgress>;
    return {
      active: Boolean(parsed.active),
      completed: Array.isArray(parsed.completed) ? parsed.completed as GuideProgress["completed"] : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped as GuideProgress["skipped"] : [],
      dismissed: Boolean(parsed.dismissed),
    };
  } catch {
    return { ...initialGuideProgress, active: true };
  }
}

function initialLocale(): Locale {
  return normalizeLocale(window.localStorage.getItem(localeStorageKey) ?? navigator.language);
}

function HelpBubble({ topic, locale }: { topic: HelpTopicId; locale: Locale }) {
  const [open, setOpen] = useState(false);
  const copy = getHelpCopy(locale, topic);
  return <span className={`helpWrap ${open ? "open" : ""}`}>
    <button type="button" className="helpButton" aria-label={copy.title} aria-expanded={open} onClick={() => setOpen(value => !value)}>?</button>
    <span className="helpPopover" role="tooltip">
      <strong>{copy.title}</strong>
      <span>{copy.body}</span>
      {copy.action && <small>{copy.action}</small>}
    </span>
  </span>;
}

function StatusPill({ value }: { value: string }) {
  return <span className={`status ${value.toLowerCase()}`}>{value}</span>;
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const c = uiCopy[locale];
  const [activeSection, setActiveSection] = useState<Section>("overview");
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [runtimeActions, setRuntimeActions] = useState<RuntimeAction[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [message, setMessage] = useState("");
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [runtimeBusyId, setRuntimeBusyId] = useState("");
  const [variables, setVariables] = useState<VariableDraft[]>([]);
  const [savedVariables, setSavedVariables] = useState<SavedVariable[]>([]);
  const [qualificationNodeId, setQualificationNodeId] = useState("");
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [qualificationMessage, setQualificationMessage] = useState("");
  const [domainForm, setDomainForm] = useState({ serviceName: "", hostname: "" });
  const [domainMessage, setDomainMessage] = useState("");
  const [form, setForm] = useState({
    serviceName: "",
    nodeId: "",
    sourceRepository: "",
    sourceRef: "main",
    sourceDelivery: "DIRECT" as "DIRECT" | "BROKER",
    dockerfile: "",
    containerPort: "8080",
    hostPort: "18080",
    healthcheckPath: "",
  });
  const [showComposer, setShowComposer] = useState(true);
  const [guideProgress, setGuideProgress] = useState<GuideProgress>(loadGuideProgress);
  const [visitedObservability, setVisitedObservability] = useState(false);
  const [visitedRuntime, setVisitedRuntime] = useState(false);
  const [selectedLogDeploymentId, setSelectedLogDeploymentId] = useState("");
  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [eventsMessage, setEventsMessage] = useState("");
  const [nodeName, setNodeName] = useState("");
  const [nodeBootstrap, setNodeBootstrap] = useState<NodeBootstrap | null>(null);
  const [nodeMessage, setNodeMessage] = useState("");

  async function refresh() {
    const [nodeResponse, deploymentResponse, domainResponse, runtimeResponse] = await Promise.all([
      fetch(`${api}/v0/nodes`),
      fetch(`${api}/v0/deployments`),
      fetch(`${api}/v0/domains`),
      fetch(`${api}/v0/runtime-actions`),
    ]);
    if (nodeResponse.ok) setNodes(await nodeResponse.json());
    if (deploymentResponse.ok) setDeployments(await deploymentResponse.json());
    if (domainResponse.ok) {
      const body = await domainResponse.json() as { domains: Domain[] };
      setDomains(body.domains);
    }
    if (runtimeResponse.ok) {
      const body = await runtimeResponse.json() as { actions: RuntimeAction[] };
      setRuntimeActions(body.actions);
    }
  }

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(id);
  }, []);

  const serviceNames = useMemo(() => {
    const names = new Set<string>();
    deployments.forEach(row => names.add(row.service_name));
    domains.forEach(row => names.add(row.service_name));
    if (form.serviceName.trim()) names.add(form.serviceName.trim());
    return [...names].sort();
  }, [deployments, domains, form.serviceName]);

  useEffect(() => {
    if (!form.serviceName.trim() && serviceNames.length) setForm(current => ({ ...current, serviceName: serviceNames[0]! }));
  }, [serviceNames, form.serviceName]);

  const selectedService = form.serviceName.trim();
  const serviceDeployments = deployments.filter(row => !selectedService || row.service_name === selectedService);
  const serviceDomains = domains.filter(row => !selectedService || row.service_name === selectedService);
  const currentReadyByService = new Map<string, Deployment>();
  for (const deployment of deployments) {
    if (deployment.status === "READY" && !currentReadyByService.has(deployment.service_name)) currentReadyByService.set(deployment.service_name, deployment);
  }
  const currentDeployment = selectedService ? currentReadyByService.get(selectedService) : undefined;
  const selectedNodeId = form.nodeId || currentDeployment?.node_id || "";
  const selectedNode = nodes.find(node => node.id === selectedNodeId);
  const runningActionByNode = new Map(runtimeActions.filter(action => action.status === "RUNNING").map(action => [action.node_id, action]));
  const readyServices = [...currentReadyByService.keys()].sort();
  const domainServiceName = domainForm.serviceName || (readyServices.includes(selectedService) ? selectedService : "");
  const onlineNodeCount = nodes.filter(node => node.status === "ONLINE").length;
  const activeDomainCount = domains.filter(domain => domain.status === "ACTIVE").length;

  useEffect(() => {
    if (selectedNodeId && qualificationNodeId !== selectedNodeId) setQualificationNodeId(selectedNodeId);
  }, [selectedNodeId, qualificationNodeId]);

  async function refreshQualifications(nodeId = qualificationNodeId) {
    if (!nodeId) {
      setQualifications([]);
      return;
    }
    const response = await fetch(`${api}/v0/nodes/${encodeURIComponent(nodeId)}/qualifications`);
    if (!response.ok) return;
    const body = await response.json() as { qualifications: Qualification[] };
    setQualifications(body.qualifications);
  }

  useEffect(() => {
    if (!qualificationNodeId) {
      setQualifications([]);
      return;
    }
    void refreshQualifications(qualificationNodeId);
    const id = window.setInterval(() => void refreshQualifications(qualificationNodeId), 2500);
    return () => window.clearInterval(id);
  }, [qualificationNodeId]);

  async function runQualification() {
    if (!qualificationNodeId) return;
    setQualificationMessage(locale === "ru" ? "Проверяем реальные исходящие маршруты…" : "Testing real outbound connectivity…");
    const response = await fetch(`${api}/v0/nodes/${encodeURIComponent(qualificationNodeId)}/qualifications`, { method: "POST" });
    const body = await response.json();
    setQualificationMessage(response.ok
      ? (locale === "ru" ? "Проверка запущена на выбранном сервере." : "Qualification started on the selected node.")
      : body.error ?? "Qualification could not start");
    if (response.ok) void refreshQualifications(qualificationNodeId);
  }

  async function refreshVariables(serviceName = selectedService) {
    if (!serviceName) {
      setSavedVariables([]);
      return;
    }
    const response = await fetch(`${api}/v0/services/${encodeURIComponent(serviceName)}/variables`);
    if (!response.ok) return;
    const body = await response.json() as { variables: SavedVariable[] };
    setSavedVariables(body.variables);
  }

  useEffect(() => {
    void refreshVariables(selectedService);
  }, [selectedService]);

  function addVariable() {
    setVariables(rows => [...rows, { key: "", value: "", secret: true }]);
  }

  function updateVariable(index: number, patch: Partial<VariableDraft>) {
    setVariables(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  }

  async function saveVariableDrafts() {
    if (!selectedService) return false;
    const changes = variables.filter(value => value.key.trim()).map(value => ({ key: value.key.trim(), value: value.value, secret: value.secret }));
    if (!changes.length) return true;
    const response = await fetch(`${api}/v0/services/${encodeURIComponent(selectedService)}/variables`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variables: changes }),
    });
    const body = await response.json();
    if (!response.ok) {
      setMessage(body.error ?? "Variables could not be saved");
      return false;
    }
    setSavedVariables(body.variables);
    setVariables([]);
    return true;
  }

  async function deleteVariable(key: string) {
    if (!selectedService) return;
    const response = await fetch(`${api}/v0/services/${encodeURIComponent(selectedService)}/variables/${encodeURIComponent(key)}`, { method: "DELETE" });
    if (response.ok) void refreshVariables(selectedService);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(locale === "ru" ? "Подготавливаем развёртывание…" : "Preparing deployment…");
    const serviceName = form.serviceName.trim();
    if (form.sourceDelivery === "BROKER" && !/^[0-9a-fA-F]{40}$/.test(form.sourceRef.trim())) {
      setMessage(locale === "ru" ? "BROKER требует точный 40-символьный SHA коммита." : "BROKER requires an exact 40-character commit SHA.");
      return;
    }
    if (!(await saveVariableDrafts())) return;
    const response = await fetch(`${api}/v0/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serviceName,
        nodeId: form.nodeId,
        sourceRepository: form.sourceRepository.trim(),
        sourceRef: form.sourceRef.trim(),
        sourceDelivery: form.sourceDelivery,
        dockerfile: form.dockerfile.trim(),
        containerPort: Number(form.containerPort),
        hostPort: Number(form.hostPort),
        healthcheckPath: form.healthcheckPath.trim(),
      }),
    });
    const body = await response.json();
    setMessage(response.ok
      ? (locale === "ru" ? `Развёртывание ${body.id} поставлено в очередь.` : `Deployment ${body.id} queued with an immutable environment snapshot.`)
      : body.error ?? "Request failed");
    if (response.ok) {
      setShowComposer(false);
      void refresh();
    }
  }

  async function restartDeployment(deployment: Deployment) {
    setRuntimeBusyId(deployment.id);
    setRuntimeMessage(`${c.restart}: ${deployment.service_name} · ${shortSha(deployment.source_commit_sha)}…`);
    const response = await fetch(`${api}/v0/deployments/${encodeURIComponent(deployment.id)}/restart`, { method: "POST" });
    const body = await response.json();
    setRuntimeBusyId("");
    setRuntimeMessage(response.ok
      ? (locale === "ru" ? "Перезапуск начат; эта же версия должна снова пройти healthcheck." : "Restart started; the same revision must pass its healthcheck again.")
      : body.error ?? "Restart could not start");
    void refresh();
  }

  async function rollbackDeployment(deployment: Deployment) {
    if (!window.confirm(locale === "ru" ? `Откатить ${deployment.service_name} на ${shortSha(deployment.source_commit_sha)}?` : `Roll back ${deployment.service_name} to revision ${shortSha(deployment.source_commit_sha)}?`)) return;
    setRuntimeBusyId(deployment.id);
    setRuntimeMessage(`${c.rollback}: ${shortSha(deployment.source_commit_sha)}…`);
    const response = await fetch(`${api}/v0/deployments/${encodeURIComponent(deployment.id)}/rollback`, { method: "POST" });
    const body = await response.json();
    setRuntimeBusyId("");
    setRuntimeMessage(response.ok
      ? (locale === "ru" ? `Откат ${body.id} поставлен в очередь из сохранённого артефакта.` : `Rollback deployment ${body.id} queued from the retained artifact.`)
      : body.error ?? "Rollback could not start");
    void refresh();
  }

  async function attachDomain(event: FormEvent) {
    event.preventDefault();
    if (!domainServiceName) return;
    setDomainMessage(locale === "ru" ? "Создаём маршрут и запрашиваем HTTPS…" : "Creating route and requesting HTTPS…");
    const response = await fetch(`${api}/v0/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceName: domainServiceName, hostname: domainForm.hostname.trim() }),
    });
    const body = await response.json();
    if (!response.ok) {
      setDomainMessage(body.error ?? "Domain could not be attached");
      return;
    }
    setDomainMessage(locale === "ru" ? "Домен сохранён. ACTIVE появится после проверки DNS и HTTPS." : "Domain saved. ACTIVE appears only after DNS and HTTPS verification.");
    setDomainForm(current => ({ ...current, serviceName: domainServiceName, hostname: "" }));
    void refresh();
  }

  async function reconcileDomain(id: string) {
    setDomainMessage(locale === "ru" ? "Повторно проверяем DNS, Caddy и HTTPS…" : "Rechecking DNS, Caddy and HTTPS…");
    const response = await fetch(`${api}/v0/domains/${encodeURIComponent(id)}/reconcile`, { method: "POST" });
    const body = await response.json();
    setDomainMessage(response.ok ? "Ingress reconciliation started." : body.error ?? "Reconciliation could not start");
    void refresh();
  }

  async function removeDomain(id: string) {
    const response = await fetch(`${api}/v0/domains/${encodeURIComponent(id)}`, { method: "DELETE" });
    const body = await response.json();
    setDomainMessage(response.ok ? (locale === "ru" ? "Удаление маршрута отправлено Agent." : "Route removal sent to the Agent.") : body.error ?? "Domain could not be removed");
    void refresh();
  }

  async function createNode(event: FormEvent) {
    event.preventDefault();
    const name = nodeName.trim();
    if (!name) return;
    setNodeMessage(locale === "ru" ? "Создаём сервер…" : "Creating node…");
    const response = await fetch(`${api}/v0/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await response.json();
    if (!response.ok) {
      setNodeMessage(body.error ?? "Node could not be created");
      return;
    }
    const bootstrap = { id: String(body.id), name, token: String(body.token) };
    setNodeBootstrap(bootstrap);
    setNodeName("");
    setNodeMessage(locale === "ru" ? "Сервер создан. Токен показывается только сейчас." : "Node created. The bootstrap token is shown only now.");
    setForm(current => ({ ...current, nodeId: bootstrap.id }));
    setQualificationNodeId(bootstrap.id);
    void refresh();
  }

  function bootstrapCommand(bootstrap: NodeBootstrap) {
    return `rundea-agent --control-plane https://<your-control-plane> --node-id ${bootstrap.id} --token ${bootstrap.token}`;
  }

  async function copyBootstrap() {
    if (!nodeBootstrap) return;
    try {
      await navigator.clipboard.writeText(bootstrapCommand(nodeBootstrap));
      setNodeMessage(locale === "ru" ? "Команда скопирована." : "Bootstrap command copied.");
    } catch {
      setNodeMessage(locale === "ru" ? "Не удалось скопировать автоматически — выделите команду вручную." : "Clipboard access was unavailable; copy the command manually.");
    }
  }

  async function refreshEvents(deploymentId = selectedLogDeploymentId) {
    if (!deploymentId) {
      setEvents([]);
      return;
    }
    const response = await fetch(`${api}/v0/deployments/${encodeURIComponent(deploymentId)}/events`);
    if (!response.ok) {
      setEventsMessage(locale === "ru" ? "Не удалось получить поток событий." : "Could not load the deployment stream.");
      return;
    }
    const body = await response.json();
    setEvents((Array.isArray(body) ? body : Array.isArray(body.events) ? body.events : []) as DeploymentEvent[]);
    setEventsMessage("");
  }

  useEffect(() => {
    if (!selectedLogDeploymentId && deployments.length) setSelectedLogDeploymentId(deployments[0]!.id);
  }, [deployments, selectedLogDeploymentId]);

  useEffect(() => {
    if (activeSection !== "observability" || !selectedLogDeploymentId) return;
    void refreshEvents(selectedLogDeploymentId);
    const id = window.setInterval(() => void refreshEvents(selectedLogDeploymentId), 2500);
    return () => window.clearInterval(id);
  }, [activeSection, selectedLogDeploymentId]);

  function shortSha(value?: string) {
    return value ? value.slice(0, 7) : "legacy";
  }

  function formatDate(value?: string) {
    if (!value) return "—";
    return new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  }

  function selectService(serviceName: string) {
    setForm(current => ({ ...current, serviceName }));
    setDomainForm(current => ({ ...current, serviceName: readyServices.includes(serviceName) ? serviceName : "" }));
  }

  const latestQualification = qualifications[0];
  const guideState: GuideState = useMemo(() => ({
    repositorySelected: Boolean(form.sourceRepository.trim() || serviceDeployments.length),
    nodeSelected: Boolean(selectedNodeId),
    nodeOnline: selectedNode?.status === "ONLINE",
    variablesConfigured: savedVariables.length > 0 || serviceDeployments.length > 0,
    deploymentCreated: serviceDeployments.length > 0,
    deploymentHealthy: Boolean(currentDeployment),
    domainAttached: serviceDomains.length > 0,
    observabilityOpened: visitedObservability,
    runtimeOpened: visitedRuntime,
  }), [form.sourceRepository, serviceDeployments.length, selectedNodeId, selectedNode?.status, savedVariables.length, currentDeployment, serviceDomains.length, visitedObservability, visitedRuntime]);

  useEffect(() => {
    setGuideProgress(current => {
      const next = reconcileGuideProgress(current, guideState);
      return JSON.stringify(next.completed) === JSON.stringify(current.completed) ? current : next;
    });
  }, [guideState]);

  useEffect(() => window.localStorage.setItem(guideStorageKey, JSON.stringify(guideProgress)), [guideProgress]);
  useEffect(() => window.localStorage.setItem(localeStorageKey, locale), [locale]);

  const guideStep = currentGuideStep(guideProgress, guideState);
  const guideCopy = guideStep ? getGuideCopy(locale, guideStep.id) : null;
  const guideCompletedCount = new Set([...guideProgress.completed, ...guideProgress.skipped]).size;

  function sectionForTarget(target: GuideTarget): Section {
    if (target === "domain") return "domains";
    if (target === "observability") return "observability";
    if (target === "runtime" || target === "healthy") return "deployments";
    if (target === "variables") return "variables";
    if (target === "node" || target === "readiness") return "nodes";
    return "overview";
  }

  function showGuideTarget(target: GuideTarget) {
    const section = sectionForTarget(target);
    setActiveSection(section);
    if (target === "observability") setVisitedObservability(true);
    if (target === "runtime") setVisitedRuntime(true);
    window.setTimeout(() => document.querySelector(`[data-guide="${target}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  }

  function guideClass(target: GuideTarget) {
    return guideProgress.active && guideStep?.target === target ? "guideTarget" : "";
  }

  function navigate(section: Section) {
    setActiveSection(section);
    if (section === "observability") setVisitedObservability(true);
    if (section === "deployments") setVisitedRuntime(true);
  }

  const deploymentList = selectedService ? serviceDeployments : deployments;
  const readyCount = currentReadyByService.size;

  return <div className="appShell">
    <aside className="sidebar">
      <div className="brandRow"><span className="brandMark">R</span><span className="brandName">Rundea</span></div>
      <div className="workspaceLabel">{c.workspace}<span>⌄</span></div>
      <nav className="primaryNav" aria-label="Primary">
        <div className={`primaryNavItem ${activeSection !== "nodes" ? "active" : ""}`}>
          <button type="button" onClick={() => navigate("overview")}><span className="navIcon">⌘</span><span className="navLabel">{c.projects}</span></button>
          <HelpBubble topic="projects" locale={locale}/>
        </div>
        <div className={`primaryNavItem ${activeSection === "nodes" ? "active" : ""}`}>
          <button type="button" onClick={() => navigate("nodes")}><span className="navIcon">◇</span><span className="navLabel">{c.nodes}</span></button>
          <HelpBubble topic="nodes" locale={locale}/>
          <span className="navCount">{nodes.length}</span>
        </div>
      </nav>
      <div className="sidebarSection">
        <span className="sidebarCaption">{c.projects}</span>
        <button type="button" className="projectItem active" onClick={() => navigate("overview")}>
          <span className="projectGlyph">F</span>
          <span><strong>{projectName}</strong><small>{serviceNames.length} {locale === "ru" ? "сервисов" : "services"}</small></span>
        </button>
      </div>
      <div className="sidebarBottom">
        <button type="button" className="sideUtility" onClick={() => setGuideProgress(current => ({ ...current, active: true, dismissed: false }))}><span>?</span><span>{c.help}</span>{!guideProgress.active && <i>•</i>}</button>
        <div className="localeSwitch" aria-label={c.language}><button type="button" className={locale === "en" ? "active" : ""} onClick={() => setLocale("en")}>EN</button><button type="button" className={locale === "ru" ? "active" : ""} onClick={() => setLocale("ru")}>RU</button></div>
      </div>
    </aside>

    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumbs"><span>Rundea</span><b>/</b><strong>{projectName}</strong></div>
        <div className="topActions"><span className="liveState"><i></i>{c.live}</span><button type="button" className="guideButton" onClick={() => setGuideProgress(current => ({ ...current, active: !current.active, dismissed: false }))}>✦ {c.guide}</button><button type="button" className="avatar" aria-label="Account">U</button></div>
      </header>

      <div className="projectHeader">
        <div><span className="eyebrow">{c.project}</span><div className="projectTitleRow"><h1>{projectName}</h1><StatusPill value={currentDeployment ? "READY" : deployments.length ? "BUILDING" : "EMPTY"}/></div><p>GitHub → Rundea Control Plane → your node → Docker</p></div>
        <div className="projectActions"><select aria-label={c.service} value={selectedService} onChange={event => selectService(event.target.value)}><option value="">{c.noService}</option>{serviceNames.map(name => <option key={name} value={name}>{name}</option>)}</select><button type="button" className="primaryAction" onClick={() => { navigate("overview"); setShowComposer(true); }}>+ {c.newDeployment}</button></div>
      </div>

      <nav className="sectionTabs" aria-label="Project sections">{([ ["overview", c.overview], ["deployments", c.deployments], ["variables", c.variables], ["domains", c.domains], ["observability", c.observability], ["settings", c.settings] ] as Array<[Section, string]>).map(([section, label]) => <button type="button" key={section} className={activeSection === section ? "active" : ""} onClick={() => navigate(section)}>{label}</button>)}</nav>

      <div className="contentArea">
        {activeSection === "overview" && <>
          <section className="signalGrid">
            <article className="signalCard"><span>{c.healthy}</span><strong>{readyCount}</strong><small>{readyCount ? "READY revisions" : "Waiting for first READY"}</small></article>
            <article className="signalCard"><span>{c.onlineNodes}</span><strong>{onlineNodeCount}<i>/ {nodes.length}</i></strong><small>{onlineNodeCount ? "Agent connection available" : "Connect a node Agent"}</small></article>
            <article className="signalCard"><span>{c.activeDomains}</span><strong>{activeDomainCount}</strong><small>{domains.length ? `${domains.length} configured` : "No public hostname yet"}</small></article>
            <article className="signalCard accent"><span>{c.nextAction}</span><strong className="nextActionText">{guideCopy?.title ?? (currentDeployment ? c.observability : c.newDeployment)}</strong><button type="button" onClick={() => guideStep ? showGuideTarget(guideStep.target) : setShowComposer(true)}>→</button></article>
          </section>

          <section className="overviewGrid">
            <div className="mainColumn">
              <article className={`panel deployComposer ${guideClass("repository")} ${guideClass("deploy")}`} data-guide="repository">
                <div className="panelHeader"><div><span className="panelEyebrow">SHIP</span><h2>{c.newDeployment}</h2><p>{c.immutableRevisions}. {c.encryptedSnapshots}.</p></div><div className="panelHeaderActions"><HelpBubble topic="deployments" locale={locale}/><button type="button" className="iconButton" onClick={() => setShowComposer(value => !value)}>{showComposer ? "−" : "+"}</button></div></div>
                {showComposer && <form className="deploymentForm" onSubmit={submit}>
                  <div className="fieldGrid two"><label>{c.service}<input required placeholder="api" value={form.serviceName} onChange={event => setForm({ ...form, serviceName: event.target.value })}/></label><label>{c.node}<span className="labelWithHelp"><HelpBubble topic="nodes" locale={locale}/></span><select required data-guide="node" className={guideClass("node")} value={form.nodeId} onChange={event => setForm({ ...form, nodeId: event.target.value })}><option value="">{locale === "ru" ? "Выберите сервер" : "Select node"}</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.name} · {node.status}</option>)}</select></label></div>
                  <label>{c.repository}<span className="labelWithHelp"><HelpBubble topic="github" locale={locale}/></span><input required placeholder="https://github.com/org/repo.git" value={form.sourceRepository} onChange={event => setForm({ ...form, sourceRepository: event.target.value })}/></label>
                  <div className="fieldGrid three"><label>{c.revision}<input required placeholder={form.sourceDelivery === "BROKER" ? "40-char commit SHA" : "main"} value={form.sourceRef} onChange={event => setForm({ ...form, sourceRef: event.target.value })}/></label><label>{c.delivery}<span className="labelWithHelp"><HelpBubble topic="sourceBroker" locale={locale}/></span><select value={form.sourceDelivery} onChange={event => setForm({ ...form, sourceDelivery: event.target.value as "DIRECT" | "BROKER" })}><option value="DIRECT">DIRECT</option><option value="BROKER">BROKER · exact SHA</option></select></label><label>Dockerfile <small>optional</small><input placeholder="Auto-detect" value={form.dockerfile} onChange={event => setForm({ ...form, dockerfile: event.target.value })}/></label></div>
                  <div className="fieldGrid three"><label>Container port<input required type="number" value={form.containerPort} onChange={event => setForm({ ...form, containerPort: event.target.value })}/></label><label>Host port<input required type="number" value={form.hostPort} onChange={event => setForm({ ...form, hostPort: event.target.value })}/></label><label>{c.healthcheck}<span className="labelWithHelp"><HelpBubble topic="healthcheck" locale={locale}/></span><input placeholder="Auto /health" value={form.healthcheckPath} onChange={event => setForm({ ...form, healthcheckPath: event.target.value })}/></label></div>
                  <div className="deployFooter" data-guide="deploy"><div><strong>{form.sourceDelivery === "BROKER" ? "Source Broker" : "Direct Git source"}</strong><small>{form.sourceDelivery === "BROKER" ? c.sourceBroker : "Exact commit identity is persisted after build."}</small></div><button type="submit" className="deployButton" disabled={!form.nodeId}>{c.deploy}<span>↗</span></button></div>
                  {message && <p className="inlineMessage">{message}</p>}
                </form>}
              </article>

              <article className="panel recentPanel"><div className="panelHeader compact"><div><h2>{c.recentDeployments}</h2><p>{selectedService || projectName}</p></div><button type="button" className="textButton" onClick={() => navigate("deployments")}>{c.allDeployments} →</button></div><DeploymentRows deployments={deploymentList.slice(0, 4)} locale={locale} nodes={nodes} currentReadyByService={currentReadyByService}/></article>
            </div>

            <div className="sideColumn">
              <article className={`panel healthPanel ${guideClass("healthy")}`} data-guide="healthy"><div className="panelHeader compact"><div><span className="panelEyebrow">CURRENT</span><h2>{selectedService || c.noService}</h2></div><HelpBubble topic="healthcheck" locale={locale}/></div>{currentDeployment ? <div className="currentRevision"><div className="healthOrb"><span></span></div><div><StatusPill value="READY"/><strong>{shortSha(currentDeployment.source_commit_sha)}</strong><small>{formatDate(currentDeployment.created_at)}</small></div></div> : <div className="emptyState"><span>○</span><strong>No healthy revision</strong><small>READY appears only after the real healthcheck passes.</small></div>}</article>
              <article className="panel trustPanel"><span className="panelEyebrow">TRUST BOUNDARY</span><h2>Credentials stay off the node</h2><p>{c.sourceBroker}</p><div className="trustPath"><span>GitHub App</span><b>→</b><span>Control Plane</span><b>→</b><span>one-time bundle</span><b>→</b><span>Node</span></div></article>
            </div>
          </section>
        </>}

        {activeSection === "deployments" && <section className={`panel pagePanel ${guideClass("runtime")}`} data-guide="runtime">
          <div className="panelHeader page"><div><span className="panelEyebrow">HISTORY</span><h2>{c.allDeployments}</h2><p>{c.immutableRevisions} · {c.encryptedSnapshots}</p></div><HelpBubble topic="deployments" locale={locale}/></div>
          {runtimeMessage && <p className="inlineMessage runtime">{runtimeMessage}</p>}
          <div className="deploymentTable"><div className="tableHead"><span>Revision</span><span>Node</span><span>Status</span><span>Created</span><span></span></div>{deploymentList.length === 0 ? <div className="emptyState wide"><strong>No deployments yet</strong></div> : deploymentList.map(deployment => {
            const current = currentReadyByService.get(deployment.service_name);
            const isCurrent = deployment.status === "READY" && current?.id === deployment.id;
            const nodeBusy = runningActionByNode.has(deployment.node_id);
            const wasHealthy = deployment.status === "READY" || deployment.status === "ROLLED_BACK";
            const rollbackable = wasHealthy && !isCurrent && Boolean(deployment.environment_snapshot_at && deployment.source_commit_sha && deployment.image_id && current && current.node_id === deployment.node_id);
            return <div className="tableRow" key={deployment.id}><div className="revisionCell"><span className="commitGlyph">⑂</span><div><strong>{deployment.service_name} <code>{shortSha(deployment.source_commit_sha)}</code></strong><small>{deployment.operation === "ROLLBACK" ? `rollback ← ${deployment.rollback_target_id?.slice(0, 8) ?? "history"}` : deployment.source_ref}{isCurrent ? " · current" : ""}</small></div></div><span>{nodes.find(node => node.id === deployment.node_id)?.name ?? deployment.node_id.slice(0, 8)}</span><StatusPill value={deployment.status}/><time>{formatDate(deployment.created_at)}</time><div className="rowActions">{isCurrent && <><HelpBubble topic="restart" locale={locale}/><button type="button" disabled={runtimeBusyId === deployment.id || nodeBusy} onClick={() => void restartDeployment(deployment)}>{c.restart}</button></>}{rollbackable && <><HelpBubble topic="rollback" locale={locale}/><button type="button" className="warning" disabled={runtimeBusyId === deployment.id || nodeBusy} onClick={() => void rollbackDeployment(deployment)}>{c.rollback}</button></>}</div></div>;
          })}</div>
        </section>}

        {activeSection === "variables" && <section className={`panel pagePanel ${guideClass("variables")}`} data-guide="variables">
          <div className="panelHeader page"><div><span className="panelEyebrow">CONFIG</span><h2>{c.variables}</h2><p>{selectedService || c.noService} · encrypted at rest · immutable snapshot per deployment</p></div><div className="headerHelp"><HelpBubble topic="variables" locale={locale}/><HelpBubble topic="secrets" locale={locale}/><button type="button" className="secondaryAction" onClick={addVariable}>+ {c.addVariable}</button></div></div>
          {!selectedService ? <div className="emptyState wide"><strong>Select or name a service first</strong></div> : <><div className="variableHeader"><span>KEY</span><span>VALUE</span><span>TYPE</span><span></span></div>{savedVariables.map(variable => <div className="variableSaved" key={variable.key}><code>{variable.key}</code><span>{variable.secret ? "••••••••••••" : variable.value ?? ""}</span><span className="typeBadge">{variable.secret ? "SECRET" : "VARIABLE"}</span><button type="button" aria-label={`Delete ${variable.key}`} onClick={() => void deleteVariable(variable.key)}>×</button></div>)}{variables.map((variable, index) => <div className="variableEditor" key={index}><input aria-label="Variable key" placeholder="KEY" value={variable.key} onChange={event => updateVariable(index, { key: event.target.value })}/><input aria-label="Variable value" placeholder={variable.secret ? "secret value" : "value"} type={variable.secret ? "password" : "text"} value={variable.value} onChange={event => updateVariable(index, { value: event.target.value })}/><label className="secretCheck"><input type="checkbox" checked={variable.secret} onChange={event => updateVariable(index, { secret: event.target.checked })}/><span>{c.secret}</span></label><button type="button" onClick={() => setVariables(rows => rows.filter((_, i) => i !== index))}>×</button></div>)}<div className="configFooter"><span>{savedVariables.length} saved · {variables.length} pending</span><button type="button" className="primaryAction small" disabled={!variables.some(row => row.key.trim())} onClick={() => void saveVariableDrafts()}>{locale === "ru" ? "Сохранить изменения" : "Save changes"}</button></div>{message && <p className="inlineMessage">{message}</p>}</>}
        </section>}

        {activeSection === "domains" && <section className={`panel pagePanel ${guideClass("domain")}`} data-guide="domain">
          <div className="panelHeader page"><div><span className="panelEyebrow">INGRESS</span><h2>{c.customDomains}</h2><p>Managed Caddy · automatic HTTPS · public verification</p></div><HelpBubble topic="domains" locale={locale}/></div>
          <form className="domainAttach" onSubmit={attachDomain}><select required value={domainServiceName} onChange={event => setDomainForm({ ...domainForm, serviceName: event.target.value })}><option value="">READY service</option>{readyServices.map(service => <option key={service} value={service}>{service}</option>)}</select><input required placeholder="api.example.com" value={domainForm.hostname} onChange={event => setDomainForm({ ...domainForm, hostname: event.target.value })}/><button type="submit" className="primaryAction small" disabled={!domainServiceName}>{c.attach}</button></form>
          <p className="sectionNote">DNS must point to the service node. ACTIVE is set only after public TLS reaches the current Rundea reconciliation marker.</p>
          <div className="domainTable">{serviceDomains.length === 0 ? <div className="emptyState wide"><strong>No domains attached</strong><small>Attach one after the service is READY.</small></div> : serviceDomains.map(domain => <div className="domainRow" key={domain.id}><div><strong>{domain.hostname}</strong><small>{domain.service_name} · {nodes.find(node => node.id === domain.node_id)?.name ?? domain.node_id.slice(0, 8)}</small>{domain.last_error && <em>{domain.last_error}</em>}</div><StatusPill value={domain.status}/><div className="rowActions">{domain.status === "ACTIVE" ? <a href={`https://${domain.hostname}`} target="_blank" rel="noreferrer">{c.openHttps}</a> : domain.status !== "DELETING" ? <button type="button" onClick={() => void reconcileDomain(domain.id)}>{c.retry}</button> : null}<button type="button" className="danger" disabled={domain.status === "DELETING"} onClick={() => void removeDomain(domain.id)}>{c.remove}</button></div></div>)}</div>{domainMessage && <p className="inlineMessage">{domainMessage}</p>}
        </section>}

        {activeSection === "observability" && <section className={`observabilityGrid ${guideClass("observability")}`} data-guide="observability">
          <article className="panel logPanel"><div className="panelHeader page"><div><span className="panelEyebrow">STREAM</span><h2>{c.logs}</h2><p>{c.deploymentStream}</p></div><HelpBubble topic="observability" locale={locale}/></div><select className="deploymentPicker" value={selectedLogDeploymentId} onChange={event => setSelectedLogDeploymentId(event.target.value)}><option value="">Select deployment</option>{deployments.map(deployment => <option key={deployment.id} value={deployment.id}>{deployment.service_name} · {shortSha(deployment.source_commit_sha)} · {deployment.status}</option>)}</select><div className="terminal" aria-live="polite">{events.length === 0 ? <div className="terminalEmpty">{eventsMessage || "Waiting for deployment events…"}</div> : events.map((event, index) => <div className="terminalLine" key={event.id ?? `${event.created_at}-${index}`}><time>{event.created_at ? new Date(event.created_at).toLocaleTimeString() : "--:--:--"}</time><span className={`stream ${event.stream ?? event.kind ?? "system"}`}>{event.stream ?? event.kind ?? "EVENT"}</span><code>{event.status ? `[${event.status}] ` : ""}{event.message ?? ""}</code></div>)}</div></article>
          <article className="panel metricsPanel"><div className="panelHeader compact"><div><span className="panelEyebrow">TELEMETRY</span><h2>{c.metrics}</h2></div><HelpBubble topic="metrics" locale={locale}/></div><div className="metricPreview"><div><span>CPU</span><strong>—</strong></div><div><span>Memory</span><strong>—</strong></div><div><span>Network</span><strong>—</strong></div></div><div className="comingCard"><span>↗</span><div><strong>{c.comingNext}</strong><p>{getHelpCopy(locale, "metrics").body}</p></div></div></article>
        </section>}

        {activeSection === "nodes" && <section className="nodesLayout">
          <article className={`panel pagePanel ${guideClass("node")}`} data-guide="node"><div className="panelHeader page"><div><span className="panelEyebrow">COMPUTE</span><h2>{c.nodes}</h2><p>{getHelpCopy(locale, "nodes").body}</p></div><HelpBubble topic="nodes" locale={locale}/></div><div className="nodeList">{nodes.length === 0 ? <div className="emptyState wide"><strong>No nodes yet</strong></div> : nodes.map(node => <button type="button" key={node.id} className={`nodeRow ${selectedNodeId === node.id ? "selected" : ""}`} onClick={() => { setForm(current => ({ ...current, nodeId: node.id })); setQualificationNodeId(node.id); }}><span className={`nodeDot ${node.status.toLowerCase()}`}></span><div><strong>{node.name}</strong><small>{node.id}</small></div><StatusPill value={node.status}/></button>)}</div><form className="addNodeForm" onSubmit={createNode}><input required placeholder={c.nodeName} value={nodeName} onChange={event => setNodeName(event.target.value)}/><button className="secondaryAction" type="submit">+ {c.createNode}</button></form>{nodeBootstrap && <div className="bootstrapBox"><div><span>{c.oneTimeToken}</span><strong>{nodeBootstrap.name}</strong></div><code>{bootstrapCommand(nodeBootstrap)}</code><button type="button" onClick={() => void copyBootstrap()}>{c.copyCommand}</button><small>{locale === "ru" ? "Не сохраняем токен в интерфейсе после перезагрузки." : "Rundea does not persist this plaintext token in the UI after refresh."}</small></div>}{nodeMessage && <p className="inlineMessage">{nodeMessage}</p>}</article>
          <article className={`panel readinessPanel ${guideClass("readiness")}`} data-guide="readiness"><div className="panelHeader compact"><div><span className="panelEyebrow">QUALIFICATION</span><h2>{c.readiness}</h2></div><HelpBubble topic="nodeReadiness" locale={locale}/></div><select value={qualificationNodeId} onChange={event => { setQualificationNodeId(event.target.value); setForm(current => ({ ...current, nodeId: event.target.value })); }}><option value="">{locale === "ru" ? "Выберите сервер" : "Select node"}</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.name} · {node.status}</option>)}</select><div className="readinessHero"><div><span className={`readinessOrb ${selectedNode?.status === "ONLINE" ? "online" : ""}`}></span><div><strong>{selectedNode?.name ?? "No node selected"}</strong><small>{selectedNode?.status === "ONLINE" ? "Agent connected · commands available" : "Agent must be ONLINE"}</small></div></div><button type="button" disabled={!qualificationNodeId || selectedNode?.status !== "ONLINE" || latestQualification?.status === "RUNNING"} onClick={() => void runQualification()}>{latestQualification?.status === "RUNNING" ? c.testing : c.testEgress}</button></div>{latestQualification && <div className="probeGrid">{latestQualification.probes.length ? latestQualification.probes.map(probe => <div className={`probe ${probe.ok ? "pass" : "fail"}`} key={probe.name}><div><strong>{probeLabels[probe.name] ?? probe.name}</strong><small>{probe.host}:{probe.port}</small></div><div><b>{probe.ok ? "PASS" : "FAIL"}</b><small>{probe.latencyMs != null ? `${probe.latencyMs} ms` : probe.error ?? "—"}</small></div></div>) : <div className="probePending">{latestQualification.status === "RUNNING" ? "Agent is checking the required routes…" : latestQualification.failure_reason ?? "No probe result"}</div>}</div>}{qualificationMessage && <p className="inlineMessage">{qualificationMessage}</p>}</article>
        </section>}

        {activeSection === "settings" && <section className="settingsGrid"><article className="panel pagePanel"><div className="panelHeader page"><div><span className="panelEyebrow">PROJECT</span><h2>{c.settings}</h2><p>UI preferences and current deployment defaults.</p></div></div><div className="settingRow"><div><strong>{c.language}</strong><small>Controls interface, help and guided mode copy.</small></div><div className="localeSwitch large"><button type="button" className={locale === "en" ? "active" : ""} onClick={() => setLocale("en")}>English</button><button type="button" className={locale === "ru" ? "active" : ""} onClick={() => setLocale("ru")}>Русский</button></div></div><div className="settingRow"><div><strong>{c.guide}</strong><small>State-driven, non-blocking product walkthrough.</small></div><div className="settingsActions"><button type="button" onClick={() => setGuideProgress(current => ({ ...current, active: true, dismissed: false }))}>{c.resumeGuide}</button><button type="button" onClick={() => setGuideProgress(restartGuide())}>{c.restartGuide}</button></div></div></article><article className="panel capabilityPanel"><span className="panelEyebrow">SOURCE SECURITY</span><h2>Private GitHub source path</h2><ul><li>GitHub App JWT stays in Control Plane</li><li>Installation token scoped to one repository</li><li>Authorization removed before codeload download</li><li>Node receives only a one-time source bundle ticket</li></ul></article></section>}

        {guideProgress.active && <aside className="guideCoach" aria-live="polite"><div className="guideTop"><span>✦ {c.guide}</span><small>{guideCompletedCount}/{guideSteps.length}</small></div>{guideStep && guideCopy ? <><div className="guideProgress"><span style={{ width: `${Math.round((guideCompletedCount / guideSteps.length) * 100)}%` }}></span></div><strong>{guideCopy.title}</strong><p>{guideCopy.body}</p><div className="guideActions"><button type="button" className="guidePrimary" onClick={() => showGuideTarget(guideStep.target)}>{c.showMe}</button><button type="button" onClick={() => setGuideProgress(current => skipGuideStep(current, guideStep.id))}>{c.skipStep}</button><button type="button" onClick={() => setGuideProgress(current => ({ ...current, active: false, dismissed: true }))}>{c.exitGuide}</button></div></> : <><div className="guideDone">✓</div><strong>{c.done}</strong><p>{locale === "ru" ? "Основной путь пройден. Контекстные подсказки остаются доступными по запросу." : "The core path is complete. Contextual help remains available anywhere you need it."}</p><div className="guideActions"><button type="button" onClick={() => setGuideProgress(current => ({ ...current, active: false }))}>{c.exitGuide}</button><button type="button" onClick={() => setGuideProgress(restartGuide())}>{c.restartGuide}</button></div></>}</aside>}
      </div>
    </div>
  </div>;
}

function DeploymentRows({ deployments, locale, nodes, currentReadyByService }: { deployments: Deployment[]; locale: Locale; nodes: NodeRow[]; currentReadyByService: Map<string, Deployment> }) {
  if (!deployments.length) return <div className="emptyState wide"><strong>{locale === "ru" ? "Развёртываний ещё нет" : "No deployments yet"}</strong><small>{locale === "ru" ? "Создайте первую версию выше." : "Create the first revision above."}</small></div>;
  const format = (value: string) => new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  return <div className="recentRows">{deployments.map(deployment => {
    const current = currentReadyByService.get(deployment.service_name)?.id === deployment.id;
    return <div className="recentRow" key={deployment.id}><span className="commitGlyph">⑂</span><div><strong>{deployment.service_name}</strong><small>{deployment.source_commit_sha?.slice(0, 7) ?? deployment.source_ref} · {nodes.find(node => node.id === deployment.node_id)?.name ?? deployment.node_id.slice(0, 8)}</small></div>{current && <span className="currentBadge">CURRENT</span>}<StatusPill value={deployment.status}/><time>{format(deployment.created_at)}</time></div>;
  })}</div>;
}
