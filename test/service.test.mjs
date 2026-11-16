import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server.mjs';
import { MAX_BODY_BYTES } from '../lib/store.mjs';

const apiKey = 'test-key-only-'.repeat(5);
const publicUrl = 'https://artifacts.example.test';
const authorization = `Bearer ${apiKey}`;
const headers = { authorization, 'Content-Type': 'application/json' };
const source = { title: 'Interactive test', html: '<main id="app">Hello</main>', css: 'body { color: green; }', js: 'document.querySelector("main").textContent = "It works";' };
const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const asset = { path: 'images/sample.png', mime_type: 'image/png', data_base64: binary.toString('base64') };
let directory, server, store, origin;
const request = (path, options) => fetch(`${origin}${path}`, options);
const post = (body, extra = {}) => ({ method: 'POST', headers, body: JSON.stringify(body), ...extra });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'artifact-host-test-'));
  ({ server, store } = await createApp({ apiKey, publicUrl, dataDir: directory }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

test('refuses weak credentials and unsafe public URL configuration', async () => {
  await assert.rejects(createApp({ apiKey: 'short', publicUrl, dataDir: directory }), /at least 32/);
  await assert.rejects(createApp({ apiKey, dataDir: directory }), /PUBLIC_URL is required/);
  for (const invalid of ['file:///tmp', 'https://example.com/path', 'https://user:pass@example.com']) {
    await assert.rejects(createApp({ apiKey, publicUrl: invalid, dataDir: directory }), /PUBLIC_URL/);
  }
});

test('startup requires an explicit public URL instead of falling back to localhost', () => {
  const result = spawnSync(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, API_KEY: apiKey, PUBLIC_URL: '', PORT: '47381', HOST: '127.0.0.1' },
    timeout: 2000,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PUBLIC_URL is required/);
});

test('configured public domain drives discovery and existing artifact links', async () => {
  const response = await request('/', { headers: { 'X-Forwarded-Host': 'localhost:47381', 'X-Forwarded-Proto': 'http' } });
  assert.equal((await response.json()).mcp, `${publicUrl}/mcp`);
  const artifact = await store.save(source);
  const changed = await createApp({ apiKey, publicUrl: 'https://artifacts.steps.app/', dataDir: directory });
  assert.equal(changed.store.metadata(await changed.store.get(artifact.id)).url, `https://artifacts.steps.app/a/${artifact.id}/`);
  assert.equal((await store.get(artifact.id)).html, source.html);
});

test('requires bearer auth for every management route and MCP method', async () => {
  for (const path of ['/api/artifacts', '/mcp', '/api/artifacts/unknown']) {
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  }
  for (const path of ['/api/artifacts', '/mcp']) {
    assert.equal((await request(path, { headers: { authorization, Origin: 'null' } })).status, 403);
    assert.equal((await request(path, { headers: { authorization, Origin: 'https://evil.test' } })).status, 403);
  }
  assert.equal((await request('/api/artifacts', { headers: { authorization, Origin: publicUrl } })).status, 200);
  assert.equal((await request('/healthz')).status, 200);
});

test('REST returns direct full-page links with sandboxed HTML/CSS/JS and no wrapper', async () => {
  const response = await request('/api/artifacts', post({ ...source, title: '</title><script>alert(1)</script>' }));
  assert.equal(response.status, 201);
  const artifact = await response.json();
  assert.equal(response.headers.get('location'), artifact.url);
  assert.equal(artifact.url, `${publicUrl}/a/${artifact.id}/`);
  assert.equal(artifact.raw_url, artifact.url);
  const legacy = await request(`/s/${artifact.id}`, { redirect: 'manual' });
  assert.equal(legacy.status, 308);
  assert.equal(legacy.headers.get('location'), `/a/${artifact.id}/`);
  const raw = await request(new URL(artifact.url).pathname);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.doesNotMatch(raw.headers.get('content-security-policy'), /allow-same-origin|allow-top-navigation|allow-popups/);
  assert.equal(raw.headers.get('access-control-allow-origin'), '*');
  const html = await raw.text();
  assert.match(html, /<main id="app">Hello<\/main>/);
  assert.doesNotMatch(html, /<iframe|<header|viewer\.(css|js)|<script>alert/);
  assert.match(html, new RegExp(`/a/${artifact.id}/style.css`));
  assert.match(html, new RegExp(`<script defer src="/a/${artifact.id}/script.js">`));
  for (const [filename, type, content] of [['style.css', 'text/css', source.css], ['script.js', 'text/javascript', source.js]]) {
    const file = await request(`/a/${artifact.id}/${filename}`);
    assert.match(file.headers.get('content-type'), new RegExp(type));
    assert.equal(await file.text(), content);
  }
  const read = await request(`/api/artifacts/${artifact.id}`, { headers });
  assert.equal((await read.json()).js, source.js);
  assert.equal((await stat(join(directory, `${artifact.id}.json`))).mode & 0o777, 0o600);
});

test('validates payloads, identifiers, content types, pagination and body size', async () => {
  for (const body of [{ title: 'Missing HTML' }, { ...source, html: 42 }, { ...source, title: '   ' }, { ...source, unexpected: true }, { ...source, title: 'x'.repeat(121) }]) {
    assert.equal((await request('/api/artifacts', post(body))).status, 400);
  }
  assert.equal((await request('/api/artifacts', post(source, { headers: { authorization } }))).status, 415);
  assert.equal((await request('/api/artifacts', { method: 'POST', headers, body: '{broken' })).status, 400);
  assert.equal((await request('/api/artifacts?limit=101', { headers })).status, 400);
  assert.equal((await request('/api/artifacts?offset=-1', { headers })).status, 400);
  assert.equal((await request('/api/artifacts/not-an-id', { headers })).status, 400);
  assert.equal((await request('/api/artifacts', post({ ...source, html: 'x'.repeat(MAX_BODY_BYTES) }))).status, 413);
  const stream = Readable.from(['{"html":"', 'x'.repeat(MAX_BODY_BYTES), '"}']);
  const chunked = await request('/api/artifacts', { method: 'POST', headers, body: stream, duplex: 'half' });
  assert.equal(chunked.status, 413);
});

test('REST persists binary assets and serves nested paths with MIME, CORS, HEAD and sandbox headers', async () => {
  const assets = [asset,
    { path: 'config.json', mime_type: 'application/json', data_base64: Buffer.from('{"ready":true}').toString('base64') },
    { path: 'empty.txt', mime_type: 'text/plain', data_base64: '' },
    { path: 'active.svg', mime_type: 'image/svg+xml', data_base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64') },
  ];
  const response = await request('/api/artifacts', post({ ...source, assets }));
  assert.equal(response.status, 201);
  const artifact = await response.json();
  const api = await (await request(`/api/artifacts/${artifact.id}`, { headers })).json();
  assert.deepEqual(api.assets, assets);
  const restarted = await createApp({ apiKey, publicUrl, dataDir: directory });
  assert.deepEqual((await restarted.store.get(artifact.id)).assets, assets);
  for (const file of assets) {
    const path = `/a/${artifact.id}/assets/${file.path}`;
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), file.mime_type);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.doesNotMatch(response.headers.get('content-security-policy'), /allow-same-origin/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(file.data_base64, 'base64'));
    const head = await request(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), Buffer.from(file.data_base64, 'base64').length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  for (const name of ['missing.png', '..%2F.env', '%2Fetc%2Fpasswd', '%E0%A4%A']) {
    assert.equal((await request(`/a/${artifact.id}/assets/${name}`)).status, 404);
  }
  assert.equal((await request(`/a/${artifact.id}/assets/${asset.path}`, { method: 'POST' })).status, 405);
  const listing = await (await request('/api/artifacts?limit=100', { headers })).json();
  assert.equal(listing.artifacts.find(item => item.id === artifact.id).assets, undefined);
});

test('rejects unsafe and duplicate paths, invalid media types, malformed base64 and excessive assets', async () => {
  const invalidPaths = ['../secret', 'images/../../secret', '/absolute.png', 'a\\b.png', 'a//b.png', '.env', 'a/./b.png', '%2e%2e/secret', 'a?query', 'a#fragment', 'a\u0000.png'];
  const invalidAssets = [
    ...invalidPaths.map(path => [{ ...asset, path }]),
    [{ ...asset, mime_type: 'image/png\r\nX-Injected: true' }],
    [{ ...asset, mime_type: 'text/plain; charset=utf-8' }],
    [{ ...asset, mime_type: 'not-a-type' }],
    ...['???', 'data:image/png;base64,AA==', 'AA', 'AB==', 'AA==\n', '____'].map(data_base64 => [{ ...asset, data_base64 }]),
    [asset, asset],
    Array.from({ length: 101 }, (_, i) => ({ ...asset, path: `${i}.png` })),
  ];
  for (const assets of invalidAssets) {
    const response = await request('/api/artifacts', post({ ...source, assets }));
    assert.equal(response.status, 400, JSON.stringify(assets));
  }
  const oversized = { ...asset, data_base64: Buffer.alloc(MAX_BODY_BYTES).toString('base64') };
  assert.equal((await request('/api/artifacts', post({ ...source, assets: [oversized] }))).status, 413);
});

test('asset replacements, omitted assets and deletion remove obsolete public files', async () => {
  const original = await store.save({ ...source, assets: [asset] });
  const firstPath = `/a/${original.id}/assets/${asset.path}`;
  const replacement = { ...asset, path: 'new.png', data_base64: Buffer.from('new bytes').toString('base64') };
  const updated = await request(`/api/artifacts/${original.id}`, { ...post({ ...source, assets: [replacement] }), method: 'PUT' });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).url, original.url);
  assert.equal((await request(firstPath)).status, 404);
  assert.equal(await (await request(`/a/${original.id}/assets/new.png`)).text(), 'new bytes');
  await request(`/api/artifacts/${original.id}`, { ...post(source), method: 'PUT' });
  assert.equal((await request(`/a/${original.id}/assets/new.png`)).status, 404);
  await store.save({ ...source, assets: [asset] }, original.id);
  await request(`/api/artifacts/${original.id}`, { method: 'DELETE', headers });
  assert.equal((await request(firstPath)).status, 404);
});

