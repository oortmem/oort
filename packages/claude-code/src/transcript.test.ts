import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AWS_KEY, SESSION, cpuMs, fixtureText } from '../test/helpers.js';
import {
  HARNESS_TAGS,
  OORT_MEMORY_TAG,
  parseTranscript,
  parseTranscriptDetailed,
  readTranscriptFrom,
  resumeOffset,
  selectAfterCursor,
  turnsToObservations,
} from './transcript.js';

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
      // Four harness-only rows (slash command, its output, `!` shell mode) are
      // empty user turns; the real prompt after them joins them.
      'user',
      'user',
      'user',
      'user',
      'user',
      'assistant',
      // A background task report (harness-only, so empty) and Claude's reply.
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
        timestamp: '2026-10-01T00:00:00.000Z',
        sessionId: 's',
        cwd: '/',
        message: { role: 'user', content: 'go' },
      },
      {
        type: 'assistant',
        uuid: 'a',
        parentUuid: 'u',
        timestamp: '2026-10-01T00:00:01.000Z',
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
        timestamp: '2026-10-01T00:00:02.000Z',
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
    // CPU time, not wall-clock: a busy machine delays the parse but does not make it cost more.
    let ts: ReturnType<typeof parseTranscript> = [];
    const ms = cpuMs(() => {
      ts = parseTranscript(jsonl);
    });
    expect(ts.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(1000);
  });
});

describe('turnsToObservations', () => {
  it('parser.pairs-user-and-assistant-at-assistant-time', () => {
    const obs = turnsToObservations(turns());
    expect(obs).toHaveLength(5);
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
    expect(obs.map((o) => o.turnRef)).toEqual(['a-0001c', 'a-0002', 'a-0003b', 'a-0014', 'a-0015']);
  });

  it('parser.joins-consecutive-user-turns-and-drops-unpaired', () => {
    const order = ['a0', 'u1', 'u2', 'a1', 'u3'];
    const row = (type: string, uuid: string, text: string) =>
      JSON.stringify({
        type,
        uuid,
        parentUuid: null,
        timestamp: `2026-10-01T00:00:0${order.indexOf(uuid)}.000Z`,
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
      at: '2026-10-01T00:00:03.000Z',
    });
  });

  it('parser.missing-timestamp-uses-nearest-known', () => {
    const row = (type: string, uuid: string, text: string, timestamp?: string) =>
      JSON.stringify({
        type,
        uuid,
        parentUuid: null,
        ...(timestamp !== undefined && { timestamp }),
        sessionId: 's',
        cwd: '/',
        message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] },
      });
    const jsonl = [
      row('user', 'u1', 'question one', '2026-10-01T10:00:00.000Z'),
      row('assistant', 'a1', 'answer one'), // no timestamp: the user turn's
      row('user', 'u2', 'question two'),
      row('assistant', 'a2', 'answer two', 'not a date'), // nearest known: u1, three turns back
      row('user', 'u3', 'question three'),
      row('assistant', 'a3', 'answer three'), // nearest known: u4, the next turn
      row('user', 'u4', 'question four', '2026-10-01T12:00:00.000Z'),
    ].join('\n');
    const at = turnsToObservations(parseTranscript(jsonl)).map((o) => o.at);
    expect(at).toEqual([
      '2026-10-01T10:00:00.000Z',
      '2026-10-01T10:00:00.000Z',
      '2026-10-01T12:00:00.000Z',
    ]);
    for (const a of at) expect(Number.isNaN(Date.parse(a))).toBe(false);
    // Nothing known at all: left empty for observe, which uses the observe time.
    const bare = [row('user', 'u1', 'q'), row('assistant', 'a1', 'a')].join('\n');
    expect(turnsToObservations(parseTranscript(bare)).map((o) => o.at)).toEqual(['']);
  });
});

