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

  async put(scenario, item, businessDate, result, revisions = null) {
    const now = new Date().toISOString();
    const cutoff = Date.now() - this.retentionMs;
    return this.store.mutate((state) => {
      state.entries ||= {};
      for (const [key, entry] of Object.entries(state.entries)) {
        if (Date.parse(entry.syncedAt) < cutoff) delete state.entries[key];
      }
      const entry = { scenario, itemId: item.id, businessDate, fingerprint: fingerprint(item), syncedAt: now, checkedAt: now, revisions, result };
      state.entries[snapshotKey(scenario, item.id, businessDate)] = entry;
      return entry;
    });
  }

  async touch(scenario, itemId, businessDate) {
    const key = snapshotKey(scenario, itemId, businessDate);
    return this.store.mutate((state) => {
      const entry = state.entries?.[key];
      if (entry) entry.checkedAt = new Date().toISOString();
      return entry || null;
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
  #revisionInFlight = new Map();
  #lastCycleAt = null;
  #lastError = null;

  constructor({ snapshots, stateStore, definitions, getSpreadsheetRevision, intervalMs = 120_000, startupDelayMs = 1_000, logger = console } = {}) {
    this.snapshots = snapshots;
    this.stateStore = stateStore;
    this.definitions = definitions;
    this.getSpreadsheetRevision = getSpreadsheetRevision;
    this.intervalMs = intervalMs;
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
    const historical = cached ? null : await this.#historicalResult(scenario, item.id, businessDate);
    try {
      const revisions = await this.#revisions(scenario, item);
      if (cached?.revisions && this.#sameRevisions(cached.revisions, revisions)) {
        const checked = await this.snapshots.touch(scenario, item.id, businessDate);
        return this.#decorate(cached.result, cached.syncedAt, checked?.checkedAt, "verified");
      }
      const entry = await this.refresh(scenario, item, businessDate, collect, { revisions });
      return this.#decorate(entry.result, entry.syncedAt, entry.checkedAt, cached || historical ? "refreshed" : "live-fallback");
    } catch (verificationError) {
      this.#report(verificationError);
      try {
        const entry = await this.refresh(scenario, item, businessDate, collect, { verify: false });
        return this.#decorate(entry.result, entry.syncedAt, entry.checkedAt, "live-fallback", "版本校验暂不可用，本次已直接读取实时数据");
      } catch (collectError) {
        const fallback = cached || historical;
        if (!fallback) throw collectError;
        this.#report(collectError);
        return this.#decorate(fallback.result, fallback.syncedAt, fallback.checkedAt, "stale-unverified", "实时校验与重新读取均失败，当前结果未经验证");
      }
    }
  }

  async refresh(scenario, item, businessDate, collect, { revisions, verify = true } = {}) {
    const key = snapshotKey(scenario, item.id, businessDate);
    if (!this.#inFlight.has(key)) {
      const request = Promise.resolve()
        .then(async () => {
          const before = revisions === undefined && verify ? await this.#revisions(scenario, item) : revisions || null;
          let result = await collect(item, businessDate);
          let finalRevisions = before;
          if (verify && before) {
            try {
              const after = await this.#revisions(scenario, item);
              if (this.#sameRevisions(before, after)) {
                finalRevisions = after;
              } else {
                result = await collect(item, businessDate);
                const final = await this.#revisions(scenario, item);
                finalRevisions = this.#sameRevisions(after, final) ? final : null;
              }
            } catch (error) {
              this.#report(error);
              finalRevisions = null;
            }
          }
          return this.snapshots.put(scenario, item, businessDate, result, finalRevisions);
        })
        .finally(() => this.#inFlight.delete(key));
      this.#inFlight.set(key, request);
    }
    return this.#inFlight.get(key);
  }

  async refreshAfterWrite(scenario, item, businessDate, collect) {
    await this.snapshots.invalidate(scenario, item.id, businessDate);
    void this.refresh(scenario, item, businessDate, collect).catch((error) => this.#report(error));
  }

  #decorate(result, syncedAt, checkedAt, mode, warning) {
    return { ...clone(result), snapshot: { mode, syncedAt, checkedAt: checkedAt || syncedAt, ...(warning ? { warning } : {}) } };
  }

  async #revisions(scenario, item) {
    const ids = [...new Set(this.definitions?.[scenario]?.spreadsheetIds?.(item) || [])].filter(Boolean).sort();
    if (!ids.length || !this.getSpreadsheetRevision) return null;
    const values = await Promise.all(ids.map(async (id) => [id, await this.#revision(id)]));
    return Object.fromEntries(values.map(([id, value]) => [id, String(value.version || value.modifiedTime || "")]));
  }

  #revision(spreadsheetId) {
    if (!this.#revisionInFlight.has(spreadsheetId)) {
      const request = Promise.resolve()
        .then(() => this.getSpreadsheetRevision(spreadsheetId))
        .finally(() => this.#revisionInFlight.delete(spreadsheetId));
      this.#revisionInFlight.set(spreadsheetId, request);
    }
    return this.#revisionInFlight.get(spreadsheetId);
  }

  #sameRevisions(left, right) {
    return Boolean(left && right) && JSON.stringify(left) === JSON.stringify(right);
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
          await this.preview(scenario, item, businessDate, definition.collect);
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