test('pre-asset records remain readable without migrating stored files', async () => {
  const artifact = await store.save(source);
  const { assets, ...legacy } = await store.get(artifact.id);
  await writeFile(join(directory, `${artifact.id}.json`), JSON.stringify(legacy));
  const response = await request(`/api/artifacts/${artifact.id}`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).assets, []);
  assert.equal((await request(`/a/${artifact.id}/`)).status, 200);
  assert.equal((await request(`/a/${artifact.id}/assets/missing.png`)).status, 404);
});

test('update preserves URLs and creation time; deletion removes every public route', async () => {
  const original = await (await request('/api/artifacts', post(source))).json();
  const updated = await (await request(`/api/artifacts/${original.id}`, { ...post({ title: 'Updated', html: '<p>New</p>' }), method: 'PUT' })).json();
  assert.equal(updated.url, original.url);
  assert.equal(updated.created_at, original.created_at);
  assert.equal((await store.get(original.id)).js, '');
  assert.match(await (await request(`/a/${original.id}/`)).text(), /<p>New<\/p>/);
  const deleted = await request(`/api/artifacts/${original.id}`, { method: 'DELETE', headers });
  assert.equal(deleted.status, 200);
  for (const path of [`/s/${original.id}`, `/a/${original.id}/`, `/a/${original.id}/script.js`, `/api/artifacts/${original.id}`]) {
    assert.equal((await request(path, { headers })).status, 404);
  }
  assert.equal((await request(`/api/artifacts/${original.id}`, { ...post(source), method: 'PUT' })).status, 404);
});

