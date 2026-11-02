export class QueueFullError extends Error { constructor() { super("send queue is full"); this.name = "QueueFullError"; } }

type Job<T> = { run: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

export class SendQueue {
  private readonly jobs: Array<Job<unknown>> = [];
  private active = false;
  private draining = false;
  constructor(private readonly capacity: number) {}
  get size(): number { return this.jobs.length + (this.active ? 1 : 0); }
  enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.draining || this.size >= this.capacity) throw new QueueFullError();
    return new Promise<T>((resolve, reject) => { this.jobs.push({ run, resolve: resolve as (value: unknown) => void, reject }); void this.pump(); });
  }
  async drain(): Promise<void> {
    this.draining = true;
    while (this.active || this.jobs.length > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  stopAccepting(): void { this.draining = true; }
  private async pump(): Promise<void> {
    if (this.active) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.active = true;
    try { job.resolve(await job.run()); } catch (error) { job.reject(error); } finally { this.active = false; void this.pump(); }
  }
}
