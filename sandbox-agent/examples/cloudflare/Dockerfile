FROM cloudflare/sandbox:0.7.0

# Install sandbox-agent
RUN curl -fsSL https://releases.rivet.dev/sandbox-agent/0.4.x/install.sh | sh

# Pre-install agents
RUN sandbox-agent install-agent claude && \
    sandbox-agent install-agent codex

# Expose port for local dev (wrangler dev requires EXPOSE directives)
EXPOSE 8000
