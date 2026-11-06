/**
 * `oortmem`: Oort memory from code (CON-108). `createOort()` gives a handle whose scope is fixed;
 * it runs the engine in this process (`local`) or calls Oort Cloud (`cloud`). This root export
 * never loads the CLI (commander, prompts, colours), and cloud mode loads no native module.
 *
 * @example
 * import { createOort, formatForPrompt } from 'oortmem';
 * const oort = await createOort();
 * const r = await oort.recall('how do we deploy?');
 * console.log(formatForPrompt(r));
 * await oort.observe({ user: 'We deploy on Fridays now.', assistant: 'Noted.' });
 */
export { VERSION } from '@oortmem/core';
export { createOort } from './create.js';
export { formatForPrompt } from './views.js';
export {
  OortAmbiguousIdError,
  OortCloudOnlyError,
  OortError,
  OortInternalError,
  OortNeedsConfirmationError,
  OortNeedsKeyError,
  OortNeedsLoginError,
  OortNetworkError,
  OortNotFoundError,
  OortRefusedError,
  OortUsageError,
  type ModelRole,
  type OortErrorCode,
} from './errors.js';
export type * from './types.js';
