export {};

declare global {
  interface VsCodeApi<State = unknown> {
    postMessage(message: unknown): void;
    getState(): State | undefined;
    setState(state: State): State;
  }

  function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>;
}

