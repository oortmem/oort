// Shared by every Oort widget. Runs inside the host's sandboxed iframe after the ext-apps runtime,
// which sets globalThis.ExtApps. Everything is built as DOM nodes and text, never parsed markup, and nothing
// is fetched or logged: the data arrives with the tool call and stays in this frame.
(() => {
  const { App, applyDocumentTheme, applyHostStyleVariables } = globalThis.ExtApps;

  const TIERS = { hot: 'Photosphere', warm: 'Kuiper Belt', cold: 'Oort Cloud' };
  const SVG = 'http://www.w3.org/2000/svg';

  /** An element with attributes and children; strings become text nodes. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style')
        for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c === undefined || c === null || c === false) continue;
      el.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
    }
    return el;
  }

  /** The Oort mark: a star with one orbit. Decorative. */
  function mark() {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const orbit = document.createElementNS(SVG, 'ellipse');
    for (const [k, v] of Object.entries({
      cx: 8,
      cy: 8,
      rx: 7,
      ry: 3.2,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.2,
      transform: 'rotate(-25 8 8)',
    }))
      orbit.setAttribute(k, String(v));
    const star = document.createElementNS(SVG, 'circle');
    for (const [k, v] of Object.entries({ cx: 8, cy: 8, r: 2.4, fill: 'currentColor' }))
      star.setAttribute(k, String(v));
    svg.append(orbit, star);
    return svg;
  }

  /** A row of short facts, separated by a dot that screen readers skip. */
  function facts(...items) {
    const row = h('p', { class: 'facts' });
    for (const item of items.flat()) {
      if (item === undefined || item === null || item === false) continue;
      if (row.childNodes.length > 0) {
        row.append(' ', h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), ' ');
      }
      row.append(item);
    }
    return row;
  }

  function eyebrow(label) {
    return h('p', { class: 'eyebrow' }, mark(), h('span', {}, 'Oort'), h('span', {}, label));
  }

  /** A tier chip: color plus the tier's name, so color is never the only cue. */
  function tierChip(tier) {
    if (typeof tier !== 'string' || tier === '') return null;
    const name = TIERS[tier] ?? tier;
    return h(
      'span',
      { class: `tier tier-${tier}`, title: `Tier: ${name}` },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', {}, name),
    );
  }

  let locale;
  let timeZone;
  /** A date as a <time>, in the host's locale; invalid input renders nothing. */
  function day(iso, prefix) {
    if (typeof iso !== 'string' || iso === '') return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    let label;
    try {
      label = new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        ...(timeZone && { timeZone }),
      }).format(d);
    } catch {
      label = iso.slice(0, 10);
    }
    return h('span', {}, prefix ? `${prefix} ` : '', h('time', { datetime: iso }, label));
  }

  /** A tool result as data: structured content, else the JSON text, else an error or raw text. */
  function parseResult(result) {
    const text = (result?.content ?? [])
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
    if (result?.isError) return { error: text || 'The tool reported an error.' };
    if (result?.structuredContent && typeof result.structuredContent === 'object') {
      return { data: result.structuredContent };
    }
    try {
      return { data: JSON.parse(text) };
    } catch {
      return { error: text || 'No result.' };
    }
  }

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (typeof ctx.locale === 'string') locale = ctx.locale;
    if (typeof ctx.timeZone === 'string') timeZone = ctx.timeZone;
  }

  /**
   * Connects to the host and re-renders on each tool input and result. `render` gets
   * `{ input, result }` (result is undefined while the call runs) and returns one element.
   */
  function boot(name, render) {
    const root = document.getElementById('root');
    const state = { input: undefined, result: undefined, cancelled: false };
    const draw = () => {
      try {
        root.replaceChildren(render(state));
      } catch {
        root.replaceChildren(
          h('p', { class: 'note error' }, 'This card could not show the result.'),
        );
      }
    };
    const app = new App({ name, version: '1.0.0' }, {}, { autoResize: true });
    // Handlers go on before connect(): the input and result can arrive right after it.
    app.ontoolinput = (params) => {
      state.input = params?.arguments ?? {};
      draw();
    };
    app.ontoolresult = (result) => {
      state.result = parseResult(result);
      draw();
    };
    app.ontoolcancelled = () => {
      state.cancelled = true;
      draw();
    };
    app.onhostcontextchanged = (ctx) => {
      applyContext(ctx);
      draw();
    };
    (async () => {
      try {
        await app.connect();
        applyContext(app.getHostContext());
      } catch {
        // No host on the other side (opened directly): the text result is what the user sees.
      }
      draw();
    })();
  }

  globalThis.Oort = { h, facts, eyebrow, tierChip, day, boot, TIERS };
})();
