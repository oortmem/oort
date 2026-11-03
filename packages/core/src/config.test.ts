import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oort-cfg-')));
}

describe('config', () => {
  it('defaults', () => {
    const cwd = tmp();
    const home = tmp();
    const c = resolveConfig(cwd, { OORT_HOME: home });
    expect(c.home).toBe(home);
    expect(c.embed).toEqual({
      provider: 'voyage',
      model: 'voyage-3.5-lite',
      dimension: 512,
      dtype: 'int8',
    });
    expect(c.rerank).toEqual({ provider: 'voyage', model: 'rerank-3-lite', topK: 10 });
    expect(c.decide).toEqual({ provider: 'jev' });
    expect(c.writer).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    expect(c.activation).toEqual({ d: 0.5, ws: 1.0, hotTopN: 50, coldBelow: -2.0 });
    expect(c.recall).toEqual({
      lexicalK: 50,
      denseK: 50,
      rerankK: 30,
      returnK: 10,
      budgetChars: 6000,
    });
    expect(c.project).toEqual({ private: false });
    expect(c.sources['embed']).toBe('default');
  });

  it('home default falls back to HOME/.oort', () => {
    const h = tmp();
    expect(resolveConfig(tmp(), { HOME: h }).home).toBe(path.join(h, '.oort'));
  });

  it('config.precedence', () => {
    const home = tmp();
    const root = tmp();
    const cwd = path.join(root, 'x', 'y');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        recall: { lexicalK: 5, denseK: 6, rerankK: 7, returnK: 3, budgetChars: 100 },
        writer: { provider: 'anthropic', model: 'home-model' },
      }),
    );
    fs.writeFileSync(
      path.join(root, 'oort.config.json'),
      JSON.stringify({
        writer: { provider: 'anthropic', model: 'project-model' },
        project: { private: true },
      }),
    );
    const c = resolveConfig(cwd, { OORT_HOME: home });
    expect(c.writer.model).toBe('project-model');
    expect(c.recall.lexicalK).toBe(5);
    expect(c.project.private).toBe(true);
    expect(c.embed.model).toBe('voyage-3.5-lite');
    expect(c.sources).toMatchObject({
      writer: 'project',
      project: 'project',
      recall: 'home',
      embed: 'default',
    });
  });

  it('config.rejects-unknown-keys', () => {
    const home = tmp();
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, 'oort.config.json'), JSON.stringify({ bogusKey: 1 }));
    expect(() => resolveConfig(cwd, { OORT_HOME: home })).toThrow(/bogusKey/);
    fs.rmSync(path.join(cwd, 'oort.config.json'));
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ embed: { provider: 'voyage', nested: 2 } }),
    );
    expect(() => resolveConfig(cwd, { OORT_HOME: home })).toThrow(/nested/);
  });
});
