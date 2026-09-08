export type Locale = "en" | "ru";

export type HelpTopicId =
  | "projects"
  | "deployments"
  | "nodes"
  | "nodeReadiness"
  | "variables"
  | "secrets"
  | "domains"
  | "healthcheck"
  | "restart"
  | "rollback"
  | "github"
  | "sourceBroker"
  | "observability"
  | "metrics";

export type HelpEntry = {
  title: string;
  body: string;
  action?: string;
};

const en: Record<HelpTopicId, HelpEntry> = {
  projects: {
    title: "Projects",
    body: "A project groups the services, nodes, domains and deployment history that belong to one product.",
    action: "Open a project to operate its services from one place.",
  },
  deployments: {
    title: "Deployments",
    body: "A deployment is one exact version of your service running on a node. Rundea keeps its source identity, image and environment snapshot together.",
    action: "Inspect history, restart the current revision or roll back to a retained healthy revision.",
  },
  nodes: {
    title: "Nodes",
    body: "A node is the server where Rundea runs your application. The server can come from any supported provider or from your own VPS.",
    action: "Add a node, connect the Agent and use it as a deployment target.",
  },
  nodeReadiness: {
    title: "Node readiness",
    body: "ONLINE means the Rundea Agent is connected. Workload qualification can additionally prove that provider-specific outbound routes are reachable.",
    action: "Use qualification before moving workloads that depend on restricted network ports.",
  },
  variables: {
    title: "Variables",
    body: "Variables configure your service at runtime. Every deployment captures an immutable encrypted snapshot of the values it started with.",
    action: "Add values before deploying; later edits apply only to future deployments.",
  },
  secrets: {
    title: "Secrets",
    body: "Secrets are encrypted at rest and are never returned in plaintext by the read API.",
    action: "Use secrets for passwords, tokens, private keys and other sensitive values.",
  },
  domains: {
    title: "Domains",
    body: "A custom domain routes public HTTPS traffic to the current healthy service revision through Rundea-managed ingress.",
    action: "Point DNS to the node, attach the hostname and wait for verified HTTPS before ACTIVE appears.",
  },
  healthcheck: {
    title: "Healthcheck",
    body: "Rundea only marks a deployment READY after the application answers its health endpoint successfully.",
    action: "Leave the field empty to use compatible metadata or the /health fallback.",
  },
  restart: {
    title: "Restart",
    body: "Restart keeps the exact same revision and environment, restarts its container and requires the healthcheck to pass again.",
    action: "Use it for a stuck process when you do not want to change code or configuration.",
  },
  rollback: {
    title: "Rollback",
    body: "Rollback creates a new auditable deployment from a previous healthy revision using its exact retained image and encrypted environment snapshot.",
    action: "Use it when the current release is unhealthy or functionally wrong.",
  },
  github: {
    title: "GitHub source",
    body: "Rundea deploys an exact GitHub source revision. Signed push autodeploys are pinned to the pushed commit rather than a moving branch name.",
    action: "Choose the repository and revision that should become the service runtime.",
  },
  sourceBroker: {
    title: "Source Broker",
    body: "Brokered source delivery lets the Control Plane fetch an exact source archive while the node receives no GitHub credential.",
    action: "Use BROKER for exact commit deployments and private-source flows.",
  },
  observability: {
    title: "Observability",
    body: "Deployment events show state changes and runtime logs for a concrete revision, so failures can be traced to the exact operation that produced them.",
    action: "Open a deployment stream while it builds, starts or fails a healthcheck.",
  },
  metrics: {
    title: "Metrics",
    body: "Runtime metrics will add resource and availability telemetry to the event stream. The current v0 proof exposes deployment events and logs first.",
    action: "Use logs and deployment state today; node telemetry is the next observability layer.",
  },
};

