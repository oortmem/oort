import { describe, expect, it } from 'vitest';
import { AWS_KEY, SESSION, fixtureText } from '../test/helpers.js';
import { parseTranscript, turnsToObservations } from './transcript.js';

const CWD = '/synthetic/project';
const turns = () => parseTranscript(fixtureText(CWD));
const SHOULD_NOT = /SHOULD-NOT-APPEAR|TRUNCATED/;

describe('parseTranscript', () => {
  it('parser.skips-non-message-rows', () => {
    const ts = turns();
    expect(ts.map((t) => t.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    for (const t of ts) {
      expect(t.text).not.toMatch(SHOULD_NOT);
      for (const s of t.toolSummaries) expect(s).not.toMatch(SHOULD_NOT);
      expect(t.sessionId).toBe(SESSION);
      expect(t.cwd).toBe(CWD);
    }
    expect(ts[0]).toMatchObject({
      uuid: 'u-0001',
      parentUuid: null,
      text: 'Which port does the auth service listen on in this repo?',
      timestamp: '2026-10-01T09:00:01.000Z',
    });
  });

  it('parser.merges-tool-results', () => {
    const [, a1, , , , a3] = turns();
    // Consecutive assistant rows (thinking, tool_use, text) and the tool_result-only
    // user row between them form one assistant turn, identified by its last row.
    expect(a1).toMatchObject({
      role: 'assistant',
      uuid: 'a-0001c',
      parentUuid: 'att-0001',
      text: 'The auth service listens on port 4471, set in src/auth.ts.',
      timestamp: '2026-10-01T09:00:04.000Z',
      toolSummaries: [
        'Grep({"pattern":"PORT","path":"src"})',
        'result: src/auth.ts:12: export const PORT = 4471;',
      ],
    });
    // Array-shaped tool_result content is joined; tool_use input is cut at 120 chars.
    expect(a3?.toolSummaries[1]).toBe('result: The file src/auth.ts has been updated.');
    expect(a3?.toolSummaries[0]?.startsWith('Edit({"file_path":"src/auth.ts"')).toBe(true);
  });

  it('parser.skips-sidechain', () => {
    const text = turns()
      .map((t) => t.text)
      .join('\n');
    expect(text).not.toContain('SIDECHAIN');
    expect(turns().some((t) => t.uuid.startsWith('side-'))).toBe(false);
  });

  it('parser.ignores-thinking-meta-and-malformed', () => {
    const all = JSON.stringify(turns());
    expect(all).not.toContain('THINKING-TEXT');
    expect(all).not.toContain('META-TEXT');
    expect(all).not.toContain('TRUNCATED');
    expect(parseTranscript('not json\n{"type":"user"}\n\n{]')).toEqual([]);
  });

  it('parser.truncates-summaries', () => {
    const long = 'x'.repeat(500);
    const jsonl = [
      {
        type: 'user',
        uuid: 'u',
        parentUuid: null,
        timestamp: 't0',
        sessionId: 's',
        cwd: '/',
        message: { role: 'user', content: 'go' },
      },
      {
        type: 'assistant',
        uuid: 'a',
        parentUuid: 'u',
        timestamp: 't1',
        sessionId: 's',
        cwd: '/',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: long } }],
        },
      },
      {
        type: 'user',
        uuid: 'r',
        parentUuid: 'a',
        timestamp: 't2',
        sessionId: 's',
        cwd: '/',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: long }],
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const [, a] = parseTranscript(jsonl);
    expect(a?.toolSummaries[0]).toBe(`Bash(${JSON.stringify({ command: long }).slice(0, 120)})`);
    expect(a?.toolSummaries[1]).toBe(`result: ${long.slice(0, 200)}`);
  });

  it('parser.parses-50mb-under-1s', () => {
    // Bulky non-message rows (pre-filtered) and message rows (parsed), about one third to two thirds.
    const filler = JSON.stringify({
      type: 'api-request',
      sessionId: 's',
      params: { messages: [{ role: 'user', content: 'y'.repeat(10_000) }] },
    });
    const pair = [
      {
        type: 'user',
        uuid: 'u',
        parentUuid: null,
        timestamp: 't',
        sessionId: 's',
        cwd: '/',
        message: { role: 'user', content: 'z'.repeat(10_000) },
      },
      {
        type: 'assistant',
        uuid: 'a',
        parentUuid: 'u',
        timestamp: 't',
        sessionId: 's',
        cwd: '/',
        message: { role: 'assistant', content: [{ type: 'text', text: 'w'.repeat(10_000) }] },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const lines: string[] = [];
    let size = 0;
    while (size < 50 * 1024 * 1024) {
      lines.push(filler, pair);
      size += filler.length + pair.length + 2;
    }
    const jsonl = lines.join('\n');
    const t0 = performance.now();
    const ts = parseTranscript(jsonl);
    const ms = performance.now() - t0;
    expect(ts.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(1000);
  });
});

describe('turnsToObservations', () => {
  it('parser.pairs-user-and-assistant-at-assistant-time', () => {
    const obs = turnsToObservations(turns());
    expect(obs).toHaveLength(3);
    expect(obs[0]).toEqual({
      userText: 'Which port does the auth service listen on in this repo?',
      assistantText: 'The auth service listens on port 4471, set in src/auth.ts.',
      toolSummaries: [
        'Grep({"pattern":"PORT","path":"src"})',
        'result: src/auth.ts:12: export const PORT = 4471;',
      ],
      sessionId: SESSION,
      turnRef: 'a-0001c',
      at: '2026-10-01T09:00:04.000Z',
    });
    // The parser does not scrub; that happens before anything is queued or observed.
    expect(obs[1]?.userText).toContain(AWS_KEY);
    expect(obs.map((o) => o.turnRef)).toEqual(['a-0001c', 'a-0002', 'a-0003b']);
  });

  it('parser.joins-consecutive-user-turns-and-drops-unpaired', () => {
    const row = (type: string, uuid: string, text: string) =>
      JSON.stringify({
        type,
        uuid,
        parentUuid: null,
        timestamp: `t-${uuid}`,
        sessionId: 's',
        cwd: '/',
        message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] },
      });
    const jsonl = [
      row('assistant', 'a0', 'orphan answer'),
      row('user', 'u1', 'first try'),
      row('user', 'u2', 'second try'),
      row('assistant', 'a1', 'answer'),
      row('user', 'u3', 'unanswered'),
    ].join('\n');
    const obs = turnsToObservations(parseTranscript(jsonl));
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      userText: 'first try\nsecond try',
      assistantText: 'answer',
      turnRef: 'a1',
      at: 't-a1',
    });
  });
});
