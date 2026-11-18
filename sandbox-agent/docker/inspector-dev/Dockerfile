FROM node:22-bookworm-slim

RUN npm install -g pnpm@10.28.2

WORKDIR /app

CMD ["bash", "-lc", "pnpm install --filter @sandbox-agent/inspector... && cd frontend/packages/inspector && exec pnpm vite --host 0.0.0.0 --port 5173"]
