# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sandbox-agent/foundry-shared build
RUN pnpm --filter acp-http-client build
RUN pnpm --filter @sandbox-agent/cli-shared build
RUN SKIP_OPENAPI_GEN=1 pnpm --filter sandbox-agent build
RUN pnpm --filter @sandbox-agent/react build
RUN pnpm --filter @sandbox-agent/foundry-client build
ENV FOUNDRY_FRONTEND_CLIENT_MODE=mock
RUN pnpm --filter @sandbox-agent/foundry-frontend build

FROM caddy:2.10-alpine AS runtime
COPY foundry/docker/frontend.Caddyfile /etc/caddy/Caddyfile
COPY foundry/docker/frontend-caddy-entrypoint.sh /usr/local/bin/foundry-frontend-entrypoint
COPY --from=build /app/foundry/packages/frontend/dist /srv
RUN chmod +x /usr/local/bin/foundry-frontend-entrypoint
ENV PORT=80
ENV FOUNDRY_FRONTEND_CLIENT_MODE=mock
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/foundry-frontend-entrypoint"]
