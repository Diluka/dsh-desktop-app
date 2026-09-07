export function allocateLoopbackPort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const address = listener.addr as Deno.NetAddr;
    return Promise.resolve(address.port);
  } finally {
    listener.close();
  }
}

interface ProbeHttpOptions {
  readonly signal?: AbortSignal;
  readonly accept?: string;
  readonly validateStatus?: (status: number) => boolean;
}

export async function probeHttp(url: string, options: ProbeHttpOptions = {}): Promise<number> {
  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new DOMException("HTTP probe cancelled", "AbortError");
  };
  throwIfAborted();
  const timeout = AbortSignal.timeout(1_500);
  try {
    const response = await fetch(url, {
      method: "GET",
      ...(options.accept ? { headers: { accept: options.accept } } : {}),
      redirect: "manual",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    try {
      const validateStatus = options.validateStatus ?? successfulOrRedirectStatus;
      if (!validateStatus(response.status)) {
        throw new Error(`HTTP probe failed with status ${response.status}`);
      }
    } finally {
      await response.body?.cancel();
    }
    throwIfAborted();
    return response.status;
  } catch (error) {
    throwIfAborted();
    throw error;
  }
}

function successfulOrRedirectStatus(status: number): boolean {
  return status >= 200 && status < 400;
}
