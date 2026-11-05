import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensurePrivateDir, writePrivateFile } from '@oortmem/core';
import type { ModelFile, ModelSpec } from './catalog.js';

/** Written last by a successful pull: the model is complete and its checksums matched. */
export const MANIFEST = 'oort-model.json';

/** Where model files are fetched from; `OORT_MODELS_URL` points `oort models pull` at a mirror. */
export const HF_BASE_URL = 'https://huggingface.co';

export interface Manifest {
  id: string;
  revision: string;
  files: { name: string; bytes: number; sha256: string }[];
  pulledAt: string;
}

/** `$OORT_HOME/models`. */
export function modelsRoot(home: string): string {
  return path.join(home, 'models');
}

export function modelDir(home: string, id: string): string {
  return path.join(modelsRoot(home), id);
}

/**
 * - `ready`: pulled, the manifest matches the catalog, every file has its size.
 * - `missing`: never pulled (or removed).
 * - `incomplete`: a pull did not finish, or a file is gone or has the wrong size.
 * - `outdated`: pulled for another revision or checksum than this version of Oort pins.
 */
export type ModelState = 'ready' | 'missing' | 'incomplete' | 'outdated';

function readManifest(dir: string): Manifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

/**
 * Cheap check (a manifest read and a stat per file, no hashing), safe on every hook. A full
 * re-hash is `verifyModel`.
 */
export function modelState(home: string, spec: ModelSpec): ModelState {
  const dir = modelDir(home, spec.id);
  if (!fs.existsSync(dir)) return 'missing';
  const manifest = readManifest(dir);
  if (manifest === undefined) return 'incomplete';
  const pinned = spec.files.every((f) =>
    manifest.files.some((m) => m.name === f.name && m.sha256 === f.sha256 && m.bytes === f.bytes),
  );
  if (manifest.revision !== spec.source.revision || !pinned) return 'outdated';
  for (const f of spec.files) {
    let size: number;
    try {
      size = fs.statSync(path.join(dir, f.name)).size;
    } catch {
      return 'incomplete';
    }
    if (size !== f.bytes) return 'incomplete';
  }
  return 'ready';
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Re-hashes every file of a pulled model; lists each file that does not match its pin. */
export async function verifyModel(
  home: string,
  spec: ModelSpec,
): Promise<{ ok: boolean; bad: string[] }> {
  const dir = modelDir(home, spec.id);
  const bad: string[] = [];
  for (const f of spec.files) {
    const file = path.join(dir, f.name);
    if (!fs.existsSync(file) || (await sha256Of(file)) !== f.sha256) bad.push(f.name);
  }
  return { ok: bad.length === 0, bad };
}

/** A download that does not hash to its pin (or has the wrong size): nothing is kept. */
export class ChecksumError extends Error {
  constructor(
    readonly model: string,
    readonly file: string,
    detail: string,
  ) {
    super(`${model}: ${file} failed verification (${detail}); nothing was kept`);
    this.name = 'ChecksumError';
  }
}

export interface PullOptions {
  /** Default: the global fetch. Only `pullModel` touches the network. */
  fetch?: typeof fetch;
  /** Default `HF_BASE_URL`. */
  baseUrl?: string;
  /** Called as bytes arrive, per file. */
  onProgress?: (p: { file: string; received: number; total: number }) => void;
}

export function fileUrl(spec: ModelSpec, f: ModelFile, baseUrl = HF_BASE_URL): string {
  const root = baseUrl.replace(/\/+$/, '');
  return `${root}/${spec.source.repo}/resolve/${spec.source.revision}/${f.path}`;
}

async function download(
  spec: ModelSpec,
  f: ModelFile,
  dest: string,
  opts: PullOptions,
): Promise<void> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const res = await doFetch(fileUrl(spec, f, opts.baseUrl), { redirect: 'follow' });
  if (!res.ok || res.body === null) {
    void res.body?.cancel().catch(() => undefined);
    throw new Error(`${spec.id}: ${f.name} download failed (HTTP ${res.status})`);
  }
  const part = `${dest}.${process.pid}-${randomBytes(4).toString('hex')}.part`;
  const hash = createHash('sha256');
  let received = 0;
  const fd = fs.openSync(part, 'wx', 0o600);
  try {
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength;
        if (received > f.bytes) {
          throw new ChecksumError(spec.id, f.name, `more than the expected ${f.bytes} bytes`);
        }
        hash.update(chunk);
        fs.writeSync(fd, chunk);
        opts.onProgress?.({ file: f.name, received, total: f.bytes });
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (received !== f.bytes) {
      throw new ChecksumError(spec.id, f.name, `${received} bytes, expected ${f.bytes}`);
    }
    const digest = hash.digest('hex');
    if (digest !== f.sha256) throw new ChecksumError(spec.id, f.name, 'SHA-256 mismatch');
    fs.renameSync(part, dest);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
}

/**
 * Downloads every file of `spec` into `$OORT_HOME/models/<id>` (owner-only), verifying each
 * against its pinned size and SHA-256 before it is moved into place, then writes the manifest.
 * A file already present with the right hash is kept, so an interrupted pull resumes. On any
 * failure the manifest is absent, so the model stays unusable rather than half-trusted.
 * Returns the number of bytes downloaded.
 */
export async function pullModel(
  home: string,
  spec: ModelSpec,
  opts: PullOptions = {},
): Promise<number> {
  const dir = modelDir(home, spec.id);
  ensurePrivateDir(modelsRoot(home));
  ensurePrivateDir(dir);
  fs.rmSync(path.join(dir, MANIFEST), { force: true });
  let downloaded = 0;
  for (const f of spec.files) {
    const dest = path.join(dir, f.name);
    if (
      fs.existsSync(dest) &&
      fs.statSync(dest).size === f.bytes &&
      (await sha256Of(dest)) === f.sha256
    ) {
      continue;
    }
    fs.rmSync(dest, { force: true });
    await download(spec, f, dest, opts);
    downloaded += f.bytes;
  }
  const manifest: Manifest = {
    id: spec.id,
    revision: spec.source.revision,
    files: spec.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
    pulledAt: new Date().toISOString(),
  };
  writePrivateFile(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return downloaded;
}

/** Deletes a model's directory (files, manifest, optimised cache). True when it existed. */
export function removeModel(home: string, id: string): boolean {
  if (id === '' || path.basename(id) !== id || id.startsWith('.')) {
    throw new Error(`not a model id: ${JSON.stringify(id)}`);
  }
  const dir = modelDir(home, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
