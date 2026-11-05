// The memory card, for `explain` (one memory: tier, dates, history chain, the decisions behind it)
// and `remember` (what was saved, per fact). The result's shape says which one to draw.
(() => {
  const { h, facts, eyebrow, tierChip, day, boot } = globalThis.Oort;

  const OUTCOMES = {
    added: 'Saved',
    reinforced: 'Already known, reinforced',
    updated: 'Saved, updated a memory',
    superseded: 'Saved, replaced an older memory',
    corrected: 'Saved as a correction',
    skipped: 'Not saved',
  };

  const ENDED = { superseded: 'replaced', corrected: 'corrected', expired: 'expired' };

  const short = (id) => (typeof id === 'string' ? id.slice(0, 8) : '');

  function explainCard(data) {
    const m = data.memory ?? {};
    const ended = typeof m.valid_to === 'string' && m.valid_to !== '';
    const chain = Array.isArray(data.chain) ? data.chain : [];
    const decisions = Array.isArray(data.decisions) ? data.decisions : [];
    const hidden = typeof data.hidden_links === 'number' ? data.hidden_links : 0;
    return h(
      'article',
      { class: 'card', 'aria-label': 'Oort memory' },
      h(
        'header',
        {},
        eyebrow('Memory'),
        h('h1', { class: ended ? 'ended' : undefined }, String(m.text ?? '')),
      ),
      facts(
        tierChip(m.tier),
        typeof m.type === 'string' ? h('span', {}, m.type) : null,
        m.pinned === true ? h('span', {}, 'pinned') : null,
        typeof m.status === 'string' && m.status !== 'current'
          ? h('span', { class: 'flag' }, m.status)
          : null,
        day(m.valid_from, 'since'),
        ended ? day(m.valid_to, 'ended') : null,
      ),
      chain.length > 0 || hidden > 0
        ? h(
            'section',
            { 'aria-label': 'History' },
            h('h2', {}, 'History'),
            h(
              'ol',
              { class: 'chain' },
              chain.map((l, i) => {
                const lEnded = typeof l.valid_to === 'string' && l.valid_to !== '';
                return h(
                  'li',
                  { class: `item${lEnded ? ' ended' : ''}`, style: { '--i': String(i) } },
                  h('p', { class: 'text' }, String(l.text ?? '')),
                  facts(
                    day(l.valid_from, 'since'),
                    lEnded ? day(l.valid_to, ENDED[l.end_reason] ?? 'ended') : null,
                    h('span', { class: 'mono' }, short(l.id)),
                  ),
                );
              }),
              hidden > 0
                ? h(
                    'li',
                    { class: 'note' },
                    `${hidden} linked ${hidden === 1 ? 'version is' : 'versions are'} not visible here.`,
                  )
                : null,
            ),
          )
        : null,
      decisions.length > 0
        ? h(
            'details',
            {},
            h('summary', {}, 'How Oort decided'),
            h(
              'ul',
              { class: 'decisions' },
              decisions.map((d) =>
                h(
                  'li',
                  {},
                  `${d.stage ?? ''}: ${d.question ?? ''} → ${d.answer ?? ''}`,
                  typeof d.probability === 'number' ? ` (${Math.round(d.probability * 100)}%)` : '',
                ),
              ),
            ),
          )
        : null,
      facts(
        typeof m.source === 'string' && m.source !== '' ? h('span', {}, `from ${m.source}`) : null,
        day(m.created_at, 'saved'),
        h('span', { class: 'mono', title: String(m.id ?? '') }, short(m.id)),
      ),
    );
  }

  function rememberCard(data, input) {
    const given = Array.isArray(input?.facts) ? input.facts : [];
    const results = Array.isArray(data.results) ? data.results : [];
    const saved = results.filter((r) => r.outcome !== 'skipped').length;
    const heading =
      saved === 0 ? 'Nothing new saved' : `Saved ${saved} ${saved === 1 ? 'memory' : 'memories'}`;
    return h(
      'article',
      { class: 'card', 'aria-label': 'Oort saved memories' },
      h(
        'header',
        {},
        eyebrow('Remember'),
        h('h1', {}, heading),
        typeof input?.type === 'string' ? h('p', { class: 'summary' }, `as ${input.type}`) : null,
      ),
      h(
        'ul',
        { class: 'items', 'aria-label': 'Facts' },
        results.map((r, i) => {
          const skipped = r.outcome === 'skipped';
          const fact =
            typeof given[r.fact] === 'string' ? given[r.fact] : `Fact ${Number(r.fact) + 1}`;
          return h(
            'li',
            { class: `item${skipped ? ' ended' : ''}`, style: { '--i': String(i) } },
            h('p', { class: 'text' }, fact),
            facts(
              h(
                'span',
                { class: `outcome${skipped ? ' skipped' : ''}` },
                h('span', { 'aria-hidden': 'true' }, skipped ? '–' : '✓'),
                ' ',
                OUTCOMES[r.outcome] ?? String(r.outcome ?? ''),
              ),
              skipped && typeof r.reason === 'string' ? h('span', {}, r.reason) : null,
              typeof r.id === 'string' ? h('span', { class: 'mono' }, short(r.id)) : null,
            ),
          );
        }),
      ),
    );
  }

  function render({ input, result, cancelled }) {
    if (result === undefined) {
      return h(
        'article',
        { class: 'card', 'aria-label': 'Oort memory', 'aria-busy': cancelled ? 'false' : 'true' },
        h('header', {}, eyebrow('Memory')),
        h('p', { class: 'pending' }, cancelled ? 'Cancelled.' : 'Working…'),
      );
    }
    if (result.error !== undefined) {
      return h(
        'article',
        { class: 'card', 'aria-label': 'Oort memory' },
        h('header', {}, eyebrow('Memory')),
        h('p', { class: 'note error', role: 'status' }, result.error),
      );
    }
    const data = result.data ?? {};
    if (Array.isArray(data.results)) return rememberCard(data, input);
    return explainCard(data);
  }

  boot('Oort memory card', render);
})();
