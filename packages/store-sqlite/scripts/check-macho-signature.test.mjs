import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { machoSignatureProblems } from './check-macho-signature.mjs';

const PAGE = 4096;

/**
 * A minimal arm64 Mach-O: header, one LC_CODE_SIGNATURE, `codeBytes` of content, then an embedded
 * signature whose code directory hashes every 4 KiB page before it with SHA-256.
 */
function signedMacho(codeBytes = 10_000) {
  const code = Buffer.alloc(codeBytes);
  code.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  code.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  code.writeUInt32LE(6, 12); // MH_DYLIB
  code.writeUInt32LE(1, 16); // ncmds
  code.writeUInt32LE(16, 20); // sizeofcmds
  for (let i = 48; i < codeBytes; i++) code[i] = (i * 31) & 0xff;

  const ident = Buffer.from('test\0');
  const pages = Math.ceil(codeBytes / PAGE);
  const hashOffset = 44 + ident.length;
  const cd = Buffer.alloc(hashOffset + pages * 32);
  cd.writeUInt32BE(0xfade0c02, 0); // CSMAGIC_CODEDIRECTORY
  cd.writeUInt32BE(cd.length, 4);
  cd.writeUInt32BE(0x20400, 8); // version
  cd.writeUInt32BE(0x20002, 12); // adhoc, linker-signed
  cd.writeUInt32BE(hashOffset, 16);
  cd.writeUInt32BE(44, 20); // identOffset
  cd.writeUInt32BE(0, 24); // nSpecialSlots
  cd.writeUInt32BE(pages, 28); // nCodeSlots
  cd.writeUInt32BE(codeBytes, 32); // codeLimit
  cd[36] = 32; // hashSize
  cd[37] = 2; // SHA-256
  cd[39] = 12; // log2(page size)
  ident.copy(cd, 44);

  const superBlob = Buffer.alloc(20);
  superBlob.writeUInt32BE(0xfade0cc0, 0); // CSMAGIC_EMBEDDED_SIGNATURE
  superBlob.writeUInt32BE(20 + cd.length, 4);
  superBlob.writeUInt32BE(1, 8); // count
  superBlob.writeUInt32BE(0, 12); // CSSLOT_CODEDIRECTORY
  superBlob.writeUInt32BE(20, 16); // offset of the code directory

  code.writeUInt32LE(0x1d, 32); // LC_CODE_SIGNATURE
  code.writeUInt32LE(16, 36);
  code.writeUInt32LE(codeBytes, 40); // dataoff
  code.writeUInt32LE(superBlob.length + cd.length, 44); // datasize
  for (let p = 0; p < pages; p++) {
    createHash('sha256')
      .update(code.subarray(p * PAGE, Math.min((p + 1) * PAGE, codeBytes)))
      .digest()
      .copy(cd, hashOffset + p * 32);
  }
  return Buffer.concat([code, superBlob, cd]);
}

describe('machoSignatureProblems', () => {
  it('accepts a binary whose page hashes match its contents', () => {
    expect(machoSignatureProblems(signedMacho())).toEqual([]);
  });

  it('reports a page changed after signing', () => {
    const file = signedMacho();
    file[5000] ^= 0xff; // page 1
    expect(machoSignatureProblems(file).join('\n')).toMatch(/page 1 of 3/);
  });

  it('reports a binary with no code signature', () => {
    const file = signedMacho();
    file.writeUInt32LE(0x26, 32); // LC_FUNCTION_STARTS instead of LC_CODE_SIGNATURE
    expect(machoSignatureProblems(file)).toEqual(['no code signature (LC_CODE_SIGNATURE)']);
  });

  it('reports a signature that does not cover everything before it', () => {
    const file = signedMacho();
    const cdAt = 10_000 + 20;
    file.writeUInt32BE(8192, cdAt + 32); // codeLimit: two pages, not the 10,000 bytes
    expect(machoSignatureProblems(file).join('\n')).toMatch(/covers 8192 bytes/);
  });

  it('refuses a binary for another CPU or format', () => {
    const x64 = signedMacho();
    x64.writeUInt32LE(0x01000007, 4); // CPU_TYPE_X86_64
    expect(machoSignatureProblems(x64)).toEqual(['not an arm64 binary']);
    expect(machoSignatureProblems(Buffer.from('\x7fELF............................'))).toEqual([
      'not a 64-bit Mach-O file',
    ]);
  });

  // The binary build-native.mjs produced on this machine, when there is one (an Apple-silicon Mac).
  const built = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'native',
    'oort-rabitq.darwin-arm64.node',
  );
  it.skipIf(!fs.existsSync(built))('accepts the darwin-arm64 binary built here', () => {
    const file = fs.readFileSync(built);
    expect(machoSignatureProblems(file)).toEqual([]);
    file[file.length >> 1] ^= 0xff;
    expect(machoSignatureProblems(file).join('\n')).toMatch(/hash does not match/);
  });
});
