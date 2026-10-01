# Temporary dogfood image for the SignalKit web service.
# This keeps Rundea dogfood self-contained until the SignalKit repository
# connector has write access for its own production Dockerfile.
ARG NODE_VERSION=22
ARG PNPM_VERSION=10.32.1
ARG SIGNALKIT_REPOSITORY=https://github.com/vkpro72ai-create/signalkit.git
ARG SIGNALKIT_REF=c56c29f02ff5b995c4b66d8a643f3d7e9df25555

FROM node:${NODE_VERSION}-alpine AS builder
ARG PNPM_VERSION
ARG SIGNALKIT_REPOSITORY
ARG SIGNALKIT_REF
ARG NEXT_PUBLIC_API_URL=https://api.signalkit.bachopus.com
ARG NEXT_PUBLIC_DEFAULT_LOCALE=en

RUN apk add --no-cache git
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_DEFAULT_LOCALE=${NEXT_PUBLIC_DEFAULT_LOCALE}
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /src
RUN git clone "${SIGNALKIT_REPOSITORY}" . && \
    git checkout --detach "${SIGNALKIT_REF}" && \
    test "$(git rev-parse HEAD)" = "${SIGNALKIT_REF}"

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @signalkit/web build
RUN pnpm --filter @signalkit/web deploy --prod --legacy /deploy/web
RUN cp -r apps/web/.next /deploy/web/.next && \
    cp apps/web/next.config.mjs /deploy/web/next.config.mjs && \
    if [ -d apps/web/public ]; then cp -r apps/web/public /deploy/web/public; fi

FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
RUN apk add --no-cache tini && \
    addgroup --system --gid 1001 signalkit && \
    adduser --system --uid 1001 --ingroup signalkit signalkit

COPY --from=builder --chown=signalkit:signalkit /deploy/web ./

USER signalkit
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
