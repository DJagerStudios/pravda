// Encrypts and decrypts call media frame by frame, inside a worker so the
// cryptography never stalls the interface. Frames are sealed with AES-256-GCM
// before they leave the browser; the media server forwards them without being
// able to read them.
//
// Frame layout: [header][ciphertext][12-byte IV][1-byte key index]
// The first few bytes of each frame stay readable because the receiving
// browser needs them to reassemble video (VP8 marks keyframes there); they
// are still authenticated as additional data.

const keys = new Map(); // index -> CryptoKey
let current = -1;

const VP8_KEY_HEADER = 10;
const VP8_DELTA_HEADER = 3;
const OPUS_HEADER = 1;
const TRAILER = 13;

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'key') {
    const key = await crypto.subtle.importKey('raw', msg.raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keys.set(msg.index, key);
    if (msg.current) current = msg.index;
    // Keep only a few generations: old ones are useless once everyone moved on.
    if (keys.size > 4) {
      const oldest = [...keys.keys()].find((k) => k !== current);
      keys.delete(oldest);
    }
  } else if (msg.type === 'stream') {
    pipe(msg.readable, msg.writable, msg.mode, msg.kind);
  }
};

// Browsers with RTCRtpScriptTransform deliver streams this way.
self.onrtctransform = (event) => {
  const { readable, writable, options } = event.transformer;
  pipe(readable, writable, options.mode, options.kind);
};

function headerLength(frame, kind) {
  if (kind === 'audio') return OPUS_HEADER;
  return frame.type === 'key' ? VP8_KEY_HEADER : VP8_DELTA_HEADER;
}

function pipe(readable, writable, mode, kind) {
  const transform = mode === 'encrypt' ? encryptFrame : decryptFrame;
  readable
    .pipeThrough(new TransformStream({ transform: (frame, controller) => transform(frame, controller, kind) }))
    .pipeTo(writable)
    .catch(() => {});
}

async function encryptFrame(frame, controller, kind) {
  const key = keys.get(current);
  if (!key) return; // never send media unencrypted: drop until the key arrives
  const data = new Uint8Array(frame.data);
  const n = Math.min(headerLength(frame, kind), data.length);
  const header = data.subarray(0, n);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, data.subarray(n)));
  const out = new Uint8Array(n + ct.length + TRAILER);
  out.set(header, 0);
  out.set(ct, n);
  out.set(iv, n + ct.length);
  out[out.length - 1] = current;
  frame.data = out.buffer;
  controller.enqueue(frame);
}

async function decryptFrame(frame, controller, kind) {
  const data = new Uint8Array(frame.data);
  if (data.length < TRAILER + 1) return;
  const key = keys.get(data[data.length - 1]);
  if (!key) return;
  const n = Math.min(headerLength(frame, kind), data.length - TRAILER);
  const header = data.subarray(0, n);
  const iv = data.subarray(data.length - TRAILER, data.length - 1);
  try {
    const pt = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: header },
      key,
      data.subarray(n, data.length - TRAILER),
    ));
    const out = new Uint8Array(n + pt.length);
    out.set(header, 0);
    out.set(pt, n);
    frame.data = out.buffer;
    controller.enqueue(frame);
  } catch {
    // A frame that fails authentication is dropped, never shown.
  }
}
