FROM node:22-alpine AS build
WORKDIR /app
# git is required for pnpm to resolve the github: @rivet-dev/docs-theme dependency.
RUN apk add --no-cache git && npm install -g pnpm@9

# Copy website package
COPY frontend/packages/website/package.json ./

# Install dependencies
RUN pnpm install

# Copy website source
COPY frontend/packages/website/ .

# Build
RUN pnpm build

FROM caddy:alpine
COPY --from=build /app/dist /srv
# Static multi-page site (Astro/Starlight emits <path>/index.html), NOT an SPA —
# resolve each page's index.html and serve the real 404.html on a miss.
RUN cat > /etc/caddy/Caddyfile <<'EOF'
:80 {
	root * /srv
	encode gzip
	try_files {path} {path}/index.html {path}.html
	file_server
	handle_errors {
		rewrite * /404.html
		file_server
	}
}
EOF
EXPOSE 80
