import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { Memory } from '@oortmem/core';

/**
 * Serialises a full memory (embedding included, so hydration never re-embeds)
 * into a cold blob. Dictionary support is a Phase 2 extension; it gets its own
 * frame version.
 */
export interface ColdCodec {
  encode(m: Memory): Uint8Array;
  decode(b: Uint8Array): Memory;
}

const VERSION = 0x01;
const LEVEL = 19;

/**
 * Frame version 1:
 *
 *     u8 version (0x01)
 *     u32 big-endian length of the compressed JSON
 *     zstd (level 19) of the UTF-8 JSON of the memory without its embedding
 *     u8 embedding-present flag (0 or 1)
 *     raw int8 embedding bytes, uncompressed
 *
 * Only the JSON is compressed. Quantised int8 embeddings are near-incompressible
 * (a full-range 512-d vector grows under zstd), so compressing them costs CPU
 * and frame overhead; and mixing them into the JSON's zstd block makes that
 * block share one literal Huffman table between English and noise, which
 * measurably hurts the text's compression too.
 */
export function createColdCodec(): ColdCodec {
  return {
    encode(m) {
      const { embedding, ...rest } = m;
      const json = zstdCompressSync(Buffer.from(JSON.stringify(rest), 'utf8'), {
        params: { [constants.ZSTD_c_compressionLevel]: LEVEL },
      });
      const vec = embedding ?? new Int8Array(0);
      const frame = Buffer.alloc(1 + 4 + json.length + 1 + vec.byteLength);
      frame[0] = VERSION;
      frame.writeUInt32BE(json.length, 1);
      json.copy(frame, 5);
      frame[5 + json.length] = embedding === undefined ? 0 : 1;
      Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).copy(frame, 6 + json.length);
      return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    },

    decode(b) {
      const frame = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
      if (frame.length < 6) throw new Error('cold blob: frame too short');
      if (frame[0] !== VERSION) {
        throw new Error(`cold blob: unsupported frame version ${String(frame[0])}`);
      }
      const jsonLength = frame.readUInt32BE(1);
      const flagAt = 5 + jsonLength;
      if (flagAt >= frame.length) throw new Error('cold blob: JSON length exceeds frame');
      const json = zstdDecompressSync(frame.subarray(5, flagAt));
      const m = JSON.parse(json.toString('utf8')) as Memory;
      const flag = frame[flagAt];
      const bytes = frame.subarray(flagAt + 1);
      if (flag === 0) {
        if (bytes.length !== 0) throw new Error('cold blob: trailing bytes without an embedding');
        return m;
      }
      if (flag !== 1) throw new Error(`cold blob: bad embedding flag ${String(flag)}`);
      // Copy out so the embedding does not pin the blob's buffer.
      return {
        ...m,
        embedding: Int8Array.from(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length)),
      };
    },
  };
}
