FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@9

# Copy package files for all workspaces
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/packages/inspector/package.json ./frontend/packages/inspector/
COPY sdks/typescript/package.json ./sdks/typescript/
COPY sdks/cli-shared/package.json ./sdks/cli-shared/
COPY sdks/acp-http-client/package.json ./sdks/acp-http-client/
COPY sdks/persist-indexeddb/package.json ./sdks/persist-indexeddb/
COPY sdks/react/package.json ./sdks/react/

# Install dependencies
RUN pnpm install --filter @sandbox-agent/inspector...

# Copy cli-shared source and build it
COPY sdks/cli-shared ./sdks/cli-shared
RUN cd sdks/cli-shared && pnpm exec tsup

# Copy acp-http-client source and build it
COPY sdks/acp-http-client ./sdks/acp-http-client
RUN cd sdks/acp-http-client && pnpm exec tsup

# Copy SDK source (with pre-generated types) and build
COPY sdks/typescript ./sdks/typescript
RUN cd sdks/typescript && pnpm exec tsup

# Copy persist-indexeddb and build (depends on SDK)
COPY sdks/persist-indexeddb ./sdks/persist-indexeddb
RUN cd sdks/persist-indexeddb && pnpm exec tsup

# Copy react and build (depends on SDK)
COPY sdks/react ./sdks/react
RUN cd sdks/react && pnpm exec tsup

# Copy inspector source
COPY frontend/packages/inspector ./frontend/packages/inspector

# Build inspector
RUN cd frontend/packages/inspector && pnpm exec vite build

FROM caddy:alpine
COPY --from=build /app/frontend/packages/inspector/dist /srv/ui
RUN cat > /etc/caddy/Caddyfile <<'EOF'
:80 {
	root * /srv
	file_server
	try_files {path} /ui/index.html
}
EOF
EXPOSE 80
