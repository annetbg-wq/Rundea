import type { Locale } from "./help-registry";

export type GuideStepId =
  | "github"
  | "node"
  | "readiness"
  | "variables"
  | "deploy"
  | "healthy"
  | "domain"
  | "observability"
  | "runtime";

export type GuideTarget =
  | "repository"
  | "node"
  | "readiness"
  | "variables"
  | "deploy"
  | "healthy"
  | "domain"
  | "observability"
  | "runtime";

export type GuideState = {
  repositorySelected: boolean;
  nodeSelected: boolean;
  nodeOnline: boolean;
  variablesConfigured: boolean;
  deploymentCreated: boolean;
  deploymentHealthy: boolean;
  domainAttached: boolean;
  observabilityOpened: boolean;
  runtimeOpened: boolean;
};

export type GuideProgress = {
  active: boolean;
  completed: GuideStepId[];
  skipped: GuideStepId[];
  dismissed: boolean;
};

export type GuideStep = {
  id: GuideStepId;
  target: GuideTarget;
  optional?: boolean;
  isComplete: (state: GuideState) => boolean;
};

export type GuideCopy = {
  title: string;
  body: string;
  done: string;
};

export const guideSteps: GuideStep[] = [
  { id: "github", target: "repository", isComplete: (state) => state.repositorySelected },
  { id: "node", target: "node", isComplete: (state) => state.nodeSelected },
  { id: "readiness", target: "readiness", isComplete: (state) => state.nodeOnline },
  { id: "variables", target: "variables", optional: true, isComplete: (state) => state.variablesConfigured || state.deploymentCreated },
  { id: "deploy", target: "deploy", isComplete: (state) => state.deploymentCreated },
  { id: "healthy", target: "healthy", isComplete: (state) => state.deploymentHealthy },
  { id: "domain", target: "domain", optional: true, isComplete: (state) => state.domainAttached },
  { id: "observability", target: "observability", isComplete: (state) => state.observabilityOpened },
  { id: "runtime", target: "runtime", isComplete: (state) => state.runtimeOpened },
];

const en: Record<GuideStepId, GuideCopy> = {
  github: {
    title: "Choose your GitHub source",
    body: "Enter the repository that should become this service. Signed push deployments are pinned to the exact commit.",
    done: "Repository selected",
  },
  node: {
    title: "Choose where it runs",
    body: "Select a Rundea node. A node is your server, not a locked-in platform runtime.",
    done: "Node selected",
  },
  readiness: {
    title: "Confirm the node is ready",
    body: "The Agent must be ONLINE before Rundea can execute deployment commands on this server.",
    done: "Node online",
  },
  variables: {
    title: "Add runtime configuration if needed",
    body: "Add environment values before deploying. Secrets stay encrypted and each revision captures its own snapshot.",
    done: "Configuration ready",
  },
  deploy: {
    title: "Create the first deployment",
    body: "Rundea will fetch the source, build the image, start the container and run the healthcheck.",
    done: "Deployment created",
  },
  healthy: {
    title: "Wait for a healthy revision",
    body: "READY is only reached after the application answers its healthcheck successfully.",
    done: "Healthy revision ready",
  },
  domain: {
    title: "Attach a domain",
    body: "Point DNS to the node and attach the hostname. Rundea activates it only after public HTTPS verification.",
    done: "Domain attached",
  },
  observability: {
    title: "Open the deployment stream",
    body: "Inspect state transitions and runtime logs for the exact revision you just deployed.",
    done: "Observability opened",
  },
  runtime: {
    title: "Know your recovery controls",
    body: "Restart keeps the same revision. Rollback creates a new deployment from a retained healthy image and environment snapshot.",
    done: "Recovery controls understood",
  },
};

const ru: Record<GuideStepId, GuideCopy> = {
  github: {
    title: "Выберите исходники в GitHub",
    body: "Укажите репозиторий этого сервиса. Автодеплой по подписанному push всегда привязывается к точному коммиту.",
    done: "Репозиторий выбран",
  },
  node: {
    title: "Выберите, где запускать сервис",
    body: "Укажите сервер Rundea. Это ваш сервер, а не закрытая среда конкретного PaaS-провайдера.",
    done: "Сервер выбран",
  },
  readiness: {
    title: "Проверьте готовность сервера",
    body: "Agent должен быть ONLINE, прежде чем Rundea сможет выполнять на сервере команды развёртывания.",
    done: "Сервер подключён",
  },
  variables: {
    title: "Добавьте настройки, если они нужны",
    body: "Задайте переменные до запуска. Секреты шифруются, а каждая версия получает собственный неизменяемый снимок окружения.",
    done: "Настройки готовы",
  },
  deploy: {
    title: "Создайте первое развёртывание",
    body: "Rundea получит исходники, соберёт образ, запустит контейнер и выполнит проверку здоровья.",
    done: "Развёртывание создано",
  },
  healthy: {
    title: "Дождитесь рабочей версии",
    body: "Состояние READY появляется только после успешного ответа приложения на healthcheck.",
    done: "Рабочая версия готова",
  },
  domain: {
    title: "Подключите домен",
    body: "Направьте DNS на сервер и добавьте имя. Rundea активирует его только после публичной проверки HTTPS.",
    done: "Домен добавлен",
  },
  observability: {
    title: "Откройте поток событий",
    body: "Посмотрите переходы состояний и runtime-логи именно той версии, которую вы запустили.",
    done: "Наблюдаемость открыта",
  },
  runtime: {
    title: "Разберитесь с восстановлением",
    body: "Restart оставляет ту же версию. Rollback создаёт новое развёртывание из сохранённого рабочего образа и снимка окружения.",
    done: "Управление восстановлением понятно",
  },
};

export const guideCopy: Record<Locale, Record<GuideStepId, GuideCopy>> = { en, ru };

export const initialGuideProgress: GuideProgress = {
  active: false,
  completed: [],
  skipped: [],
  dismissed: false,
};

export function reconcileGuideProgress(progress: GuideProgress, state: GuideState): GuideProgress {
  const completed = new Set(progress.completed);
  for (const step of guideSteps) {
    if (step.isComplete(state)) completed.add(step.id);
  }
  return { ...progress, completed: [...completed] };
}

export function currentGuideStep(progress: GuideProgress, state: GuideState): GuideStep | null {
  const reconciled = reconcileGuideProgress(progress, state);
  if (!reconciled.active) return null;
  const completed = new Set(reconciled.completed);
  const skipped = new Set(reconciled.skipped);
  return guideSteps.find((step) => !completed.has(step.id) && !skipped.has(step.id)) ?? null;
}

export function skipGuideStep(progress: GuideProgress, stepId: GuideStepId): GuideProgress {
  if (progress.skipped.includes(stepId)) return progress;
  return { ...progress, skipped: [...progress.skipped, stepId] };
}

export function restartGuide(): GuideProgress {
  return { active: true, completed: [], skipped: [], dismissed: false };
}

export function getGuideCopy(locale: Locale, stepId: GuideStepId): GuideCopy {
  return guideCopy[locale]?.[stepId] ?? guideCopy.en[stepId];
}
