import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VatLine } from '@/components/site/LegalPage';
import { legal } from '@/lib/legal';

describe('legal details', () => {
  it('has no unfilled placeholders', () => {
    expect(JSON.stringify(legal)).not.toContain('{{');
  });
  it('hides the VAT line while the number is null', () => {
    expect(legal.vatNumber).toBeNull();
    expect(renderToStaticMarkup(<VatLine />)).toBe('');
  });
  it('names IMY as the supervisory authority', () => {
    expect(legal.authority.url).toBe('https://www.imy.se');
  });
});
