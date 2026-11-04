/**
 * Fill these in ONE place. Every legal page reads from here.
 * Search for "TODO" and "Pending" to find what is still open.
 */
export const legal = {
  entity: 'Marcus Jonathan Ong (sole trader, Sweden)',
  // TODO(Marcus): add the postcode to the address.
  address: 'Smörkärnegatan 21, Gothenburg, Sweden',
  country: 'Sweden',
  /** Privacy and data requests. */
  contactEmail: 'privacy@oortcloud.dev',
  /** General contact. */
  generalEmail: 'hello@oortcloud.dev',
  // Pending: Marcus to confirm the VAT number (Swedish format SE + 10-digit org no. + 01).
  vatNumber: null as string | null,
  /** Swedish supervisory authority for data protection complaints. */
  authority: { name: 'Integritetsskyddsmyndigheten (IMY)', url: 'https://www.imy.se' },
  /** Date of the current draft. */
  updated: '5 November 2026',
} as const;
