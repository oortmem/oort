// The recall card: the query, the memories that came back, their tier and dates, and why each
// was picked. Display only; the model reads the same result as text.
(() => {
  const { h, facts, eyebrow, tierChip, day, boot } = globalThis.Oort;

  /** `lexical #1, dense #3, rerank 0.81` in plain words. Unknown parts pass through. */
  function whyWords(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const words = [];
    for (const part of raw.split(',').map((p) => p.trim())) {
      let m;
      if (/^lexical\b/.test(part)) words.push('matching words');
      else if (/^dense\b/.test(part)) words.push('similar meaning');
      else if ((m = /^rerank\s+([\d.]+)/.exec(part))) words.push(`relevance ${m[1]}`);
      else if (part === 'history chain') words.push('part of its history');
      else if (part === 'activation') words.push('used often lately');
      else if (part !== '') words.push(part);
    }
    return words.length > 0 ? words.join(' · ') : null;
  }

  function memoryItem(m, i) {
    const ended = typeof m.valid_to === 'string' && m.valid_to !== '';
    const why = whyWords(m.why);
    return h(
      'li',
      { class: `item${ended ? ' ended' : ''}`, style: { '--i': String(i) } },
      h('p', { class: 'text' }, String(m.text ?? '')),
      facts(
        tierChip(m.tier),
        typeof m.type === 'string' ? h('span', {}, m.type) : null,
        day(m.valid_from, 'since'),
        ended ? day(m.valid_to, 'ended') : null,
        m.stale === true ? h('span', { class: 'flag' }, 'may be outdated') : null,
      ),
      why ? h('p', { class: 'why', title: String(m.why) }, h('b', {}, 'Why: '), why) : null,
    );
  }

  function render({ input, result, cancelled }) {
    const query = typeof input?.query === 'string' ? input.query : '';
    const heading = h('h1', {}, query ? `“${query}”` : 'Recall');
    if (result === undefined) {
      return h(
        'section',
        { class: 'card', 'aria-label': 'Oort recall', 'aria-busy': cancelled ? 'false' : 'true' },
        h('header', {}, eyebrow('Recall'), heading),
        h('p', { class: 'pending' }, cancelled ? 'Recall was cancelled.' : 'Searching memory…'),
      );
    }
    if (result.error !== undefined) {
      return h(
        'section',
        { class: 'card', 'aria-label': 'Oort recall' },
        h('header', {}, eyebrow('Recall'), heading),
        h('p', { class: 'note error', role: 'status' }, result.error),
      );
    }
    const data = result.data ?? {};
    const memories = Array.isArray(data.memories) ? data.memories : [];
    const count = `${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}`;
    const mode = typeof data.mode === 'string' && data.mode !== '' ? data.mode : null;
    return h(
      'section',
      { class: 'card', 'aria-label': 'Oort recall' },
      h(
        'header',
        {},
        eyebrow('Recall'),
        heading,
        h('p', { class: 'summary' }, mode ? `${count} · ${mode}` : count),
      ),
      memories.length > 0
        ? h('ol', { class: 'items', 'aria-label': 'Recalled memories' }, memories.map(memoryItem))
        : h(
            'p',
            { class: 'empty' },
            data.abstained === true
              ? 'Nothing in memory answers this.'
              : 'No memories matched this query.',
          ),
      // An abstention's note is advice for the model; the empty state already says it.
      typeof data.note === 'string' && data.note !== '' && data.abstained !== true
        ? h('p', { class: 'note' }, data.note)
        : null,
    );
  }

  boot('Oort recall card', render);
})();
