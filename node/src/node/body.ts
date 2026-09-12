export const MAX_RESPONSE_BYTES = 65_536;

export interface BoundedBody {
  rawBody: string;
  bodyTruncated: boolean;
  /** Bytes examined within the bounded prefix-plus-sentinel protocol. */
  observedBodyBytes: number;
}

/** Reads no more than the retained prefix plus one sentinel byte from a response stream. */
export async function readBoundedBody(response: Response, signal?: AbortSignal): Promise<BoundedBody> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { rawBody: '', bodyTruncated: false, observedBodyBytes: 0 };

  const retained = new Uint8Array(MAX_RESPONSE_BYTES);
  let length = 0;
  let bodyTruncated = false;
  let observedBodyBytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => {
      // Cancellation is resource cleanup; the caller's abort reason remains authoritative.
    });
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });

  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) break;
      const remaining = MAX_RESPONSE_BYTES - length;
      // A large transport chunk need not be retained in full: once the prefix
      // is full, inspecting one further byte is sufficient to prove truncation.
      observedBodyBytes += Math.min(value.byteLength, remaining + 1);
      if (value.byteLength <= remaining) {
        retained.set(value, length);
        length += value.byteLength;
        continue;
      }
      if (remaining > 0) retained.set(value.subarray(0, remaining), length);
      length = MAX_RESPONSE_BYTES;
      bodyTruncated = true;
      await reader.cancel().catch(() => {
        // The bounded prefix is already known; cancellation is resource cleanup only.
      });
      break;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    try {
      reader.releaseLock();
    } catch {
      // An aborted pending read may settle after our caller-facing rejection.
    }
  }

  return {
    rawBody: new TextDecoder('utf-8', { fatal: false }).decode(retained.subarray(0, length)),
    bodyTruncated,
    observedBodyBytes,
  };
}

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

async function readWithSignal(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal | undefined): Promise<ReadResult> {
  if (signal === undefined) return reader.read();
  if (signal.aborted) throw signal.reason ?? createAbortError();
  return new Promise<ReadResult>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? createAbortError());
    signal.addEventListener('abort', abort, { once: true });
    void reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}