const ru: Record<HelpTopicId, HelpEntry> = {
  projects: {
    title: "Проекты",
    body: "Проект объединяет сервисы, серверы, домены и историю развёртываний одного продукта.",
    action: "Откройте проект, чтобы управлять всей его инфраструктурой из одного места.",
  },
  deployments: {
    title: "Развёртывания",
    body: "Развёртывание — это одна точная версия сервиса на конкретном сервере. Rundea хранит вместе исходный коммит, образ и снимок окружения.",
    action: "Здесь можно смотреть историю, перезапускать текущую версию и откатываться на сохранённую рабочую.",
  },
  nodes: {
    title: "Серверы",
    body: "Сервер — машина, на которой Rundea запускает приложение. Это может быть поддерживаемый провайдер или ваш собственный VPS.",
    action: "Добавьте сервер, подключите Agent и выбирайте его целью для развёртывания.",
  },
  nodeReadiness: {
    title: "Готовность сервера",
    body: "ONLINE означает, что Rundea Agent подключён. Дополнительная проверка может доказать доступность нужных конкретному продукту исходящих портов.",
    action: "Запускайте такую проверку перед переносом сервисов, которым нужны ограничиваемые сетевые маршруты.",
  },
  variables: {
    title: "Переменные",
    body: "Переменные настраивают сервис при запуске. Каждое развёртывание сохраняет собственный неизменяемый зашифрованный снимок значений.",
    action: "Добавьте значения до запуска; последующие изменения попадут только в новые развёртывания.",
  },
  secrets: {
    title: "Секреты",
    body: "Секреты шифруются при хранении и не возвращаются открытым текстом через API чтения.",
    action: "Используйте их для паролей, токенов, закрытых ключей и других чувствительных данных.",
  },
  domains: {
    title: "Домены",
    body: "Пользовательский домен направляет публичный HTTPS-трафик на текущую рабочую версию сервиса через управляемый Rundea входящий маршрутизатор.",
    action: "Направьте DNS на сервер, добавьте домен и дождитесь проверки HTTPS до состояния ACTIVE.",
  },
  healthcheck: {
    title: "Проверка здоровья",
    body: "Rundea ставит READY только после того, как приложение успешно ответило на свой health endpoint.",
    action: "Оставьте поле пустым, чтобы использовать совместимые метаданные или запасной путь /health.",
  },
  restart: {
    title: "Перезапуск",
    body: "Перезапуск сохраняет ту же версию и окружение, перезапускает контейнер и снова требует успешную проверку здоровья.",
    action: "Используйте, когда процесс завис, но менять код или настройки не нужно.",
  },
  rollback: {
    title: "Откат",
    body: "Откат создаёт новое отслеживаемое развёртывание из прошлой рабочей версии с её точным сохранённым образом и снимком окружения.",
    action: "Используйте, если текущий релиз сломан или работает неправильно.",
  },
  github: {
    title: "Исходники GitHub",
    body: "Rundea разворачивает точную версию исходников. Автодеплой по подписанному push привязывается к конкретному коммиту, а не к меняющемуся имени ветки.",
    action: "Выберите репозиторий и версию, которые должны стать запущенным сервисом.",
  },
  sourceBroker: {
    title: "Source Broker",
    body: "При брокерской доставке Control Plane получает точный архив исходников, а GitHub-доступ никогда не попадает на пользовательский сервер.",
    action: "Используйте BROKER для точного коммита и приватных исходников.",
  },
  observability: {
    title: "Наблюдаемость",
    body: "События развёртывания показывают переходы состояний и runtime-логи конкретной версии, поэтому сбой можно привязать к точной операции.",
    action: "Откройте поток во время сборки, запуска или проверки здоровья.",
  },
  metrics: {
    title: "Метрики",
    body: "Метрики ресурсов и доступности дополнят поток событий. В текущем v0 сначала доступны реальные события развёртывания и логи.",
    action: "Сейчас используйте логи и состояния; телеметрия сервера — следующий слой наблюдаемости.",
  },
};

export const helpCopy: Record<Locale, Record<HelpTopicId, HelpEntry>> = { en, ru };

export function normalizeLocale(value: string | null | undefined): Locale {
  return value?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function getHelpCopy(locale: Locale, topic: HelpTopicId): HelpEntry {
  return helpCopy[locale]?.[topic] ?? helpCopy.en[topic];
}
