import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig, resolveHome } from './config.js';

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
    expect(c.writer).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(c.activation).toEqual({ d: 0.5, ws: 1.0, hotTopN: 50, coldBelow: -2.0 });
    expect(c.recall).toEqual({
      lexicalK: 50,
      denseK: 50,
      rerankK: 30,
      returnK: 10,
      budgetChars: 6000,
      minRerankScore: 0.35,
      minCoverage: 0.5,
      minDenseScore: 0.6,
      skipRerankWhenConfident: true,
    });
    expect(c.project).toEqual({ private: false });
    expect(c.sources['embed']).toBe('default');
  });

  it('home default falls back to HOME/.oort', () => {
    const h = tmp();
    expect(resolveConfig(tmp(), { HOME: h }).home).toBe(path.join(h, '.oort'));
  });

  it('config.oort-home-resolved-absolute', () => {
    const base = tmp();
    const cwd = path.join(base, 'a', 'b');
    fs.mkdirSync(cwd, { recursive: true });
    const before = process.cwd();
    process.chdir(base);
    try {
      // Hooks run from many working directories; a relative OORT_HOME must not split the store.
      const c = resolveConfig(cwd, { OORT_HOME: 'rel-home' });
      expect(path.isAbsolute(c.home)).toBe(true);
      expect(c.home).toBe(path.join(base, 'rel-home'));
      expect(resolveHome({ OORT_HOME: './x/../rel-home' })).toBe(path.join(base, 'rel-home'));
    } finally {
      process.chdir(before);
    }
  });

  it('config.oort-home-empty-is-unset', () => {
    const h = tmp();
    expect(resolveConfig(tmp(), { OORT_HOME: '', HOME: h }).home).toBe(path.join(h, '.oort'));
    expect(resolveHome({ OORT_HOME: '', HOME: h })).toBe(path.join(h, '.oort'));
  });

  it('config.project-config-false-ignores-project-file', () => {
    // A dotfiles-style HOME: a git repository with an oort.config.json at its root,
    // and OORT_HOME inside it. The drain must see only the home config.
    const h = tmp();
    fs.mkdirSync(path.join(h, '.git'));
    fs.writeFileSync(
      path.join(h, 'oort.config.json'),
      JSON.stringify({ writer: { provider: 'anthropic', model: 'project-model' } }),
    );
    const home = path.join(h, '.oort');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ recall: { returnK: 3 } }));
    const env = { HOME: h, OORT_HOME: home };
    expect(resolveConfig(home, env).writer.model).toBe('project-model');
    const c = resolveConfig(home, env, { projectConfig: false });
    expect(c.writer.model).toBe('claude-haiku-5-5');
    expect(c.recall.returnK).toBe(3);
    expect(c.sources).toMatchObject({ writer: 'default', recall: 'home' });
    // Not even read: an invalid project file does not throw.
    fs.writeFileSync(path.join(h, 'oort.config.json'), '{not json');
    expect(() => resolveConfig(home, env, { projectConfig: false })).not.toThrow();
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
