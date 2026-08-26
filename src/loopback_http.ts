export function allocateLoopbackPort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const address = listener.addr as Deno.NetAddr;
    return Promise.resolve(address.port);
  } finally {
    listener.close();
  }
}

export async function probeHttp(url: string): Promise<void> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(1_500),
  });
  await response.body?.cancel();
}
