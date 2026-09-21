export const KIND_CONTROL = 0x4a;
export const KIND_FRAME = 0x46;

export const MessageKind = Object.freeze({
  CONTROL: 'control',
  FRAME: 'frame',
});

const HEADER_SIZE = 4;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

function readUint32(view, offset) {
  return view.getUint32(offset, false);
}

function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Decodifica el framing binario de idupi-server:
 *   u32be totalLen | u8 kind | body
 *   kind 0x4a -> body = JSON de control
 *   kind 0x46 -> body = u32be metaLen | JSON meta | JPEG
 */
export class ProtocolDecoder {
  #buffer = new Uint8Array(0);

  get pendingBytes() {
    return this.#buffer.byteLength;
  }

  push(chunk) {
    if (!chunk || chunk.byteLength === 0) return [];

    let data;
    if (this.#buffer.byteLength === 0) {
      data = chunk;
    } else {
      data = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
      data.set(this.#buffer, 0);
      data.set(chunk, this.#buffer.byteLength);
    }

    const messages = [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;

    while (offset + HEADER_SIZE + 1 <= data.byteLength) {
      const totalLen = readUint32(view, offset);
      const kind = data[offset + HEADER_SIZE];
      const end = offset + HEADER_SIZE + totalLen;
      const knownKind = kind === KIND_CONTROL || kind === KIND_FRAME;
      const valid = totalLen >= 1 && totalLen <= MAX_MESSAGE_BYTES && (knownKind || end <= data.byteLength);

      if (!valid) {
        offset += 1;
        continue;
      }

      if (end > data.byteLength) break;

      const body = data.subarray(offset + HEADER_SIZE + 1, end);

      if (kind === KIND_CONTROL) {
        const message = parseJson(body);
        if (message) messages.push({ kind: MessageKind.CONTROL, message });
      } else if (kind === KIND_FRAME) {
        const frame = this.#decodeFrame(body);
        if (frame) messages.push(frame);
      }

      offset = end;
    }

    this.#buffer = offset >= data.byteLength ? new Uint8Array(0) : data.slice(offset);
    return messages;
  }

  #decodeFrame(body) {
    if (body.byteLength < HEADER_SIZE) return null;

    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const metaEnd = HEADER_SIZE + view.getUint32(0, false);
    if (metaEnd > body.byteLength) return null;

    const meta = parseJson(body.subarray(HEADER_SIZE, metaEnd)) || {};
    return { kind: MessageKind.FRAME, meta, jpeg: body.slice(metaEnd) };
  }
}
