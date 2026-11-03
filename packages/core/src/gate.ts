/** Acknowledgments and fillers that never warrant a memory lookup. */
export const ACKNOWLEDGMENTS: readonly string[] = [
  'ok',
  'okay',
  'yes',
  'yes please',
  'no',
  'thanks',
  'thank you',
  'thx',
  'continue',
  'go ahead',
  'go on',
  'proceed',
  'lgtm',
  'looks good',
  'sounds good',
  'done',
  'next',
  'y',
  'n',
  'k',
];

const MIN_LENGTH = 12;

export type GateReason = 'slash-command' | 'too-short' | 'acknowledgment' | 'ok';

/** Cheap, synchronous gate: should this prompt trigger a memory recall at all? */
export function shouldRecall(prompt: string): { recall: boolean; reason: GateReason } {
  const p = prompt.trim();
  if (p.startsWith('/')) return { recall: false, reason: 'slash-command' };
  if (p.length < MIN_LENGTH) return { recall: false, reason: 'too-short' };
  const norm = p.toLowerCase().replace(/[\p{P}\s]+$/u, '');
  if (ACKNOWLEDGMENTS.includes(norm)) return { recall: false, reason: 'acknowledgment' };
  return { recall: true, reason: 'ok' };
}
