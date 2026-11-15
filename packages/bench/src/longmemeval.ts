/**
 * LongMemEval_S (`longmemeval_s_cleaned.json`, CON-147): 500 questions, each with its own
 * haystack of about 50 chat sessions (user and assistant). One haystack per question. A memory is
 * one round (a user message and the assistant reply after it), the granularity LongMemEval's
 * authors found best for retrieval; its `turnRef` is `<session id>#<round>` and `at` is the
 * session's date plus a second per round. A round is evidence when either message has
 * `has_answer: true`.
 *
 * Scored twice: turn recall@k (rounds against `has_answer`) and session recall@k (the sessions of
 * the top k rounds against `answer_session_ids`). The 30 abstention questions (`_abs` ids) are
 * their own group. Verbatim storage never supersedes, so stale-leak here is a baseline to compare
 * links against, not a measure of Oort's updates.
 *
 * Most knowledge-update questions (70 of 72) have two answer sessions, one with an older value
 * and one with a newer value, and the file does not say which one the question asks for:
 * `answer_session_ids` lists both and `has_answer` marks rounds in both. By default the
 * later-dated session (and its rounds) is expected and the earlier one counts as stale, for
 * recall, stale-leak and stale above current alike. Where that is wrong for the question asked,
 * `KNOWLEDGE_UPDATE_OVERRIDES` says what to score instead.
 */
import type { Haystack, PublicSet, Question, Turn } from './public-sets.js';

export const LONGMEMEVAL_GROUPS = [
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'abstention',
];

/**
 * How a knowledge-update question is labelled when "the later answer session is current" does
 * not fit the question asked:
 * - `earlier`: the question asks for the earlier value, so the earlier session is expected and
 *   the later one counts as stale (it holds the value the question does not ask for);
 * - `recall-only`: neither session is outdated for this question (it asks for both values or how
 *   one changed, either session answers it, the answer adds the two up, or the dates contradict
 *   the text). Every answer session is expected, as the file lists them, and nothing counts
 *   toward stale-leak or stale above current.
 */
export type KnowledgeUpdateOverride =
  | { kind: 'earlier'; expected: string; stale: string; why: string }
  | { kind: 'recall-only'; why: string };

export type KnowledgeUpdateOverrides = Readonly<Record<string, KnowledgeUpdateOverride>>;

/**
 * Overrides for the pinned LongMemEval_S revision, found by reading the question, the answer and
 * both answer sessions of all 70 knowledge-update questions that have two. Checked against the
 * file by `longmemeval.test.ts` when it is in the cache.
 */
export const KNOWLEDGE_UPDATE_OVERRIDES: KnowledgeUpdateOverrides = {
  '07741c44': {
    kind: 'earlier',
    expected: 'answer_7e9ad7b4_1',
    stale: 'answer_7e9ad7b4_2',
    why: 'asks where the sneakers were kept at first (under the bed), not the closet shoe rack',
  },
  '0977f2af': {
    kind: 'earlier',
    expected: 'answer_3bf5b73b_1',
    stale: 'answer_3bf5b73b_2',
    why: 'asks for the gadget bought before the Air Fryer (the Instant Pot)',
  },
  '0ddfec37': {
    kind: 'earlier',
    expected: 'answer_a22b654d_1',
    stale: 'answer_a22b654d_2',
    why: 'asks for the count after the first three months (15), not the later 20',
  },
  '10e09553': {
    kind: 'earlier',
    expected: 'answer_67be2c38_1',
    stale: 'answer_67be2c38_2',
    why: 'asks for the catch on the trip before 7/22 (7 bass), not the 7/22 one',
  },
  '50635ada': {
    kind: 'earlier',
    expected: 'answer_dcd74827_1',
    stale: 'answer_dcd74827_2',
    why: 'asks for the status before the current one (Premier Silver), not Premier Gold',
  },
  '9bbe84a2': {
    kind: 'earlier',
    expected: 'answer_c6a0c6c2_1',
    stale: 'answer_c6a0c6c2_2',
    why: 'asks for the goal before it was updated (level 100), not level 150',
  },
  dfde3500: {
    kind: 'earlier',
    expected: 'answer_35d6c0be_1',
    stale: 'answer_35d6c0be_2',
    why: 'asks for the day with the previous tutor, Juan (Wednesday), not the Thursday with Maria',
  },
  e66b632c: {
    kind: 'earlier',
    expected: 'answer_ac0140ce_1',
    stale: 'answer_ac0140ce_2',
    why: 'asks for the previous personal best (27:45), not the newer 26:30',
  },
  '031748ae': {
    kind: 'recall-only',
    why: 'asks for both values: the team size at the start of the role and now',
  },
  '6071bd76': {
    kind: 'recall-only',
    why: 'asks how the coffee-to-water ratio changed, which needs both',
  },
  c4ea545c: {
    kind: 'recall-only',
    why: 'asks whether the gym visits became more frequent, which needs both',
  },
  c6853660: {
    kind: 'recall-only',
    why: 'asks whether the coffee limit went up or down, which needs both',
  },
  f685340e: {
    kind: 'recall-only',
    why: 'asks for both values: how often tennis was played before and now',
  },
  '89941a94': {
    kind: 'recall-only',
    why: 'asks about the bikes before the new one; the later session lists them too, so either answers it',
  },
  '69fee5aa': {
    kind: 'recall-only',
    why: 'the answer (38 coins) is the earlier total (37) plus the coin the later session adds',
  },
  '618f13b2': {
    kind: 'recall-only',
    why: 'the dates are the wrong way round: the session with the update is dated before the one it updates',
  },
};

