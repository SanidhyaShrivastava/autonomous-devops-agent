import { createServer } from 'node:http';

const PORT = 3000;
const SERVICE = 'gx-autodevops-demo-service';
const HEALTH_RESPONSE = JSON.stringify({
  status: 'healthy',
  service: SERVICE,
});

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(HEALTH_RESPONSE),
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(HEALTH_RESPONSE);
    console.log('[health] healthy');
    return;
  }

  response.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end('{"error":"not_found"}');
});

server.listen(PORT, () => {
  console.log(`[startup] ${SERVICE} listening on port ${PORT}`);
});

process.once('SIGTERM', () => {
  console.log('[sigterm] graceful shutdown started');
  server.close(() => {
    console.log('[sigterm] graceful shutdown complete');
  });
});