test('works end to end with the official HTTP MCP client and shared REST storage', async () => {
  const client = new Client({ name: 'artifact-integration-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization } } });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['delete_artifact', 'get_artifact', 'list_artifacts', 'publish_artifact', 'update_artifact']);
    assert.ok(tools.find(tool => tool.name === 'publish_artifact').inputSchema.properties.assets);
    const published = await client.callTool({ name: 'publish_artifact', arguments: { ...source, assets: [asset] } });
    assert.equal(published.isError, undefined);
    const artifact = published.structuredContent;
    assert.equal(artifact.url, `${publicUrl}/a/${artifact.id}/`);
    assert.equal((await request(new URL(artifact.url).pathname)).status, 200);
    const fetched = await client.callTool({ name: 'get_artifact', arguments: { id: artifact.id } });
    assert.equal(fetched.structuredContent.html, source.html);
    assert.deepEqual(fetched.structuredContent.assets, [asset]);
    const file = await request(`/a/${artifact.id}/assets/${asset.path}`);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), binary);
    const listed = await client.callTool({ name: 'list_artifacts', arguments: { limit: 1 } });
    assert.equal(listed.structuredContent.artifacts.length, 1);
    assert.ok(listed.structuredContent.next_offset > 0);
    const updated = await client.callTool({ name: 'update_artifact', arguments: { ...source, id: artifact.id, title: 'MCP updated' } });
    assert.equal(updated.structuredContent.url, artifact.url);
    const rest = await (await request(`/api/artifacts/${artifact.id}`, { headers })).json();
    assert.equal(rest.title, 'MCP updated');
    assert.deepEqual(rest.assets, []);
    assert.equal((await request(`/a/${artifact.id}/assets/${asset.path}`)).status, 404);
    const invalidAsset = await client.callTool({ name: 'publish_artifact', arguments: { ...source, assets: [{ ...asset, path: '../secret' }] } });
    assert.equal(invalidAsset.isError, true);
    const invalid = await client.callTool({ name: 'publish_artifact', arguments: { title: 'Invalid' } });
    assert.equal(invalid.isError, true);
    const deleted = await client.callTool({ name: 'delete_artifact', arguments: { id: artifact.id } });
    assert.equal(deleted.structuredContent.deleted, true);
    const missing = await client.callTool({ name: 'get_artifact', arguments: { id: artifact.id } });
    assert.equal(missing.isError, true);
    assert.equal((await request(`/s/${artifact.id}`)).status, 404);
    await client.ping();
  } finally {
    await client.close();
  }
});

test('stateless MCP rejects unsupported HTTP methods and missing Accept types', async () => {
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const response = await request('/mcp', { method, headers });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
  const response = await request('/mcp', post({ jsonrpc: '2.0', id: 1, method: 'ping' }));
  assert.equal(response.status, 406);
});

test('survives restart and serializes concurrent updates and deletion without resurrection', async () => {
  const artifact = await store.save(source);
  const restarted = await createApp({ apiKey, publicUrl, dataDir: directory });
  assert.equal((await restarted.store.get(artifact.id)).html, source.html);
  const writes = Array.from({ length: 8 }, (_, i) => store.save({ ...source, title: `Update ${i}` }, artifact.id));
  const deletion = store.delete(artifact.id);
  await Promise.all([...writes, deletion]);
  await assert.rejects(store.get(artifact.id), error => error.status === 404);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});
