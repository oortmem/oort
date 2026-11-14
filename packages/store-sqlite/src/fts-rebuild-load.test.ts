/**
 * The schema version 4 rebuild on a large version 3 store with a long rewrite history
 * (CON-110): memory stays bounded, the index passes FTS5's integrity check, a process killed
 * mid-rebuild leaves the store as it was, and opens during the rebuild wait or fail open.
 *
 * The migrating process is a child running the built package (`dist/`), so it can be measured
 * and killed; `pnpm verify` builds before it tests.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localGrant, localScope, tokenizeLexicalV1 } from '@oortmem/core';
import { makeMemory } from '@oortmem/core/store-conformance';
import {
  downgradeSqliteStore,
  openSqliteStore,
  SCHEMA_VERSION,
  sqliteSchemaVersion,
  StoreMigrationRequiredError,
} from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = pathToFileURL(path.join(here, '../dist/index.js')).href;
const DIM = 8;
const N = 30_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-fts-load-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const grant = localGrant({
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
});
const WORDS = ['auth', 'service', 'port', 'deploy', 'staging', 'billing', 'ledger', 'retry'];
const EXTRA = ['webhook', 'cache', '认证服务', 'บริการยืนยันตัวตน', 'प्रमाणीकरण सेवा'];

function raw(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  return db;
}

let template = '';

/**
 * A version 3 store of N memories whose every FTS row was rewritten three times (tier changes,
 * updates), built once and copied per test.
 */
beforeAll(async () => {
  const dir = path.join(root, 'template');
  fs.mkdirSync(dir);
  const dbPath = path.join(dir, 'oort.sqlite');
  const store = await openSqliteStore({
    path: dbPath,
    coldDir: path.join(dir, 'cold'),
    dimension: DIM,
    log: () => {},
  });
  const words = [...WORDS, ...EXTRA];
  for (let i = 0; i < N; i += 1000) {
    const batch = [];
    for (let j = i; j < Math.min(N, i + 1000); j++) {
      const text = Array.from(
        { length: 30 },
        (_, k) => `${words[(j * 7 + k * 3) % words.length]}${k % 5 === 0 ? `-${j}` : ''}`,
      ).join(' ');
      batch.push(
        makeMemory({
          id: `m-${j}`,
          text,
          stub: text.slice(0, 60),
          entities: [`svc-${j % 50}`],
          scope: localScope(),
          embedding: Int8Array.from({ length: DIM }, (_, d) => ((j + d) % 200) - 100),
        }),
      );
    }
    await store.upsertMany(grant, batch);
  }
  await store.close();
  downgradeSqliteStore({ path: dbPath, to: 3 });
  for (const f of fs.readdirSync(dir)) {
    if (f.includes('.pre-downgrade.')) fs.rmSync(path.join(dir, f));
  }
  const db = raw(dbPath);
  try {
    const rows = db
      .prepare<[], { rid: number; text: string; stub: string; entities: string }>(
        'SELECT rid, text, stub, entities FROM memories',
      )
      .all();
    const del = db.prepare<[number]>('DELETE FROM memories_fts WHERE rowid = ?');
    const ins = db.prepare<[number, string, string, string]>(
      'INSERT INTO memories_fts (rowid, text, stub, entities) VALUES (?, ?, ?, ?)',
    );
    const v1 = (s: string) => tokenizeLexicalV1(s).join(' ');
    db.transaction(() => {
      for (let t = 0; t < 3; t++) {
        for (const r of rows) {
          del.run(r.rid);
          ins.run(
            r.rid,
            v1(r.text),
            v1(r.stub),
            v1((JSON.parse(r.entities) as string[]).join(' ')),
          );
        }
      }
    })();
  } finally {
    db.close();
  }
  template = dir;
}, 300_000);

