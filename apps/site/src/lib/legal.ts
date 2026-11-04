/**
 * Fill these in ONE place. Every legal page reads from here.
 * Search for "TODO" and "Pending" to find what is still open.
 */
export const legal = {
  entity: 'Marcus Jonathan Ong (enskild firma, a Swedish sole trader)',
  /** Street, postcode and city; pages append the country. */
  address: 'Smörkärnegatan 21, 412 78 Gothenburg',
  country: 'Sweden',
  /** Privacy and data requests. */
  contactEmail: 'privacy@oortcloud.dev',
  /** General contact. */
  generalEmail: 'hello@oortcloud.dev',
  /** Momsregistreringsnummer, checked as valid in the EU VIES register on 2026-11-04. */
  vatNumber: 'SE960505691101' as string | null,
  /** Swedish supervisory authority for data protection complaints. */
  authority: { name: 'Integritetsskyddsmyndigheten (IMY)', url: 'https://www.imy.se' },
  /** Date of the current draft. */
  updated: '5 November 2026',
} as const;
