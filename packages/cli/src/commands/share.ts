import { findCloudMemory, type CloudShareResult, type ShareFinding } from '../cloud.js';
import { uiFor, type Ui } from '../ui.js';
import { Refusal, clip, cloudOf, confirm, echo, short, withWired, type Ctx } from '../util.js';

/** What each kind of finding is called in the preview. */
const KIND: Record<string, string> = {
  secret: 'a secret (redacted, never shared)',
  email: 'an email address',
  phone: 'a phone number',
  iban: 'a bank account number',
  'card-number': 'a card number',
  'ip-address': 'an IP address',
};

/** The text with each finding marked, so the person sees exactly what would leave. */
export function marked(text: string, findings: readonly ShareFinding[], ui: Ui): string {
  let out = '';
  let at = 0;
  for (const f of [...findings].sort((a, b) => a.start - b.start)) {
    if (f.start < at || f.end > text.length) continue;
    const span = text.slice(f.start, f.end);
    out += text.slice(at, f.start) + (ui.color ? ui.bold(ui.accent(span)) : `»${span}«`);
    at = f.end;
  }
  return out + text.slice(at);
}

/** A Constellation as people tell them apart: its name and the start of its id. */
export const labelOf = (p: Pick<CloudShareResult, 'constellation' | 'constellationId'>): string =>
  `${p.constellation} (${p.constellationId.slice(0, 6)})`;

const CONSTELLATION_ID = /^c_[a-z0-9]{16}$/;

function preview(p: CloudShareResult, ui: Ui): string {
  const lines = [
    `Share to Constellation ${labelOf(p)} (a copy; your memory stays as it is):`,
    '',
    `  ${marked(p.text, p.findings, ui).replace(/\n/g, '\n  ')}`,
    '',
  ];
  if (p.findings.length > 0) {
    const kinds = [...new Set(p.findings.map((f) => KIND[f.kind] ?? f.kind))];
    lines.push(`Found ${kinds.join(', ')}. Edit with --text "<what to share>" if needed.`, '');
  }
  return lines.join('\n');
}

/**
 * `oort share <id> --to <constellation> [--text <t>] [--yes] [--json]` (Uplink): copies one of
 * your Oort Cloud memories into a Constellation, with provenance. Shows exactly the text that
 * would be shared first (secrets already redacted, personal data marked); nothing is shared until
 * you confirm. A non-terminal session needs --yes.
 */
export async function shareCommand(
  id: string,
  opts: { to?: string; text?: string; yes?: boolean; json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const to = opts.to?.trim() ?? '';
  if (to === '') throw new Refusal('Name the Constellation: oort share <id> --to <name>.');
  if (opts.text !== undefined && opts.text.trim() === '') {
    throw new Refusal('--text needs the text to share.');
  }
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    if (cloud === undefined) {
      throw new Refusal(
        'Constellations live in Oort Cloud: share from a machine that uses it (`oort cloud use`).',
      );
    }
    const m = await findCloudMemory(cloud, id);
    // State this project's privacy: the cloud decides from the shared memory's own project, and
    // refuses one whose privacy no client inside it has stated yet.
    const project = w.scope.projectId;
    const body = {
      memoryId: m.id,
      ...(opts.text !== undefined && { text: opts.text }),
      ...(project !== undefined && { project, projectPrivate: w.config.project.private }),
    };
    const ui = uiFor(ctx.io);
    const p = await cloud.share(to, body);
    // The confirm goes to exactly the Constellation this preview resolved, by id: never the
    // typed name again, so a rename or a same-named Constellation can't redirect the share.
    if (typeof p.constellationId !== 'string' || !CONSTELLATION_ID.test(p.constellationId)) {
      throw new Refusal('Oort Cloud did not say which Constellation this is; nothing was shared.');
    }
    if (opts.json !== true) ctx.io.out(preview(p, ui));
    const ok = await confirm(
      ctx.io,
      `Share ${short(m.id)} "${clip(p.text, 40)}" with ${echo(p.constellation)} (${p.constellationId.slice(0, 6)})?`,
      opts.yes === true,
      'share it',
    );
    if (!ok) {
      ctx.io.out('Not shared.\n');
      return 0;
    }
    // Confirm exactly the text that was shown, with the preview's token. Personal data it found
    // is acknowledged only here: after the person said yes (or passed --yes).
    if (p.previewToken === undefined) {
      throw new Refusal('Oort Cloud did not return a preview to confirm; nothing was shared.');
    }
    const pii = p.findings.some((f) => f.kind !== 'secret');
    const done = await cloud.share(p.constellationId, {
      ...body,
      text: p.text,
      previewToken: p.previewToken,
      confirm: true,
      ...(pii && { acknowledgedFindings: true }),
    });
    if (opts.json === true) {
      ctx.io.out(`${JSON.stringify(done, null, 2)}\n`);
      return 0;
    }
    ctx.io.out(
      `Shared to Constellation ${labelOf(done)} as ${done.id ?? '?'}. Members' agents recall it labelled with the Constellation.\n`,
    );
    return 0;
  });
}
