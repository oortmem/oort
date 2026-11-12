/**
 * LongMemEval_S (`longmemeval_s_cleaned.json`, CON-147): 500 questions, each with its own
 * haystack of about 50 chat sessions (user and assistant). One haystack per question. A memory is
 * one round (a user message and the assistant reply after it), the granularity LongMemEval's
 * authors found best for retrieval; its `turnRef` is `<session id>#<round>` and `at` is the
 * session's date plus a second per round. A round is evidence when either message has
 * `has_answer: true`.
 *
 * Scored twice: turn recall@k (rounds against `has_answer`) and session recall@k (the sessions of
 * the top k rounds against `answer_session_ids`). For `knowledge-update`, the latest answer
 * session (and its rounds) is expected and earlier answer sessions (and their rounds) count as
 * stale. The
 * 30 abstention questions (`_abs` ids) are their own group. Verbatim storage never supersedes, so
 * stale-leak here is a baseline to compare links against, not a measure of Oort's updates.
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

export function loadLongMemEval(json: unknown): PublicSet {
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
    const dateOf = new Map<string, number>();
    for (const [i, session] of sessions.entries()) {
      const sid = ids[i] as string;
      const start = Date.parse(parseLongMemEvalDate(dates[i] as string));
      dateOf.set(sid, start);
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
    if (type === 'knowledge-update' && !abstention) {
      const answered = answerSessions
        .filter((s) => evidenceBySession.has(s))
        .sort((a, b) => (dateOf.get(a) ?? 0) - (dateOf.get(b) ?? 0));
      const latest = answered[answered.length - 1];
      if (latest !== undefined && answered.length > 1) {
        // The latest answer is expected; earlier ones are outdated, for rounds and sessions alike.
        evidence = evidenceBySession.get(latest) ?? [];
        stale = answered.slice(0, -1).flatMap((s) => evidenceBySession.get(s) ?? []);
        expectedSessions = [latest];
        staleSessions = answered.slice(0, -1);
      }
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