/** `2023/05/20 (Sat) 02:21` as an ISO time (no zone in the file: read as UTC). */
export function parseLongMemEvalDate(s: string): string {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s*(?:\([A-Za-z]+\))?\s*(\d{2}):(\d{2})$/.exec(s.trim());
  if (m === null) throw new Error(`LongMemEval: unreadable date "${s}"`);
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])),
  ).toISOString();
}

interface Message {
  role: string;
  content: string;
  has_answer?: boolean;
}

/** A session's rounds: each user message with the assistant messages after it. */
export function roundsOf(
  session: Message[],
): { user: string; assistant: string; answer: boolean }[] {
  const out: { user: string; assistant: string; answer: boolean }[] = [];
  for (const m of session) {
    const cur = out[out.length - 1];
    if (m.role === 'user' || cur === undefined) {
      out.push({
        user: m.role === 'user' ? m.content : '',
        assistant: m.role === 'user' ? '' : m.content,
        answer: m.has_answer === true,
      });
    } else {
      cur.assistant = cur.assistant === '' ? m.content : `${cur.assistant}\n${m.content}`;
      cur.answer ||= m.has_answer === true;
    }
  }
  return out;
}

/** A question's answer sessions that have a `has_answer` message, oldest first. */
function answeredByDate(raw: Record<string, unknown>): string[] {
  const ids = raw['haystack_session_ids'] as string[];
  const dates = raw['haystack_dates'] as string[];
  const sessions = raw['haystack_sessions'] as Message[][];
  const at = (sid: string): number => {
    const i = ids.indexOf(sid);
    return Date.parse(parseLongMemEvalDate(dates[i] as string));
  };
  return ((raw['answer_session_ids'] as string[]) ?? [])
    .filter((sid) => sessions[ids.indexOf(sid)]?.some((m) => m.has_answer === true) === true)
    .sort((a, b) => at(a) - at(b));
}

/**
 * A question's current and outdated answer sessions: undefined when it has none to tell apart
 * (not knowledge-update, one answer session) or its override is recall-only; a problem when its
 * override does not fit it.
 */
function knowledgeUpdateSessions(
  raw: Record<string, unknown>,
  override: KnowledgeUpdateOverride | undefined,
): { current: string[]; stale: string[] } | { problem: string } | undefined {
  const qid = String(raw['question_id']);
  const ku = raw['question_type'] === 'knowledge-update' && !qid.endsWith('_abs');
  const answered = ku ? answeredByDate(raw) : [];
  if (override === undefined) {
    if (answered.length < 2) return undefined;
    // The latest answer is current; earlier ones are outdated.
    return { current: answered.slice(-1), stale: answered.slice(0, -1) };
  }
  if (answered.length !== 2) {
    return { problem: `${qid}: not a knowledge-update question with two answer sessions` };
  }
  if (override.kind === 'recall-only') return undefined;
  for (const sid of [override.expected, override.stale]) {
    if (!answered.includes(sid)) {
      return {
        problem: `${qid}: the override names ${sid}, which is not one of its answer sessions`,
      };
    }
  }
  const [first, later] = answered as [string, string];
  if (override.expected !== first || override.stale !== later) {
    return {
      problem: `${qid}: ${later} is the later answer session; an earlier-value override expects ${first} and counts ${later} as stale`,
    };
  }
  return { current: [first], stale: [later] };
}

