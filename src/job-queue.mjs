function queueError(message) {
  return Object.assign(new Error(message), { status: 503 });
}

export class JobQueue {
  #accepting = true;
  #pending = [];
  #running = null;
  #idleWaiters = [];

  enqueue(task, meta = {}) {
    if (!this.#accepting) throw queueError("服务正在优雅重启，暂不接受新任务");
    const id = crypto.randomUUID();
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const position = this.#pending.length + (this.#running ? 2 : 1);
    this.#pending.push({ id, task, meta, resolve, reject });
    queueMicrotask(() => this.#drain());
    return { id, position, promise };
  }

  close() {
    this.#accepting = false;
    this.#resolveIdle();
  }

  snapshot() {
    return {
      accepting: this.#accepting,
      running: this.#running ? { id: this.#running.id, ...this.#running.meta } : null,
      queued: this.#pending.map((job) => ({ id: job.id, ...job.meta }))
    };
  }

  onIdle() {
    if (!this.#running && !this.#pending.length) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #drain() {
    if (this.#running) return;
    const job = this.#pending.shift();
    if (!job) return this.#resolveIdle();
    this.#running = job;
    try {
      job.resolve(await job.task());
    } catch (error) {
      job.reject(error);
    } finally {
      this.#running = null;
      queueMicrotask(() => this.#drain());
    }
  }

  #resolveIdle() {
    if (this.#running || this.#pending.length) return;
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
}