describe('harness blocks', () => {
  const row = (type: string, uuid: string, text: string) =>
    JSON.stringify({
      type,
      uuid,
      parentUuid: null,
      timestamp: `2026-10-02T00:00:0${uuid.length % 10}.000Z`,
      sessionId: 's',
      cwd: '/',
      message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] },
    });

  it('parser.strips-harness-blocks', () => {
    expect([...HARNESS_TAGS].sort()).toEqual(
      [
        'bash-input',
        'bash-stderr',
        'bash-stdout',
        'command-args',
        'command-message',
        'command-name',
        'local-command-caveat',
        'local-command-stdout',
        'system-reminder',
        'task-notification',
      ].sort(),
    );
    expect(OORT_MEMORY_TAG).toBe('oort-memory');
    const obs = turnsToObservations(turns());
    expect(obs[3]).toMatchObject({
      userText: 'Where do the auth docs live?',
      assistantText: 'The auth docs live in docs/auth.md.',
      turnRef: 'a-0014',
    });

    // Non-greedy, across lines, with attributes; two blocks of one tag stay two blocks.
    const jsonl = [
      row(
        'user',
        'u1',
        'keep A <system-reminder kind="x">\nhidden 1\n</system-reminder> keep B ' +
          '<system-reminder>hidden 2</system-reminder> keep C\n<oort-memory>\n- hidden 3\n</oort-memory>',
      ),
      // Assistant text loses only Oort's block; other tags are its own words.
      row(
        'assistant',
        'a1',
        'answer <oort-memory>- hidden 4</oort-memory> and <command-name>kept</command-name>',
      ),
    ].join('\n');
    const [o] = turnsToObservations(parseTranscript(jsonl));
    expect(o?.userText).toBe('keep A  keep B  keep C');
    expect(o?.assistantText).toBe('answer  and <command-name>kept</command-name>');
    expect(JSON.stringify(o)).not.toContain('hidden');
  });

  it('parser.drops-turn-that-is-only-harness-output', () => {
    const ts = turns();
    // Harness-only rows leave empty user turns: no harness text survives.
    for (const t of ts.filter((x) => x.uuid.startsWith('h-') || x.uuid.startsWith('t-'))) {
      expect(t).toMatchObject({ role: 'user', text: '' });
    }

    const jsonl = [
      // A slash command row before a real prompt adds nothing to the prompt.
      row('user', 'c1', '<command-name>/clear</command-name>\n<command-args></command-args>'),
      row('user', 'u2', 'what is the deploy region?'),
      row('assistant', 'a2', 'eu-north-1'),
      // Both sides empty after stripping: a task report answered only by Oort's echoed block.
      row('user', 'n3', '<task-notification>\nfinished\n</task-notification>'),
      row('assistant', 'a3', '<oort-memory>\n- [semantic, today] echoed\n</oort-memory>'),
      // Harness rows that nothing answers.
      row('user', 'b4', '<bash-input>ls</bash-input>'),
      row('user', 'b5', '<bash-stdout>README.md</bash-stdout><bash-stderr></bash-stderr>'),
    ].join('\n');
    const obs = turnsToObservations(parseTranscript(jsonl));
    expect(obs).toEqual([
      expect.objectContaining({ userText: 'what is the deploy region?', turnRef: 'a2' }),
    ]);
  });

  it('parser.keeps-reply-to-harness-row-with-empty-user-text', () => {
    const obs = turnsToObservations(turns());
    expect(obs.at(-1)).toEqual({
      userText: '',
      assistantText: 'The background check finished cleanly.',
      toolSummaries: [],
      sessionId: SESSION,
      turnRef: 'a-0015',
      at: '2026-10-01T09:05:01.000Z',
    });
    // The reply before it is not merged into, or confused with, this one.
    expect(obs.at(-2)?.turnRef).toBe('a-0014');

    // With tool calls; a tool_result row that also carries a system reminder
    // stays part of the turn rather than starting a new one.
    const rows = [
      {
        type: 'user',
        uuid: 'n1',
        parentUuid: null,
        timestamp: '2026-10-01T00:00:01.000Z',
        sessionId: 's',
        cwd: '/',
        message: {
          role: 'user',
          content: '<task-notification>\n<status>completed</status>\n</task-notification>',
        },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'n1',
        timestamp: '2026-10-01T00:00:02.000Z',
        sessionId: 's',
        cwd: '/',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: 'report.md' } }],
        },
      },
      {
        type: 'user',
        uuid: 'r1',
        parentUuid: 'a1',
        timestamp: '2026-10-01T00:00:03.000Z',
        sessionId: 's',
        cwd: '/',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'x', content: 'all green' },
            { type: 'text', text: '<system-reminder>hidden</system-reminder>' },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'r1',
        timestamp: '2026-10-01T00:00:04.000Z',
        sessionId: 's',
        cwd: '/',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The report says all checks passed.' }],
        },
      },
    ];
    const ts = parseTranscript(rows.map((r) => JSON.stringify(r)).join('\n'));
    expect(ts.map((t) => [t.role, t.uuid])).toEqual([
      ['user', 'n1'],
      ['assistant', 'a2'],
    ]);
    expect(turnsToObservations(ts)).toEqual([
      {
        userText: '',
        assistantText: 'The report says all checks passed.',
        toolSummaries: ['Read({"file_path":"report.md"})', 'result: all green'],
        sessionId: 's',
        turnRef: 'a2',
        at: '2026-10-01T00:00:04.000Z',
      },
    ]);
  });
});

