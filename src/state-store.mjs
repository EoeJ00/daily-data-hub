import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const clone = (value) => structuredClone(value);

export class JsonStateStore {
  #file;
  #normalize;
  #defaultState;
  #recover;
  #statePromise;
  #mutationQueue = Promise.resolve();

  constructor(file, { defaultState, normalize = (value) => value, recover = false } = {}) {
    this.#file = file;
    this.#normalize = normalize;
    this.#defaultState = clone(defaultState ?? {});
    this.#recover = recover;
  }

  async #load() {
    if (!this.#statePromise) {
      this.#statePromise = readFile(this.#file, "utf8")
        .then((content) => this.#normalize(JSON.parse(content)))
        .catch((error) => {
          if (error.code === "ENOENT") return clone(this.#defaultState);
          if (this.#recover) return clone(this.#defaultState);
          this.#statePromise = null;
          throw error;
        });
    }
    return this.#statePromise;
  }

  async #persist(state) {
    const directory = dirname(this.#file);
    const temporary = join(directory, `.${basename(this.#file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporary, this.#file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async read() {
    await this.#mutationQueue;
    return clone(await this.#load());
  }

  mutate(mutator) {
    const operation = this.#mutationQueue.then(async () => {
      const draft = clone(await this.#load());
      const result = await mutator(draft);
      await this.#persist(draft);
      this.#statePromise = Promise.resolve(draft);
      return clone(result);
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
