export const MAX_RESPONSE_BYTES = 65_536;

export interface BoundedBody {
  rawBody: string;
  bodyTruncated: boolean;
}

/** Reads no more than the retained prefix plus one sentinel byte from a response stream. */
export async function readBoundedBody(response: Response): Promise<BoundedBody> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { rawBody: '', bodyTruncated: false };

  const retained = new Uint8Array(MAX_RESPONSE_BYTES);
  let length = 0;
  let bodyTruncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_RESPONSE_BYTES - length;
      if (value.byteLength <= remaining) {
        retained.set(value, length);
        length += value.byteLength;
        continue;
      }
      if (remaining > 0) retained.set(value.subarray(0, remaining), length);
      length = MAX_RESPONSE_BYTES;
      bodyTruncated = true;
      try {
        await reader.cancel();
      } catch {
        // The bounded prefix is already known; cancellation is resource cleanup only.
      }
      break;
    }
  } finally {
    reader.releaseLock();
  }

  return {
    rawBody: new TextDecoder('utf-8', { fatal: false }).decode(retained.subarray(0, length)),
    bodyTruncated,
  };
}