describe('tool summaries and stripping cost', () => {
  const GHP = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5q' + 'Rs8tUv1wXy4zAb7cDe0f';
  const AKID = 'AKIA' + 'Q7XZB3KM' + 'P9RTW2LN';
  /** Every prefix of `tok` of 6+ chars; none may survive into a summary. */
  const leaks = (summary: string, tok: string): string[] => {
    const out: string[] = [];
    for (let k = 6; k <= tok.length; k++)
      if (summary.includes(tok.slice(0, k))) out.push(tok.slice(0, k));
    return out;
  };
  const brokenMarker = /\[(?:R|RE|RED|REDA|REDAC|REDACT|REDACTE|REDACTED|REDACTED:[a-z-]*)$/;

  function summaries(input: Record<string, unknown>, result: string): string[] {
    const rows = [
      {
        type: 'user',
        uuid: 'u',
        parentUuid: null,
        timestamp: 't',
        sessionId: 's',
        cwd: '/',
        message: { role: 'user', content: 'run it' },
      },
      {
        type: 'assistant',
        uuid: 'a',
        parentUuid: 'u',
        timestamp: 't',
        sessionId: 's',
        cwd: '/',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'x', name: 'Bash', input }],
        },
      },
      {
        type: 'user',
        uuid: 'r',
        parentUuid: 'a',
        timestamp: 't',
        sessionId: 's',
        cwd: '/',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: result }],
        },
      },
    ];
    return parseTranscript(rows.map((r) => JSON.stringify(r)).join('\n'))[1]?.toolSummaries ?? [];
  }

  it('parser.scrubs-before-truncating-tool-summaries', () => {
    for (const tok of [GHP, AKID]) {
      for (const keep of [1, 4, 10, 24, tok.length - 1]) {
        // tool_use: the token starts `keep` chars before the 120-char cut of the input JSON.
        const head = '{"command":"';
        const pad = `${'p'.repeat(120 - head.length - keep - 1)} `;
        // tool_result: the token starts `keep` chars before the 200-char cut.
        const rpad = `${'q'.repeat(200 - keep - 1)} `;
        const [use, res] = summaries({ command: `${pad}${tok} --flag` }, `${rpad}${tok} trailing`);
        for (const s of [use ?? '', res ?? '']) {
          expect(leaks(s, tok)).toEqual([]);
          expect(s.replace(/\)$/, '')).not.toMatch(brokenMarker);
        }
        expect((use ?? '').length).toBeLessThanOrEqual('Bash()'.length + 120);
        expect((res ?? '').length).toBeLessThanOrEqual('result: '.length + 200);
      }
    }
    // A whole marker inside the cut is kept.
    const [use] = summaries({ command: `x ${AKID} y` }, 'ok');
    expect(use).toBe('Bash({"command":"x [REDACTED:aws-access-key] y"})');
  });

  it('parser.scrubs-string-leaves-before-stringify', () => {
    // JSON.stringify turns the newline into a literal `\n`; the key must be
    // scrubbed while it still follows a real newline. Assembled at runtime.
    const key = 'AK' + 'IA' + 'Q7XZB3KM' + 'P9RTW2LN';
    const input = { args: { script: { lines: ['ok', `echo hi\n${key}`] } }, n: 3 };
    const [use] = summaries(input, 'ok');
    expect(leaks(use ?? '', key)).toEqual([]);
    expect(use).toBe(
      'Bash({"args":{"script":{"lines":["ok","echo hi\\n[REDACTED:aws-access-key]"]}},"n":3})',
    );
  });

  it('parser.scrubs-escaped-values-and-domain-users', () => {
    // A literal backslash escape inside a value never ends it, and a Windows
    // domain user keeps its password redacted. Assembled at runtime.
    const B = '\\';
    const pw = 'Passw0rd' + '2024';
    for (const [input, secret] of [
      [{ command: `export DB_PASSWORD=ab9${B}tcd${'Tail77'} && run` }, 'cdTail77'],
      [{ command: `export DB_PASSWORD=ab9${B}ncd${'Tail77'} && run` }, 'cdTail77'],
      [{ command: `curl --ntlm -u CORP${B}jdoe:${pw} https://x/` }, pw],
    ] as const) {
      const [use] = summaries(input, 'ok');
      expect(use).toContain('[REDACTED:');
      expect(leaks(use ?? '', secret)).toEqual([]);
    }
  });

  it('parser.strip-is-linear', () => {
    const row = (type: string, uuid: string, text: string) =>
      JSON.stringify({
        type,
        uuid,
        parentUuid: null,
        timestamp: 't',
        sessionId: 's',
        cwd: '/',
        message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] },
      });
    for (const body of [
      '<bash-stdout>x '.repeat(20_000),
      '<bash-stdout x '.repeat(20_000),
      '<system-reminder></bash-stdout '.repeat(20_000),
      '<oort-memory>'.repeat(20_000) + '</oort-memory',
    ]) {
      const jsonl = [row('user', 'u', body), row('assistant', 'a', body)].join('\n');
      // Fastest of three, in CPU time (a busy machine does not inflate it): a quadratic strip
      // takes seconds here.
      let best = Infinity;
      let ts = parseTranscript(jsonl);
      for (let i = 0; i < 3; i++) {
        const ms = cpuMs(() => {
          ts = parseTranscript(jsonl);
        });
        best = Math.min(best, ms);
      }
      expect(best).toBeLessThan(50);
      // Nothing closed, so nothing stripped and nothing reflowed.
      expect(ts[0]?.text).toBe(body);
    }
    // Text that merely mentions the tags is untouched, spacing included.
    const legit =
      'why does  system-reminder show up?\n\n\n\nalso a < b and <bash-stdout without close';
    expect(parseTranscript(row('user', 'u', legit))[0]?.text).toBe(legit);
  });
});

