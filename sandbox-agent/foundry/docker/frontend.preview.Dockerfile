# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

RUN npm install -g pnpm@10.28.2

WORKDIR /workspace/quebec

COPY quebec /workspace/quebec

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sandbox-agent/foundry-shared build
RUN pnpm --filter @sandbox-agent/foundry-client build
RUN pnpm --filter @sandbox-agent/foundry-frontend build

FROM nginx:1.27-alpine

COPY quebec/docker/nginx.preview.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/quebec/packages/frontend/dist /usr/share/nginx/html

EXPOSE 4273
