// Checks, on any OS, that an arm64 Mach-O binary carries an embedded code signature whose page
// hashes match the bytes they cover. macOS requires every arm64 binary to be signed (ad hoc is
// enough) and checks those hashes as it maps the pages, so a mismatch means the binary does not
// load. The release workflow runs this on the darwin-arm64 binary it cross-compiles on Linux,
// before upload. It is not a full verifier: no CMS signature, requirements or special slots.
// Usage: node check-macho-signature.mjs <file>; exits 1 and prints each problem if there are any.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSSLOT_CODEDIRECTORY = 0;
/** Code directory hash types this check knows: id to [Node hash name, digest size]. */
const HASHES = { 1: ['sha1', 20], 2: ['sha256', 32] };

/**
 * The problems with `file`'s code signature (the whole binary, as bytes); an empty list when it
 * is an arm64 Mach-O whose code directory covers everything before the signature and every page
 * hash matches.
 * @param {Buffer} file
 * @returns {string[]}
 */
export function machoSignatureProblems(file) {
  if (file.length < 32 || file.readUInt32LE(0) !== MH_MAGIC_64) {
    return ['not a 64-bit Mach-O file'];
  }
  if (file.readUInt32LE(4) !== CPU_TYPE_ARM64) return ['not an arm64 binary'];

  let signature;
  let at = 32;
  for (let i = 0, n = file.readUInt32LE(16); i < n; i++) {
    if (at + 8 > file.length) return ['the load commands run past the end of the file'];
    const cmd = file.readUInt32LE(at);
    const size = file.readUInt32LE(at + 4);
    if (size < 8) return [`load command ${i} has size ${size}`];
    if (cmd === LC_CODE_SIGNATURE && at + 16 <= file.length) {
      signature = { offset: file.readUInt32LE(at + 8), size: file.readUInt32LE(at + 12) };
    }
    at += size;
  }
  if (signature === undefined) return ['no code signature (LC_CODE_SIGNATURE)'];
  if (signature.offset + signature.size > file.length) {
    return ['the code signature runs past the end of the file'];
  }

  const blob = file.subarray(signature.offset, signature.offset + signature.size);
  if (blob.length < 12 || blob.readUInt32BE(0) !== CSMAGIC_EMBEDDED_SIGNATURE) {
    return ['the code signature is not an embedded signature'];
  }
  let cdAt;
  for (let i = 0, n = blob.readUInt32BE(8); i < n; i++) {
    const entry = 12 + i * 8;
    if (entry + 8 > blob.length) return ['the signature index runs past the signature'];
    if (blob.readUInt32BE(entry) === CSSLOT_CODEDIRECTORY) cdAt = blob.readUInt32BE(entry + 4);
  }
  if (cdAt === undefined) return ['the code signature has no code directory'];
  const cd = blob.subarray(cdAt);
  if (cd.length < 44 || cd.readUInt32BE(0) !== CSMAGIC_CODEDIRECTORY) {
    return ['the code directory is malformed'];
  }

  const hashOffset = cd.readUInt32BE(16);
  const codeSlots = cd.readUInt32BE(28);
  const codeLimit = cd.readUInt32BE(32);
  const hashSize = cd[36];
  const hash = HASHES[cd[37]];
  if (hash === undefined || hash[1] !== hashSize) {
    return [`unsupported code directory hash (type ${cd[37]}, ${hashSize} bytes)`];
  }
  // A page size of 0 (log2) means one page for the whole of the code.
  const pageSize = cd[39] === 0 ? codeLimit : 2 ** cd[39];
  const pages = Math.ceil(codeLimit / pageSize);
  if (hashOffset + codeSlots * hashSize > cd.length) {
    return ['the code directory hashes run past the signature'];
  }

  const problems = [];
  if (codeLimit !== signature.offset) {
    problems.push(
      `the signature covers ${codeLimit} bytes, not the ${signature.offset} before the signature`,
    );
  }
  if (codeSlots !== pages) {
    problems.push(`the code directory has ${codeSlots} page hashes for ${pages} pages`);
  }
  let mismatched = 0;
  for (let p = 0; p < Math.min(codeSlots, pages); p++) {
    const page = file.subarray(p * pageSize, Math.min((p + 1) * pageSize, codeLimit));
    const want = cd.subarray(hashOffset + p * hashSize, hashOffset + (p + 1) * hashSize);
    if (!createHash(hash[0]).update(page).digest().equals(want)) {
      if (mismatched++ < 5) problems.push(`page ${p} of ${pages}: its hash does not match`);
    }
  }
  if (mismatched > 5) problems.push(`${mismatched} pages in all do not match their hash`);
  return problems;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const target = process.argv[2];
  if (target === undefined) {
    console.error('usage: node check-macho-signature.mjs <file>');
    process.exit(2);
  }
  const problems = machoSignatureProblems(fs.readFileSync(target));
  for (const problem of problems) console.error(`${target}: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`${target}: code signature matches (arm64 Mach-O)`);
}
