/** Tracks active asynchronous work by its owning source, independent of flight-key encoding. */
export class SourceControllerRegistry {
  readonly #bySource = new Map<string, Set<AbortController>>();

  public add(sourceId: string, controller: AbortController): void {
    let controllers = this.#bySource.get(sourceId);
    if (controllers === undefined) {
      controllers = new Set();
      this.#bySource.set(sourceId, controllers);
    }
    controllers.add(controller);
  }

  public delete(sourceId: string, controller: AbortController): void {
    const controllers = this.#bySource.get(sourceId);
    controllers?.delete(controller);
    if (controllers?.size === 0) this.#bySource.delete(sourceId);
  }

  public abortSource(sourceId: string): void {
    for (const controller of this.#bySource.get(sourceId) ?? []) controller.abort();
  }

  public abortAll(): void {
    for (const controllers of this.#bySource.values()) {
      for (const controller of controllers) controller.abort();
    }
  }

  public sourceIds(): readonly string[] {
    return [...this.#bySource.keys()];
  }
}
