# Artifact host

Agents publish HTML, CSS, JavaScript and assets. People open a URL.

A self-hosted service with **HTTP MCP at `/mcp`**, a small REST API, persistent disk storage and direct full-page artifact URLs without a header or wrapper. No browser editor, accounts, build pipeline or hosted platform dependency. The only runtime dependencies are the official MCP SDK and Zod.

## Run

Requires Docker Compose, or Node.js 22+.

```sh
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `.env` as `API_KEY`. `PUBLIC_URL` is required and controls the domain in every returned artifact link and MCP discovery URL. The example configuration uses:

```dotenv
PUBLIC_URL=https://artifacts.steps.app
```

Replace this with your own public origin when using another domain. Do not include a path. The app and Compose fail at startup if `PUBLIC_URL` is missing; they never silently fall back to localhost. Keep `.env` private (`chmod 600 .env`).

```sh
docker compose up -d --build
```

The service listens on `127.0.0.1:47381`. The Compose volume `artifacts` persists published content across restarts and upgrades. Do not use `docker compose down -v` unless you intend to delete that data.

Without Docker:

```sh
npm ci
npm start
```

The Node process reads `.env`, defaults to loopback, and stores artifacts in `./data`. For local-only development, explicitly set `PUBLIC_URL=http://localhost:47381`. `HOST`, `PORT` and `DATA_DIR` are configurable. The listener address is independent of the public URL: a production app can listen on port 47381 behind a proxy while returning HTTPS links without a port. Use **one process per data directory**.

### Reach it over the web

Point your domain's DNS to your server, set `PUBLIC_URL=https://your-domain`, and put a TLS reverse proxy in front of port 47381. [Caddyfile.example](Caddyfile.example) is a complete Caddy site block for a proxy running on the same host. Allow inbound ports 80 and 443. The Compose port remains private on loopback; the proxy provides public access.

After changing `.env` with Compose, recreate the container so it receives the new environment:

```sh
docker compose up -d --build --force-recreate artifacts
```

`docker compose restart` alone does not load changed environment values. With a hosting platform or plain Docker, set `PUBLIC_URL` in that deployment's environment and redeploy. A local `.env` change does not update a remote installation. With Node directly, restart the process. `PUBLIC_URL` also determines the allowed browser Origin. No credentials are taken from cookies or query parameters.

Check `https://artifacts.steps.app/` after deployment: its `mcp` value must be `https://artifacts.steps.app/mcp`. If it still says localhost, the running process still has the old environment. Artifact URLs are generated from the current configuration on every API/MCP read; stored files do not need migration. Previously copied localhost links must be replaced with the public links.

## Connect an agent over HTTP MCP

Transport: **Streamable HTTP**, endpoint `https://your-domain/mcp`.

Every request requires:

```http
Authorization: Bearer YOUR_API_KEY
```

Example configuration for MCP clients that accept `type`, `url` and `headers`:

```json
{
  "mcpServers": {
    "artifacts": {
      "type": "http",
      "url": "https://artifacts.example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

Replace the URL and key; configuration syntax varies by client. This server uses a static bearer key, **not OAuth**. Use a client that supports custom authorization headers. It uses the official SDK's stateless Streamable HTTP transport with JSON responses, no session IDs and no legacy `/sse` endpoint. Protocol negotiation is handled by the SDK.

| Tool | Input | Result |
| --- | --- | --- |
| `publish_artifact` | `title`, `html`, optional `css`, `js`, `assets` | ID, public URLs, timestamps |
| `list_artifacts` | Optional `limit` (1–100), `offset` | Metadata, total, next offset |
| `get_artifact` | `id` | Full source and metadata |
| `update_artifact` | `id`, `title`, `html`, optional `css`, `js`, `assets` | Same URLs, replaced content |
| `delete_artifact` | `id` | Deletion confirmation |

Tools return text JSON and MCP `structuredContent`. Validation and storage failures return tool errors. Tool annotations identify read-only and destructive operations.

Tell an agent:

> Use the artifacts MCP server to publish the result as an artifact. Send browser-ready HTML with optional CSS, JavaScript and base64 assets, then give me the returned `url`. Reference uploaded files as `./assets/<path>`. Everything published is public, so exclude secrets. Use `update_artifact` to revise an existing artifact without changing its link; include every asset you want to retain.

Example `publish_artifact` arguments:

```json
{
  "title": "Hello from my agent",
  "html": "<main><h1>Hello, world.</h1><button id='hello'>Click me</button></main>",
  "css": "body { font-family: system-ui; padding: 4rem; }",
  "js": "document.getElementById('hello').onclick = () => document.querySelector('h1').textContent = 'It works!';"
}
```

## REST alternative

Pass the same bearer header to all `/api/` requests. The example below assumes `API_KEY` is exported in your shell; `.env` is read by the service, not automatically by curl.

```sh
curl --fail-with-body http://localhost:47381/api/artifacts \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/artifact.json
```

Response (`201 Created`):

```json
{
  "id": "7cc4d130-3a55-4ebe-ad84-539becc63235",
  "title": "A little focus timer",
  "created_at": "2026-11-16T12:00:00.000Z",
  "updated_at": "2026-11-16T12:00:00.000Z",
  "url": "http://localhost:47381/a/7cc4d130-3a55-4ebe-ad84-539becc63235/",
  "raw_url": "http://localhost:47381/a/7cc4d130-3a55-4ebe-ad84-539becc63235/"
}
```

`url` opens the artifact itself at full browser size. `raw_url` is retained as a compatibility alias for the same URL. Existing `/s/:id` links redirect to the artifact.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/artifacts` | Publish a new artifact |
| `GET` | `/api/artifacts?limit=20&offset=0` | List metadata |
| `GET` | `/api/artifacts/:id` | Read source and metadata |
| `PUT` | `/api/artifacts/:id` | Replace the full artifact |
| `DELETE` | `/api/artifacts/:id` | Permanently delete |
| `GET` | `/s/:id` | Legacy link; redirects to `/a/:id/` |
| `GET` | `/a/:id/` | Public rendered HTML |
| `GET` | `/a/:id/style.css` | Public CSS |
| `GET` | `/a/:id/script.js` | Public JavaScript |
| `GET`, `HEAD` | `/a/:id/assets/:path` | Public uploaded file, including nested paths |
| `GET` | `/healthz` | Process health |

