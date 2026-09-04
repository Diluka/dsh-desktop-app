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
  const status = await probeHtmlStatus(url);
  if (status < 200 || status >= 400) {
    throw new Error(`HTTP probe failed with status ${status}`);
  }
}

export async function probeHtmlStatus(url: string): Promise<number> {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "text/html" },
    redirect: "manual",
    signal: AbortSignal.timeout(1_500),
  });
  try {
    return response.status;
  } finally {
    await response.body?.cancel();
  }
}
