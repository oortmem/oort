import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VatLine } from '@/components/site/LegalPage';
import { legal } from '@/lib/legal';

describe('legal details', () => {
  it('has no unfilled placeholders', () => {
    expect(JSON.stringify(legal)).not.toContain('{{');
  });
  it('shows the VAT number in the Swedish format (SE + 10-digit org no. + 01)', () => {
    expect(legal.vatNumber).toMatch(/^SE\d{10}01$/);
    expect(renderToStaticMarkup(<VatLine />)).toBe(`<p>VAT number: ${legal.vatNumber}</p>`);
  });
  it('does not repeat the country in the address', () => {
    expect(legal.address).not.toContain(legal.country);
  });
  it('names IMY as the supervisory authority', () => {
    expect(legal.authority.url).toBe('https://www.imy.se');
  });
});
