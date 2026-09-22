/*
 * Local test double for an AI Work gateway. Development only: it lets the MCP
 * bridge be exercised end to end (doctor / upload / submit / status / wait /
 * download) without a gateway, an API key or Work credits.
 *
 * The contract mirrors references/api.md of this skill:
 *   GET  /health
 *   POST /v1/assets                     -> { id }
 *   POST /v1/videos/generations         -> { data: { task: { id, status } } }  (requires Idempotency-Key)
 *   GET  /v1/videos/{task_id}           -> { data: { task: { id, status, progress, content_url } } }
 *   GET  /v1/videos/{task_id}/content   -> video/mp4 bytes
 */

import http from 'node:http';

const MP4_STUB = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
  Buffer.from('aiwork-mcp-fake-gateway-stub-payload-0123456789abcdef', 'utf8'),
]);

export async function startFakeGateway({ port = 0, pollsBeforeComplete = 2, apiKey = 'test-key-only' } = {}) {
  const requests = [];
  const state = { polls: 0, taskId: null, idempotencyKeys: [], assetCount: 0, assets: [], submittedPayload: null };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const authorization = req.headers.authorization ?? '';
      requests.push({
        method: req.method,
        path: req.url,
        idempotencyKey: req.headers['idempotency-key'] ?? null,
        authorizationPresent: /^Bearer\s+\S+/.test(authorization),
        bodyLength: body.length,
      });
      const json = (code, value) => {
        const payload = JSON.stringify(value);
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
      };

      if (req.method === 'GET' && req.url === '/health') {
        json(200, { status: 'ok', accounts: 2, capabilities: ['seedance'] });
        return;
      }
      if (!authorization.endsWith(apiKey)) {
        json(401, { error: { message: '缺少或错误的 Bearer 凭据' } });
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        json(200, { object: 'list', data: [{ id: 'seedance', object: 'model' }] });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/assets') {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        state.assets.push({
          filename: parsed?.filename ?? null,
          mime_type: parsed?.mime_type ?? null,
          data_base64: parsed?.data_base64 ?? null,
        });
        state.assetCount += 1;
        json(200, { id: `asset-${state.assetCount}`, kind: 'image' });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/videos/generations') {
        if (!req.headers['idempotency-key']) {
          json(400, { error: { message: '缺少 Idempotency-Key' } });
          return;
        }
        state.idempotencyKeys.push(req.headers['idempotency-key']);
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        state.taskId = 'video-fake-001';
        state.submittedPayload = parsed;
        json(200, { data: { task: { id: state.taskId, status: 'queued' } } });
        return;
      }
      const content = /^\/v1\/videos\/([^/]+)\/content$/.exec(req.url);
      if (req.method === 'GET' && content) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4_STUB.length });
        res.end(MP4_STUB);
        return;
      }
      const status = /^\/v1\/videos\/([^/]+)$/.exec(req.url);
      if (req.method === 'GET' && status) {
        state.polls += 1;
        const done = state.polls > pollsBeforeComplete;
        json(200, {
          data: {
            task: {
              id: decodeURIComponent(status[1]),
              status: done ? 'completed' : 'in_progress',
              progress: done ? 100 : 40,
              ...(done ? { content_url: `/v1/videos/${decodeURIComponent(status[1])}/content` } : {}),
            },
          },
        });
        return;
      }
      json(404, { error: { message: `fake gateway has no route ${req.method} ${req.url}` } });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    state,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
