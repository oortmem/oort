import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The bin's prompts: a question goes to stderr, never stdout, so `oort share … --json | jq`
 * gets only data. readline is replaced so the test can see which stream it writes to.
 */
const created: { output: unknown }[] = [];
vi.mock('node:readline/promises', () => ({
  createInterface: (opts: { output: unknown }) => {
    created.push(opts);
    return { question: async () => 'n', close: () => {} };
  },
}));

const { processIo } = await import('./io.js');

describe('processIo prompts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    created.length = 0;
  });

  it('io.ask-writes-the-question-to-stderr', async () => {
    const io = processIo(undefined);
    expect(await io.ask('Forget it? [y/N] ')).toBe('n');
    expect(created).toHaveLength(1);
    expect(created[0]?.output).toBe(process.stderr);
    expect(created[0]?.output).not.toBe(process.stdout);
  });

  it('io.ask-secret-on-a-terminal-writes-the-question-to-stderr', async () => {
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (b: boolean) => void };
    const wasTTY = stdin.isTTY;
    const hadRaw = stdin.setRawMode;
    Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
    stdin.setRawMode = () => stdin;
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const io = processIo(undefined);
      const answer = io.askSecret('voyage key (input hidden): ');
      stdin.emit('data', Buffer.from('k3y\r'));
      expect(await answer).toBe('k3y');
      expect(err).toHaveBeenCalledWith('voyage key (input hidden): ');
      expect(out).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(stdin, 'isTTY', { value: wasTTY, configurable: true });
      if (hadRaw === undefined) Reflect.deleteProperty(stdin, 'setRawMode');
      else stdin.setRawMode = hadRaw;
      stdin.pause();
    }
  });
});
