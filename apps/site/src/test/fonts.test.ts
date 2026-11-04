import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Route } from '@/routes/__root';

describe('self-hosted fonts', () => {
  it('the rendered head has no Google Fonts links', () => {
    const head = JSON.stringify(Route.options.head?.({} as never));
    expect(head).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });
  it('the stylesheet loads Geist and Geist Mono from the bundle', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../styles.css'), 'utf8');
    expect(css).toContain('@fontsource-variable/geist');
    expect(css).toContain('@fontsource-variable/geist-mono');
    expect(css).not.toMatch(/googleapis|gstatic/);
  });
});
