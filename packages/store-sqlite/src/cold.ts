import { constants, crc32, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { Memory } from '@oortmem/core';

/**
 * Serialises a full memory (embedding included, so hydration never re-embeds)
 * into a cold blob. Dictionary support is a Phase 2 extension; it gets its own
 * frame version.
 */
export interface ColdCodec {
  encode(m: Memory): Uint8Array;
  /** Throws `ColdBlobCorruptError` for anything that is not an intact frame. */
  decode(b: Uint8Array): Memory;
}

/** A cold blob that is truncated, bit-flipped, of an unknown version, or of the wrong dimension. */
export class ColdBlobCorruptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`cold blob corrupt: ${message}`, options);
    this.name = 'ColdBlobCorruptError';
  }
}

export interface ColdCodecOptions {
  /** When set, `decode` rejects a blob whose embedding has another length. */
  dimension?: number;
}

const V1 = 0x01;
const V2 = 0x02;
const LEVEL = 19;

/**
 * Frame version 2 (written):
 *
 *     u8 version (0x02)
 *     u32 big-endian length of the compressed JSON
 *     zstd (level 19) of the UTF-8 JSON of the memory without its embedding
 *     u32 big-endian embedding length (0 when absent)
 *     raw int8 embedding bytes, uncompressed
 *     u32 big-endian CRC32 of every byte before it
 *
 * Only the JSON is compressed. Quantised int8 embeddings are near-incompressible
 * (a full-range 512-d vector grows under zstd), so compressing them costs CPU
 * and frame overhead; and mixing them into the JSON's zstd block makes that
 * block share one literal Huffman table between English and noise, which
 * measurably hurts the text's compression too. The CRC and the explicit
 * length make a truncated or bit-flipped blob fail loudly instead of decoding
 * into a memory with a short embedding.
 *
 * Frame version 1 (read only): u8 0x01, u32 JSON length, zstd JSON, u8
 * embedding flag, raw bytes. It has no checksum, so its embedding length is
 * checked against `dimension` when known.
 */
export function createColdCodec(opts: ColdCodecOptions = {}): ColdCodec {
  const { dimension } = opts;

  function parseJson(compressed: Buffer): Memory {
    let m: unknown;
    try {
      m = JSON.parse(zstdDecompressSync(compressed).toString('utf8'));
    } catch (e) {
      throw new ColdBlobCorruptError('JSON section does not decode', { cause: e });
    }
    if (typeof m !== 'object' || m === null || typeof (m as Memory).id !== 'string') {
      throw new ColdBlobCorruptError('JSON section is not a memory');
    }
    return m as Memory;
  }

  function withEmbedding(m: Memory, bytes: Buffer): Memory {
    if (dimension !== undefined && bytes.length !== dimension) {
      throw new ColdBlobCorruptError(
        `embedding has ${bytes.length} dimensions, store dimension is ${dimension}`,
      );
    }
    // Copy out so the embedding does not pin the blob's buffer.
    const embedding = Int8Array.from(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length));
    return { ...m, embedding };
  }

  function decodeV2(frame: Buffer): Memory {
    if (frame.length < 13) throw new ColdBlobCorruptError('frame too short');
    const end = frame.length - 4;
    if (crc32(frame.subarray(0, end)) !== frame.readUInt32BE(end)) {
      throw new ColdBlobCorruptError('checksum mismatch');
    }
    const jsonLength = frame.readUInt32BE(1);
    const embAt = 5 + jsonLength;
    if (embAt + 4 > end) throw new ColdBlobCorruptError('JSON length exceeds frame');
    const embLength = frame.readUInt32BE(embAt);
    if (embAt + 4 + embLength !== end) throw new ColdBlobCorruptError('embedding length mismatch');
    const m = parseJson(frame.subarray(5, embAt));
    return embLength === 0 ? m : withEmbedding(m, frame.subarray(embAt + 4, end));
  }

  function decodeV1(frame: Buffer): Memory {
    if (frame.length < 6) throw new ColdBlobCorruptError('frame too short');
    const flagAt = 5 + frame.readUInt32BE(1);
    if (flagAt >= frame.length) throw new ColdBlobCorruptError('JSON length exceeds frame');
    const m = parseJson(frame.subarray(5, flagAt));
    const bytes = frame.subarray(flagAt + 1);
    const flag = frame[flagAt];
    if (flag === 0) {
      if (bytes.length !== 0) throw new ColdBlobCorruptError('trailing bytes without an embedding');
      return m;
    }
    if (flag !== 1) throw new ColdBlobCorruptError(`bad embedding flag ${String(flag)}`);
    return withEmbedding(m, bytes);
  }

  return {
    encode(m) {
      const { embedding, ...rest } = m;
      const json = zstdCompressSync(Buffer.from(JSON.stringify(rest), 'utf8'), {
        params: { [constants.ZSTD_c_compressionLevel]: LEVEL },
      });
      const vec = embedding ?? new Int8Array(0);
      const frame = Buffer.alloc(1 + 4 + json.length + 4 + vec.byteLength + 4);
      frame[0] = V2;
      frame.writeUInt32BE(json.length, 1);
      json.copy(frame, 5);
      frame.writeUInt32BE(vec.byteLength, 5 + json.length);
      Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).copy(frame, 9 + json.length);
      const end = frame.length - 4;
      frame.writeUInt32BE(crc32(frame.subarray(0, end)), end);
      return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    },

    decode(b) {
      const frame = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
      if (frame.length === 0) throw new ColdBlobCorruptError('empty frame');
      if (frame[0] === V2) return decodeV2(frame);
      if (frame[0] === V1) return decodeV1(frame);
      throw new ColdBlobCorruptError(`unsupported frame version ${String(frame[0])}`);
    },
  };
}