describe('incremental read (CON-51)', () => {
  const row = (type: 'user' | 'assistant', uuid: string, text: string): string =>
    JSON.stringify({
      type,
      uuid,
      parentUuid: null,
      timestamp: '2026-10-01T10:00:00.000Z',
      sessionId: SESSION,
      cwd: CWD,
      message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] },
    });
  // Multi-byte text before the offsets: they must count bytes, not characters.
  const rows = [
    row('user', 'u1', 'Hvor ligger ørreden? 🐟'),
    row('assistant', 'a1', 'I bækken, æøå. 🌊'),
    JSON.stringify({ type: 'file-history-snapshot', blob: 'ü'.repeat(100) }),
    row('user', 'u2', 'And the second question — ½?'),
    row('user', 'u2b', 'Retry: the second question'),
    row('assistant', 'a2', 'Second answer.'),
  ];
  const text = rows.join('\n') + '\n';

  it('transcript.offsets-are-byte-offsets-of-each-turns-first-row', () => {
    const detailed = parseTranscriptDetailed(text);
    const bytes = Buffer.from(text, 'utf8');
    for (const d of detailed) {
      const line = bytes.subarray(d.offset).toString('utf8').split('\n')[0] ?? '';
      expect(JSON.parse(line).uuid).toBe(d.rowUuids[0]);
    }
    // With a base, offsets are shifted by it.
    expect(parseTranscriptDetailed(text, 1000).map((d) => d.offset)).toEqual(
      detailed.map((d) => d.offset + 1000),
    );
  });

  it('transcript.resume-offset-starts-at-the-user-turns-before-the-cursor', () => {
    const detailed = parseTranscriptDetailed(text);
    // a2 answers u2 and its retry u2b: the resume point is u2, so the pair is re-read whole.
    expect(resumeOffset(detailed, 'a2')).toBe(detailed[2]?.offset);
    expect(resumeOffset(detailed, 'a1')).toBe(0);
    expect(resumeOffset(detailed, 'missing')).toBeUndefined();
  });

  it('transcript.read-from-the-resume-offset-selects-like-a-full-read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-tail-'));
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, text);
    const at = resumeOffset(parseTranscriptDetailed(text), 'a1') as number;
    fs.appendFileSync(
      file,
      [row('user', 'u3', 'Third?'), row('assistant', 'a3', 'Third.')].join('\n') + '\n',
    );
    const full = fs.readFileSync(file, 'utf8');
    const tail = readTranscriptFrom(file, at);
    expect(tail.base).toBe(at);
    expect(tail.bytes).toBe(Buffer.byteLength(full) - at);
    const fromTail = selectAfterCursor(parseTranscriptDetailed(tail.text, tail.base), 'a1');
    const fromFull = selectAfterCursor(parseTranscriptDetailed(full), 'a1');
    expect(fromTail).toEqual(fromFull);
    expect(fromTail.fresh.map((o) => o.turnRef)).toEqual(['a2', 'a3']);
    // Past the end (a truncated file): read whole, from 0.
    expect(readTranscriptFrom(file, 10 ** 9)).toMatchObject({ base: 0, text: full });
  });
});
