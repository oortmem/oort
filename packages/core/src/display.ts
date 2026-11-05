/**
 * Characters that must never reach a terminal or a person deciding something as they are: C0 and
 * C1 controls, the bidi controls (Trojan Source) and zero-width or other invisible format
 * characters. One source for the CLI's `shown()`/`safeJson()` and for judgment memory's input
 * checks (CON-71), so the two never drift. Written as escapes: no literal one sits in this file.
 */
export const DISPLAY_UNSAFE_SOURCE =
  '[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]';

/** DISPLAY_UNSAFE_SOURCE without C0 and C1: the bidi and invisible format characters alone. */
export const INVISIBLE_SOURCE =
  '[\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]';
