import { createHash } from "node:crypto";

const snapshotKey = (scenario, itemId, businessDate) => `${scenario}\u0000${itemId}\u0000${businessDate}`;
const fingerprint = (item) => createHash("sha256").update(JSON.stringify(item)).digest("base64url").slice(0, 20);
const clone = (value) => structuredClone(value);

export class MaterializedSnapshotStore {
  constructor(store, { retentionMs = 7 * 86_400_000 } = {}) {
    this.store = store;
    this.retentionMs = retentionMs;
  }

  async get(scenario, item, businessDate) {
    const state = await this.store.read();
    const entry = state.entries?.[snapshotKey(scenario, item.id, businessDate)];
    return entry?.fingerprint === fingerprint(item) ? clone(entry) : null;
  }

  async put(scenario, item, businessDate, result) {
    const now = new Date().toISOString();
    const cutoff = Date.now() - this.retentionMs;
    return this.store.mutate((state) => {
      state.entries ||= {};
      for (const [key, entry] of Object.entries(state.entries)) {
        if (Date.parse(entry.syncedAt) < cutoff) delete state.entries[key];
      }
      const entry = { scenario, itemId: item.id, businessDate, fingerprint: fingerprint(item), syncedAt: now, result };
      state.entries[snapshotKey(scenario, item.id, businessDate)] = entry;
      return entry;
    });
  }

  async invalidate(scenario, itemId, businessDate) {
    return this.store.mutate((state) => {
      state.entries ||= {};
      const prefix = `${scenario}\u0000${itemId}\u0000`;
      for (const key of Object.keys(state.entries)) {
        if (key.startsWith(prefix) && (!businessDate || key === snapshotKey(scenario, itemId, businessDate))) delete state.entries[key];
      }
    });
  }
}

export class SnapshotSynchronizer {
  #timer;
  #cycle;
  #stopped = true;
  #inFlight = new Map();
  #lastCycleAt = null;
  #lastError = null;

  constructor({ snapshots, stateStore, definitions, intervalMs = 120_000, staleMs = 120_000, startupDelayMs = 1_000, logger = console } = {}) {
    this.snapshots = snapshots;
    this.stateStore = stateStore;
    this.definitions = definitions;
    this.intervalMs = intervalMs;
    this.staleMs = staleMs;
    this.startupDelayMs = startupDelayMs;
    this.logger = logger;
  }

  status() {
    return { running: !this.#stopped, syncing: Boolean(this.#cycle), pending: this.#inFlight.size, lastCycleAt: this.#lastCycleAt, lastError: this.#lastError };
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(this.startupDelayMs);
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await Promise.allSettled([this.#cycle, ...this.#inFlight.values()].filter(Boolean));
  }

  wake() {
    if (this.#stopped || this.#cycle) return;
    clearTimeout(this.#timer);
    this.#schedule(0);
  }

  async preview(scenario, item, businessDate, collect) {
    const cached = await this.snapshots.get(scenario, item, businessDate);
    if (cached) {
      const stale = Date.now() - Date.parse(cached.syncedAt) > this.staleMs;
      if (stale) void this.refresh(scenario, item, businessDate, collect).catch((error) => this.#report(error));
      return this.#decorate(cached.result, cached.syncedAt, stale ? "stale" : "materialized");
    }
    const historical = await this.#historicalResult(scenario, item.id, businessDate);
    if (historical) {
      void this.refresh(scenario, item, businessDate, collect).catch((error) => this.#report(error));
      return this.#decorate(historical.result, historical.syncedAt, "historical");
    }
    const entry = await this.refresh(scenario, item, businessDate, collect);
    return this.#decorate(entry.result, entry.syncedAt, "live-fallback");
  }

  async refresh(scenario, item, businessDate, collect) {
    const key = snapshotKey(scenario, item.id, businessDate);
    if (!this.#inFlight.has(key)) {
      const request = Promise.resolve()
        .then(() => collect(item, businessDate))
        .then((result) => this.snapshots.put(scenario, item, businessDate, result))
        .finally(() => this.#inFlight.delete(key));
      this.#inFlight.set(key, request);
    }
    return this.#inFlight.get(key);
  }

  async refreshAfterWrite(scenario, item, businessDate, collect) {
    await this.snapshots.invalidate(scenario, item.id, businessDate);
    void this.refresh(scenario, item, businessDate, collect).catch((error) => this.#report(error));
  }

  #decorate(result, syncedAt, mode) {
    return { ...clone(result), snapshot: { mode, syncedAt } };
  }

  async #historicalResult(scenario, itemId, businessDate) {
    if (!this.stateStore) return null;
    const state = await this.stateStore.read();
    const runs = state.scenarios?.[scenario]?.runs || [];
    for (const run of runs) {
      if (run.type !== "preview" || run.businessDate !== businessDate) continue;
      const result = (run.results || []).find((item) => (item.pairId || item.sourceId) === itemId && item.status === "success");
      if (result) return { result, syncedAt: run.createdAt };
    }
    return null;
  }

  #schedule(delay) {
    this.#timer = setTimeout(() => {
      this.#cycle = this.#syncDefaultDate()
        .catch((error) => this.#report(error))
        .finally(() => {
          this.#cycle = null;
          if (!this.#stopped) this.#schedule(this.intervalMs);
        });
    }, delay);
    this.#timer.unref?.();
  }

  async #syncDefaultDate() {
    const businessDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const state = await this.stateStore.read();
    for (const [scenario, definition] of Object.entries(this.definitions)) {
      const items = state.scenarios?.[scenario]?.[definition.collection] || [];
      for (const item of items.filter((candidate) => candidate.enabled)) {
        if (this.#stopped) return;
        try {
          await this.refresh(scenario, item, businessDate, definition.collect);
        } catch (error) {
          this.#report(error);
        }
      }
    }
    this.#lastCycleAt = new Date().toISOString();
  }

  #report(error) {
    this.#lastError = error?.message || String(error);
    this.logger.warn?.(`后台快照同步失败：${this.#lastError}`);
  }
}
