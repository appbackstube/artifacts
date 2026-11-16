import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const assetSchema = z.object({
  path: z.string().min(1).max(240)
    .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/)
    .describe('Path relative to the artifact assets directory, e.g. images/logo.png. Use ASCII letters, digits, underscores, hyphens and dots; no dot-prefixed segments.'),
  mime_type: z.string().max(120).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/)
    .describe('Media type without parameters, e.g. image/png, font/woff2 or application/pdf.'),
  data_base64: z.string().max(MAX_BODY_BYTES)
    .refine(value => Buffer.from(value, 'base64').toString('base64') === value, 'Expected canonical padded base64 without whitespace or a data-URL prefix.')
    .describe('File contents encoded as standard padded base64. Empty files are allowed.'),
}).strict();
export const artifactSchema = z.object({
  title: z.string().trim().min(1).max(120).describe('A short, human-readable title.'),
  html: z.string().min(1).max(MAX_BODY_BYTES).describe('HTML document or fragment. No build step; never include secrets.'),
  css: z.string().max(MAX_BODY_BYTES).default('').describe('CSS, automatically linked into the document.'),
  js: z.string().max(MAX_BODY_BYTES).default('').describe('Browser JavaScript, automatically loaded with defer after the HTML.'),
  assets: z.array(assetSchema).max(100)
    .refine(assets => new Set(assets.map(asset => asset.path)).size === assets.length, 'Asset paths must be unique.')
    .default([]).describe('Optional files served at ./assets/<path>. The complete JSON request including base64 must fit within 2 MiB.'),
}).strict();
export const idSchema = z.string().uuid();
export const pageSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(1_000_000).default(0),
}).strict();

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class ArtifactStore {
  constructor(directory, publicUrl) {
    this.directory = directory;
    this.publicUrl = publicUrl;
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  metadata({ id, title, created_at, updated_at }) {
    return { id, title, created_at, updated_at,
      url: `${this.publicUrl}/a/${id}/`,
      raw_url: `${this.publicUrl}/a/${id}/`,
    };
  }

  async get(id) {
    idSchema.parse(id);
    try {
      const artifact = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8'));
      artifact.assets ??= [];
      return artifact;
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, 'Artifact not found.');
      throw error;
    }
  }

  async list(input = {}) {
    const { limit, offset } = pageSchema.parse(input);
    // shortcut: listing scans flat files; use a database when the library outgrows a single host.
    const names = (await readdir(this.directory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
    const artifacts = [];
    for (const name of names) {
      try {
        artifacts.push(this.metadata(await this.get(name.slice(0, -5))));
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    artifacts.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    return { artifacts: artifacts.slice(offset, offset + limit), total: artifacts.length,
      next_offset: offset + limit < artifacts.length ? offset + limit : null };
  }

  mutate(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  async save(input, id) {
    const data = artifactSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Artifact exceeds the 2 MiB limit.');
    }
    return this.mutate(async () => {
      const previous = id ? await this.get(id) : null;
      const now = new Date().toISOString();
      const artifact = { ...data, id: id || randomUUID(), created_at: previous?.created_at || now, updated_at: now };
      const target = join(this.directory, `${artifact.id}.json`);
      const temporary = join(this.directory, `.${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(artifact));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return this.metadata(artifact);
    });
  }

  async delete(id) {
    return this.mutate(async () => {
      await this.get(id);
      await unlink(join(this.directory, `${id}.json`));
      return { id, deleted: true };
    });
  }
}
