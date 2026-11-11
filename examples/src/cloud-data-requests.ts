import { writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOort } from 'oortmem';

// Answering an end user's data requests (GDPR access, portability, rectification, erasure) from
// your server, with a server key in OORT_API_KEY. The person asks you; you answer with this.
const oort = await createOort({
  mode: 'cloud',
  org: 'acme',
  project: null,
  projectConfig: false,
  keySources: ['env'],
});
const ada = oort.scoped({ user: 'user-ada' });
await ada.remember('I live in Oslo.');

// Access and portability: every memory Oort holds for them, in every state, as one file in the
// Oort export format. Hand it over as it is; `oort import <file>` reads it into any Oort.
const copy = await oort.endUsers.export('user-ada');
const file = path.join(os.tmpdir(), 'user-ada-memories.jsonl');
await writeFile(file, copy.jsonl, { mode: 0o600 });
console.log(`exported ${copy.memories} memories`);

// Rectification: save the corrected fact as them. Oort ends the wrong one (kept as history with
// an end date, never rewritten), and recall answers with the correction.
const [wrong] = (await ada.recall('where do I live?')).memories;
await ada.remember('Correction: I live in Bergen, not Oslo.');
// A wrong fact Oort did not end, or one they want gone even as history: forgetting deletes it.
if (wrong !== undefined && (await ada.explain(wrong.id)).memory.status === 'current') {
  await ada.forget(wrong.id);
  console.log('forgot the wrong fact');
}

// Erasure: everything of theirs at once. Their export is then empty, as for an id you never had.
const erased = await oort.endUsers.erase('user-ada');
console.log(`erased ${erased.memories} memories`);
console.log(`left ${(await oort.endUsers.export('user-ada')).memories}`);
await oort.close();
