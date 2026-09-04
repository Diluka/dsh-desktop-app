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
  readonly accept?: string;
  readonly validateStatus?: (status: number) => boolean;
}

export async function probeHttp(url: string, options: ProbeHttpOptions = {}): Promise<number> {
  const response = await fetch(url, {
    method: "GET",
    ...(options.accept ? { headers: { accept: options.accept } } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(1_500),
  });
  try {
    const status = response.status;
    const validateStatus = options.validateStatus ?? successfulOrRedirectStatus;
    if (!validateStatus(status)) {
      throw new Error(`HTTP probe failed with status ${status}`);
    }
    return status;
  } finally {
    await response.body?.cancel();
  }
}

function successfulOrRedirectStatus(status: number): boolean {
  return status >= 200 && status < 400;
}
