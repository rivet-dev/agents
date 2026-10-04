import { createInterface } from "node:readline";

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

let outboundRequestSeq = 0;

function writeMessage(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function echoNotification(message: unknown): void {
  writeMessage({
    jsonrpc: "2.0",
    method: "mock/echo",
    params: {
      message,
    },
  });
}

function handleMessage(raw: string): void {
  if (!raw.trim()) {
    return;
  }

  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(raw) as JsonRpcRequest;
  } catch (error) {
    writeMessage({
      jsonrpc: "2.0",
      method: "mock/parse_error",
      params: {
        error: error instanceof Error ? error.message : String(error),
        raw,
      },
    });
    return;
  }

  echoNotification(msg);

  const hasMethod = typeof msg.method === "string";
  const hasId = msg.id !== undefined;

  if (hasMethod && hasId) {
    if (msg.method === "mock/ask_client") {
      outboundRequestSeq += 1;
      writeMessage({
        jsonrpc: "2.0",
        id: `agent-req-${outboundRequestSeq}`,
        method: "mock/request",
        params: {
          prompt: "please respond",
        },
      });
    }

    writeMessage({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        echoed: msg,
      },
    });
    return;
  }

  if (!hasMethod && hasId) {
    writeMessage({
      jsonrpc: "2.0",
      method: "mock/client_response",
      params: {
        id: msg.id,
        result: msg.result ?? null,
        error: msg.error ?? null,
      },
    });
  }
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  handleMessage(line);
});

rl.on("close", () => {
  process.exit(0);
});
