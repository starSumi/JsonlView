export class CdpClient {
  #nextId = 0;
  #pending = new Map();
  #closed = false;

  constructor(url, createSocket = (socketUrl) => new WebSocket(socketUrl)) {
    this.socket = createSocket(url);
    this.socket.addEventListener('message', this.#onMessage);
    this.socket.addEventListener('close', this.#onClose);
    this.socket.addEventListener('error', this.#onError);
  }

  #onMessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  };

  #onClose = () => {
    this.#closed = true;
    this.#rejectPending(new Error('CDP WebSocket closed.'));
  };

  #onError = () => {
    this.#rejectPending(new Error('CDP WebSocket failed.'));
  };

  #rejectPending(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  get pendingRequestCount() {
    return this.#pending.size;
  }

  async open() {
    if (this.#closed || this.socket.readyState === WebSocket.CLOSED) {
      throw new Error('CDP WebSocket is closed.');
    }
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolveOpen, rejectOpen) => {
      const cleanup = () => {
        this.socket.removeEventListener('open', onOpen);
        this.socket.removeEventListener('error', onError);
        this.socket.removeEventListener('close', onClose);
      };
      const fail = (message) => {
        cleanup();
        rejectOpen(new Error(message));
      };
      const onOpen = () => {
        cleanup();
        resolveOpen();
      };
      const onError = () => fail('CDP WebSocket failed to open.');
      const onClose = () => fail('CDP WebSocket closed before opening.');
      this.socket.addEventListener('open', onOpen, { once: true });
      this.socket.addEventListener('error', onError, { once: true });
      this.socket.addEventListener('close', onClose, { once: true });
    });
  }

  send(method, params = {}) {
    if (this.#closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP WebSocket is not open.'));
    }
    const id = ++this.#nextId;
    return new Promise((resolveRequest, rejectRequest) => {
      this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#pending.delete(id);
        rejectRequest(error);
      }
    });
  }

  close() {
    if (!this.#closed) {
      this.#closed = true;
      this.#rejectPending(new Error('CDP client was closed.'));
    }
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

function settleWithin(promise, milliseconds) {
  let timeoutId;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timeoutId = setTimeout(resolve, milliseconds);
    }),
  ]).finally(() => clearTimeout(timeoutId));
}

export async function runCdpMeasurement({
  client,
  task,
  onTimeout,
  timeoutMs,
  timeoutMessage,
  cancelTimeoutMs = 1000,
}) {
  let timeoutId;
  let didTimeout = false;
  const deadline = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  const operation = Promise.resolve().then(task);

  try {
    return await Promise.race([operation, deadline]);
  } catch (error) {
    if (!didTimeout) throw error;
    try {
      await settleWithin(Promise.resolve().then(onTimeout), cancelTimeoutMs);
    } catch {
      // Closing the client in finally rejects any cancellation command still pending.
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    client.close();
  }
}

export async function findCdpTargetWithinDeadline({
  candidates,
  probe,
  matches,
  timeoutMs,
  timeoutMessage,
  now = () => performance.now(),
}) {
  const deadline = now() + timeoutMs;
  for (const candidate of candidates) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new Error(timeoutMessage);
    let result;
    try {
      result = await probe(candidate, remainingMs);
    } catch {
      if (now() >= deadline) throw new Error(timeoutMessage);
      continue;
    }
    if (now() >= deadline) throw new Error(timeoutMessage);
    if (matches(result)) return { candidate, result };
  }
  return undefined;
}
