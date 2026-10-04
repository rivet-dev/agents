# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sandbox-agent/foundry-shared build
RUN pnpm --filter acp-http-client build
RUN pnpm --filter @sandbox-agent/cli-shared build
RUN SKIP_OPENAPI_GEN=1 pnpm --filter sandbox-agent build
RUN pnpm --filter @sandbox-agent/foundry-backend build
RUN pnpm --filter @sandbox-agent/foundry-backend deploy --prod /out

FROM oven/bun:1.2 AS runtime
ENV NODE_ENV=production
ENV HOME=/home/task
ENV RIVET_RUNNER_VERSION_FILE=/etc/foundry/rivet-runner-version
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    gh \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN addgroup --system --gid 1001 task \
  && adduser --system --uid 1001 --home /home/task --ingroup task task \
  && mkdir -p /home/task \
  && chown -R task:task /home/task /app
RUN mkdir -p /etc/foundry \
  && date +%s > /etc/foundry/rivet-runner-version
COPY --from=build /out ./
USER task
EXPOSE 7741
CMD ["bun", "dist/index.js", "start", "--host", "0.0.0.0"]