/**
 * What is wrong with `overrides` for this file, one line per override that does not fit: its id
 * is missing, it is not a knowledge-update question with two answer sessions, or the sessions it
 * names are not that question's answer sessions in date order. Empty when every one fits.
 */
export function checkKnowledgeUpdateOverrides(
  json: unknown,
  overrides: KnowledgeUpdateOverrides = KNOWLEDGE_UPDATE_OVERRIDES,
): string[] {
  if (!Array.isArray(json)) throw new Error('LongMemEval: expected a JSON array of questions');
  const byId = new Map(
    (json as Record<string, unknown>[]).map((raw) => [String(raw['question_id']), raw]),
  );
  return Object.entries(overrides).flatMap(([id, o]) => {
    const raw = byId.get(id);
    if (raw === undefined) return [`${id}: not in the file`];
    const r = knowledgeUpdateSessions(raw, o);
    return r !== undefined && 'problem' in r ? [r.problem] : [];
  });
}

/**
 * Loads LongMemEval_S. `overrides` relabels knowledge-update questions where the later answer
 * session is not the current one for the question asked (default: the table for the pinned
 * revision); an override that does not fit its question throws.
 */
export function loadLongMemEval(
  json: unknown,
  overrides: KnowledgeUpdateOverrides = KNOWLEDGE_UPDATE_OVERRIDES,
): PublicSet {
  if (!Array.isArray(json)) throw new Error('LongMemEval: expected a JSON array of questions');
  const haystacks: Haystack[] = [];
  for (const raw of json as Record<string, unknown>[]) {
    const qid = String(raw['question_id']);
    const ids = raw['haystack_session_ids'] as string[];
    const dates = raw['haystack_dates'] as string[];
    const sessions = raw['haystack_sessions'] as Message[][];
    const answerSessions = (raw['answer_session_ids'] as string[]) ?? [];
    const turns: Turn[] = [];
    const evidenceBySession = new Map<string, string[]>();
    for (const [i, session] of sessions.entries()) {
      const sid = ids[i] as string;
      const start = Date.parse(parseLongMemEvalDate(dates[i] as string));
      for (const [r, round] of roundsOf(session).entries()) {
        const turnRef = `${sid}#${r}`;
        turns.push({
          turnRef,
          sessionId: sid,
          at: new Date(start + r * 1000).toISOString(),
          userText: round.user,
          assistantText: round.assistant,
        });
        if (round.answer)
          evidenceBySession.set(sid, [...(evidenceBySession.get(sid) ?? []), turnRef]);
      }
    }
    const abstention = qid.endsWith('_abs');
    const type = String(raw['question_type']);
    let evidence = [...evidenceBySession.values()].flat();
    let expectedSessions = answerSessions;
    let stale: string[] | undefined;
    let staleSessions: string[] | undefined;
    const labels = knowledgeUpdateSessions(
      raw,
      Object.hasOwn(overrides, qid) ? overrides[qid] : undefined,
    );
    if (labels !== undefined && 'problem' in labels)
      throw new Error(`LongMemEval: ${labels.problem}`);
    if (labels !== undefined) {
      // The current answer is expected; the outdated one is stale, for rounds and sessions alike.
      const roundsIn = (sids: string[]) => sids.flatMap((s) => evidenceBySession.get(s) ?? []);
      evidence = roundsIn(labels.current);
      stale = roundsIn(labels.stale);
      expectedSessions = labels.current;
      staleSessions = labels.stale;
    }
    const question: Question = {
      id: qid,
      question: String(raw['question']),
      group: abstention ? 'abstention' : type,
      evidence,
      answerSessions: expectedSessions,
      ...(stale !== undefined && { stale }),
      ...(staleSessions !== undefined && { staleSessions }),
      ...(abstention && { abstention: true }),
    };
    haystacks.push({
      id: qid,
      now: parseLongMemEvalDate(String(raw['question_date'])),
      turns,
      questions: [question],
    });
  }
  return {
    name: 'longmemeval',
    haystacks,
    groups: LONGMEMEVAL_GROUPS,
    droppedEvidence: 0,
    droppedQuestions: 0,
  };
}
