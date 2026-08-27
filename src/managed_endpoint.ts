import type { HiddenProcessStatus, ManagedHiddenProcess } from "./hidden_process.ts";

export interface ManagedEndpointExit extends HiddenProcessStatus {
  readonly stopRequested: boolean;
}

export class ManagedEndpoint {
  readonly exited: Promise<ManagedEndpointExit>;
  #finished = false;
  #stopRequested = false;

  readonly outputFile: string;

  constructor(
    readonly url: string,
    private readonly child: ManagedHiddenProcess,
    private readonly delay: (milliseconds: number) => Promise<void>,
  ) {
    this.outputFile = child.outputFile;
    this.exited = (async () => {
      const status = await child.status;
      this.#finished = true;
      return {
        ...status,
        stopRequested: this.#stopRequested,
      };
    })();
  }

  async stop(): Promise<void> {
    if (this.#finished) return;
    this.#stopRequested = true;
    try {
      this.child.kill("SIGTERM");
    } catch {
      return;
    }

    await Promise.race([this.exited.then(() => undefined), this.delay(2_000)]);
    if (this.#finished) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
      // The process may have exited between the status check and kill.
    }
    await this.exited.catch(() => undefined);
  }
}
