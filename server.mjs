import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ArtifactStore, HttpError, MAX_BODY_BYTES, idSchema } from './lib/store.mjs';
import { handleMcp } from './lib/mcp.mjs';
import { artifactPolicy, renderArtifact } from './lib/render.mjs';

const defaultPolicy = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const hash = value => createHash('sha256').update(value).digest();

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Content-Type must be application/json.');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new HttpError(415, 'Compressed request bodies are not supported.');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new HttpError(413, 'Request exceeds the 2 MiB limit.');
  let length = 0;
  const chunks = [];
  // A data listener lets us return 413 without destroying the socket before the response.
  return new Promise((resolveBody, reject) => {
    let rejected = false;
    req.on('data', chunk => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        if (!rejected) reject(new HttpError(413, 'Request exceeds the 2 MiB limit.'));
        rejected = true;
        chunks.length = 0;
      } else if (!rejected) chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON body.')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, 'Request aborted.')));
  });
}

export async function createApp({ apiKey, publicUrl, dataDir }) {
  if (!apiKey || Buffer.byteLength(apiKey) < 32 || /[\s\r\n]/.test(apiKey)) {
    throw new Error('API_KEY must contain at least 32 bytes and no whitespace. Generate one with: openssl rand -hex 32');
  }
  if (!publicUrl) throw new Error('PUBLIC_URL is required. Set it to your public origin, for example https://artifacts.example.com');
  const base = new URL(publicUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('PUBLIC_URL must be an http(s) origin, for example https://artifacts.example.com');
  }
  const store = new ArtifactStore(resolve(dataDir), base.origin);
  await store.init();
  const tokenHash = hash(`Bearer ${apiKey}`);

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', defaultPolicy);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      const url = new URL(req.url, base.origin);
      const path = url.pathname;
      const method = req.method;
      if (path === '/mcp' || path.startsWith('/api/')) {
        if (req.headers.origin && req.headers.origin !== base.origin) throw new HttpError(403, 'Origin not allowed.');
        if (!timingSafeEqual(hash(req.headers.authorization || ''), tokenHash)) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="artifact-host"');
          throw new HttpError(401, 'A valid bearer API key is required.');
        }
      }
      if (path === '/mcp') {
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return json(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use Streamable HTTP POST. This server is stateless.' } });
        }
        return await handleMcp(req, res, await readJson(req), store);
      }
      if (path === '/api/artifacts') {
        if (method === 'POST') {
          const artifact = await store.save(await readJson(req));
          res.setHeader('Location', artifact.url);
          return json(res, 201, artifact);
        }
        if (method === 'GET') {
          return json(res, 200, await store.list({
            ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
            ...(url.searchParams.has('offset') ? { offset: Number(url.searchParams.get('offset')) } : {}),
          }));
        }
        res.setHeader('Allow', 'GET, POST');
        throw new HttpError(405, 'Method not allowed.');
      }
      const apiMatch = path.match(/^\/api\/artifacts\/([^/]+)$/);
      if (apiMatch) {
        const id = idSchema.parse(apiMatch[1]);
        if (method === 'GET') {
          const artifact = await store.get(id);
          return json(res, 200, { ...artifact, ...store.metadata(artifact) });
        }
        if (method === 'PUT') return json(res, 200, await store.save(await readJson(req), id));
        if (method === 'DELETE') return json(res, 200, await store.delete(id));
        res.setHeader('Allow', 'GET, PUT, DELETE');
        throw new HttpError(405, 'Method not allowed.');
      }
      if (method !== 'GET' && method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        throw new HttpError(405, 'Method not allowed.');
      }
      if (path === '/healthz') return json(res, 200, { status: 'ok' });
      if (path === '/') return json(res, 200, {
        service: 'artifact-host', version: '1.0.0', mcp: `${base.origin}/mcp`,
        publish: 'POST /api/artifacts', authentication: 'Authorization: Bearer <API_KEY>',
        message: 'Agent publishing only. Open a published share URL to view an artifact.',
      });
      const shareMatch = path.match(/^\/s\/([^/]+)$/);
      if (shareMatch) {
        const artifact = await store.get(shareMatch[1]);
        res.writeHead(308, { Location: `/a/${artifact.id}/` });
        return res.end();
      }
      const assetMatch = path.match(/^\/a\/([^/]+)\/assets\/(.+)$/);
      if (assetMatch) {
        const artifact = await store.get(assetMatch[1]);
        let name;
        try { name = decodeURIComponent(assetMatch[2]); }
        catch { throw new HttpError(404, 'Asset not found.'); }
        const asset = artifact.assets.find(asset => asset.path === name);
        if (!asset) throw new HttpError(404, 'Asset not found.');
        const body = Buffer.from(asset.data_base64, 'base64');
        res.writeHead(200, {
          'Content-Type': asset.mime_type,
          'Content-Length': body.length,
          'Content-Security-Policy': artifactPolicy,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(method === 'HEAD' ? undefined : body);
      }
      const rawMatch = path.match(/^\/a\/([^/]+)(?:\/(index\.html|style\.css|script\.js)?)?$/);
      if (rawMatch) {
        const artifact = await store.get(rawMatch[1]);
        res.setHeader('Content-Security-Policy', artifactPolicy);
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (path === `/a/${artifact.id}`) {
          res.writeHead(308, { Location: `/a/${artifact.id}/` });
          return res.end();
        }
        const file = rawMatch[2] || 'index.html';
        const types = { 'index.html': 'text/html; charset=utf-8', 'style.css': 'text/css; charset=utf-8', 'script.js': 'text/javascript; charset=utf-8' };
        res.writeHead(200, { 'Content-Type': types[file] });
        return res.end(method === 'HEAD' ? undefined : file === 'style.css' ? artifact.css : file === 'script.js' ? artifact.js : renderArtifact(artifact));
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof z.ZodError) return json(res, 400, { error: 'Validation failed.', details: error.issues.map(({ path, message }) => ({ path, message })) });
      if (error instanceof HttpError) return json(res, error.status, { error: error.message });
      console.error('Request failed:', error);
      json(res, 500, { error: 'Internal server error.' });
    }
  });
  return { server, store };
}

async function main() {
  const port = Number(process.env.PORT || 47381);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const publicUrl = process.env.PUBLIC_URL;
  const { server } = await createApp({ apiKey: process.env.API_KEY, publicUrl, dataDir: process.env.DATA_DIR || './data' });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, process.env.HOST || '127.0.0.1', resolveListen);
  });
  console.log(`Artifact host: ${publicUrl}\nHTTP MCP: ${publicUrl}/mcp\nPublish: POST ${publicUrl}/api/artifacts`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10_000).unref();
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