Publishing and updating use the same JSON shape as `publish_artifact`. `title` (1–120 characters) and nonempty `html` are required. `css` and `js` default to empty strings and `assets` to an empty list; unknown fields are rejected. A `PUT` clears omitted CSS/JS/assets. Maximum JSON request size is 2 MiB, including base64 assets and MCP envelopes. Errors use HTTP 400, 401, 403, 404, 405, 413 or 415 and JSON error messages; unexpected failures use 500.

### Include images, fonts and other files

Both `publish_artifact` / `update_artifact` and REST `POST` / `PUT` accept the same optional `assets` array:

```json
{
  "title": "An artifact with an image",
  "html": "<img src='./assets/pixel.gif' alt='A tiny uploaded image'>",
  "assets": [
    {
      "path": "pixel.gif",
      "mime_type": "image/gif",
      "data_base64": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    }
  ]
}
```

`path` is relative to the artifact's `assets/` directory. A file with `path: "images/logo.png"` is available at `/a/:id/assets/images/logo.png` and can be referenced as `./assets/images/logo.png` in HTML or the automatically linked CSS/JS. Nested CSS files resolve relative URLs against their own directory: `assets/css/site.css` can reference `../images/logo.png`. JSON files can be fetched with `fetch('./assets/config.json')`.

- Up to 100 files per artifact. Each path is at most 240 characters. Path segments must start with an ASCII letter, digit, underscore or hyphen; remaining characters may also include dots. Dot-prefixed segments, traversal, backslashes, spaces, URL escapes and duplicate paths are rejected.
- `mime_type` is a media type without parameters, e.g. `image/png`, `image/svg+xml`, `font/woff2`, `application/json` or `application/pdf`. Files are served with this type and `nosniff`; the host does not convert or execute them.
- `data_base64` contains standard padded base64 without a data-URL prefix or whitespace. Base64 increases file size by about one third, so the 2 MiB request limit allows less than 1.5 MiB of binary content after other fields and envelope overhead.
- Files share the artifact's lifetime and atomic writes. Updates replace the whole asset list; include all files to retain. Omitted `assets` removes all old assets. Existing artifacts without assets remain compatible without a migration.
- Asset responses allow CORS so fonts, module scripts and fetches work from the sandbox's opaque origin. Active HTML/SVG asset documents receive the same sandbox policy as the main page. Assets are public.

See [examples/with-assets.json](examples/with-assets.json) for a complete working example. Publish it with the same curl command above, replacing the file after `@`.

### Rendering

HTML may be a complete document or a fragment. CSS is linked into the head; JavaScript is loaded with `defer` after parsing. Do not add duplicate links for the `css` and `js` fields. If placing a module script in your HTML, use `type="module"` there and omit the separate `js` field. Uploaded files are served under `/a/:id/assets/`. External HTTPS images, fonts and CDN scripts can be referenced by absolute URL. React/TypeScript/JSX must be compiled by the publishing agent or use an appropriate browser CDN/runtime.

## Safety and limits

- **Published means public, including source code.** Unlisted UUID links are not access control. There is no public listing, but anyone with a URL can read and share it. Do not publish credentials, private data or privileged API calls.
- The HTML HTTP response enforces a sandbox without `allow-same-origin`, top navigation or popups. Published JavaScript cannot read the host's storage or DOM. See the [CSP sandbox reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox). Workers and service workers are disabled. Origin-dependent features such as localStorage do not work.
- A sandbox does not make arbitrary content trustworthy. Artifacts may contact external servers, load remote scripts, display deceptive content, submit forms or consume browser resources. The host never runs uploaded code server-side. Use a dedicated domain for this service and protect visitors as you would on any public content host.
- A single shared API key grants full management access. Keep it in agent configuration, never in an artifact or share URL. Rotate it by changing `.env` and restarting. OAuth, per-agent permissions, private artifacts and user accounts are intentionally omitted.
- Writes use private files, fsync and atomic rename. In-process mutations are serialized; multiple replicas sharing a directory are unsupported. Listing scans stored files, so this is intended for a modest single-server library. Back up the data directory or Docker volume. Updates replace content; there is no revision history or undo.
- HTTP timeouts and request-size limits are set, but there is no storage quota or public traffic rate limiter. Add proxy limits appropriate to your deployment. `/healthz` checks the running process, not disk health.

## Verify

```sh
npm test
```

The tests exercise the official MCP client over real HTTP, REST/MCP interoperability, bearer and Origin checks, validation and size limits, sandbox headers, direct links without a wrapper, legacy redirects, binary assets and MIME/CORS/HEAD handling, unsafe paths and invalid base64, asset replacement and deletion, pre-asset record compatibility, persistence, stable updates and concurrent writes. Browser security behavior still depends on modern browser support; deploy behind HTTPS.
