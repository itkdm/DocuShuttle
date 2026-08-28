export type RequestLoader<Value> = () => Promise<Value>;

/**
 * Shares only requests that are currently pending. Settled requests are not
 * retained, so a later consumer always reads fresh data from the server.
 */
export function createInFlightRequestCache<Key, Value>() {
  const requests = new Map<Key, Promise<Value>>();

  const load = (key: Key, loader: RequestLoader<Value>) => {
    const existing = requests.get(key);
    if (existing) return existing;

    const request = Promise.resolve().then(loader);
    requests.set(key, request);
    void request.then(
      () => { if (requests.get(key) === request) requests.delete(key); },
      () => { if (requests.get(key) === request) requests.delete(key); },
    );
    return request;
  };

  return { load };
}