function copy(): { dbPath: string; coldDir: string } {
  const dir = fs.mkdtempSync(path.join(root, 'store-'));
  fs.cpSync(template, dir, { recursive: true });
  return { dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
}

/** Opens the store in a child process (migrating it) and reports its peak RSS in MB. */
function openInChild(s: { dbPath: string; coldDir: string }): {
  child: ChildProcess;
  exit: Promise<{ code: number | null; out: string }>;
} {
  const script = `
    const { openSqliteStore } = await import(${JSON.stringify(DIST)});
    const s = await openSqliteStore({ path: ${JSON.stringify(s.dbPath)}, coldDir: ${JSON.stringify(s.coldDir)}, dimension: ${DIM}, log: (m) => process.stdout.write(m + '\\n') });
    await s.close();
    process.stdout.write('maxrss ' + Math.round(process.resourceUsage().maxRSS / 1024) + '\\n');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
  const exit = new Promise<{ code: number | null; out: string }>((resolve) =>
    child.on('exit', (code) => resolve({ code, out })),
  );
  return { child, exit };
}

const peak = (out: string): number => Number(/maxrss (\d+)/.exec(out)?.[1]);

/** Resolves once the store's WAL holds more than `bytes`: the rebuild's transaction is writing. */
async function walGrows(dbPath: string, bytes: number, exited: Promise<unknown>): Promise<boolean> {
  let done = false;
  void exited.then(() => (done = true));
  for (;;) {
    let size = 0;
    try {
      size = fs.statSync(`${dbPath}-wal`).size;
    } catch {
      // not created yet
    }
    if (size > bytes) return true;
    if (done) return false;
    await new Promise((r) => setTimeout(r, 2));
  }
}

function integrityCheck(dbPath: string): void {
  const db = raw(dbPath);
  try {
    // Throws SQLITE_CORRUPT_VTAB when the index is inconsistent.
    db.exec("INSERT INTO memories_fts2 (memories_fts2) VALUES ('integrity-check')");
  } finally {
    db.close();
  }
}

async function finds(s: { dbPath: string; coldDir: string }, q: string): Promise<number> {
  const store = await openSqliteStore({
    path: s.dbPath,
    coldDir: s.coldDir,
    dimension: DIM,
    log: () => {},
  });
  try {
    return (await store.lexical(grant, q, 50)).length;
  } finally {
    await store.close();
  }
}

describe('rebuild under load (CON-110)', { timeout: 300_000 }, () => {
  it('fts-rebuild-load.a-large-history-store-migrates-within-memory-bounds', async () => {
    const s = copy();
    const migrating = await openInChild(s).exit;
    expect(migrating.code).toBe(0);
    expect(migrating.out).toContain(`Rebuilding the search index (${N} memories)…`);
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    // The same open of the migrated store, without a rebuild: the baseline.
    const plain = await openInChild(s).exit;
    expect(plain.out).not.toContain('Rebuilding');
    // The rebuild pages through the rows, so it costs little beyond an ordinary open.
    expect(peak(migrating.out) - peak(plain.out)).toBeLessThan(200);
    integrityCheck(s.dbPath);
    expect(await finds(s, '认证 服务')).toBeGreaterThan(0);
  });

  it('fts-rebuild-load.a-migration-killed-midway-leaves-version-3', async () => {
    const s = copy();
    const db = raw(s.dbPath);
    const before = db.prepare<[], { n: number }>('SELECT count(*) AS n FROM memories').get()?.n;
    db.close();
    const { child, exit } = openInChild(s);
    expect(await walGrows(s.dbPath, 1 << 20, exit), 'the rebuild was writing').toBe(true);
    child.kill('SIGKILL');
    await exit;
    // Nothing committed: still version 3, with its v1 index.
    expect(sqliteSchemaVersion(s.dbPath)).toBe(3);
    integrityCheck3(s.dbPath);
    // The next open migrates from the start, and completes.
    expect(await finds(s, '认证 服务')).toBeGreaterThan(0);
    expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
    integrityCheck(s.dbPath);
    const after = raw(s.dbPath);
    try {
      expect(after.prepare<[], { n: number }>('SELECT count(*) AS n FROM memories').get()?.n).toBe(
        before,
      );
    } finally {
      after.close();
    }
  });

  it('fts-rebuild-load.opens-during-the-rebuild-fail-open-or-wait', async () => {
    const s = copy();
    const { exit } = openInChild(s);
    expect(await walGrows(s.dbPath, 1 << 20, exit), 'the rebuild was writing').toBe(true);
    // A hook's open (migrate: false, a short busy timeout) refuses at once: the hook skips the
    // turn and says to run oort doctor.
    await expect(
      openSqliteStore({
        path: s.dbPath,
        coldDir: s.coldDir,
        dimension: DIM,
        migrate: false,
        busyTimeoutMs: 50,
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(StoreMigrationRequiredError);
    // A command's open waits for the rebuild instead of failing, and finds the work done.
    const lines: string[] = [];
    const store = await openSqliteStore({
      path: s.dbPath,
      coldDir: s.coldDir,
      dimension: DIM,
      busyTimeoutMs: 100,
      log: (m) => lines.push(m),
    });
    try {
      expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
      expect(lines.filter((l) => l.startsWith('Rebuilding'))).toEqual([]);
      expect((await store.lexical(grant, 'บริการยืนยันตัวตน', 10)).length).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
    expect((await exit).code).toBe(0);
    integrityCheck(s.dbPath);
  });
});

function integrityCheck3(dbPath: string): void {
  const db = raw(dbPath);
  try {
    db.exec("INSERT INTO memories_fts (memories_fts) VALUES ('integrity-check')");
  } finally {
    db.close();
  }
}
