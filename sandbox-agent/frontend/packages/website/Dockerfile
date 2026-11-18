FROM caddy:alpine
# Railway keeps its existing Dockerfile path and domains. The website and docs
# are published by rivet-dev/website; deploying this image migrates old links.
# The existing custom domains target port 80, not Railway's injected PORT.
RUN cat > /etc/caddy/Caddyfile <<'EOF'
:80 {
	handle /health {
		respond "healthy" 200
	}
	@discovery path /robots.txt /sitemap-index.xml /sitemap-0.xml
	handle @discovery {
		redir https://rivet.dev{uri} 301
	}
	handle {
		redir https://rivet.dev/sandbox-agent{uri} 301
	}
}
EOF
EXPOSE 80
