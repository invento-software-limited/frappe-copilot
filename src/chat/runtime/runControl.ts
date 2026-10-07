/** Whether a run is in flight, and the user's stop button for it. */
export class RunControl {
  aborted = false;
  running = false;
  private controller: AbortController | null = null;

  /** Waits between stream retries — swapped out in tests. */
  sleep: (ms: number) => Promise<void> = ms => new Promise(res => setTimeout(res, ms));

  begin(): void {
    this.aborted = false;
    this.controller = new AbortController();
    this.running = true;
  }

  finish(): void {
    this.running = false;
  }

  abort(): void {
    this.aborted = true;
    this.controller?.abort();
    this.running = false;
  }

  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }
}
