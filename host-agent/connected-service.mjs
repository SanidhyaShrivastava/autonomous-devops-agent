import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = 3001;
const HEALTH_PATH = "/health";
const SEED_FAILURE_PATH = "/__seed-stopped-service";
const SERVICE_ID = "connected-demo-service";
const instanceId = randomUUID();

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === HEALTH_PATH) {
    const body = JSON.stringify({
      service: SERVICE_ID,
      status: "healthy",
      instanceId,
    });
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json",
    });
    response.end(body);
    return;
  }

  const isLoopback = request.socket.remoteAddress === HOST;
  if (
    isLoopback &&
    request.method === "POST" &&
    request.url === SEED_FAILURE_PATH
  ) {
    server.close();
    response.writeHead(204, {
      "Cache-Control": "no-store",
      Connection: "close",
    });
    response.end();
    return;
  }

  response.writeHead(404, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end("Not found");
});

server.listen(PORT, HOST);

function stop() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
