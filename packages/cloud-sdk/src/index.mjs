export class EngramError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = 'EngramError';
    this.code = code;
    this.status = status;
  }
}
export function endpointURL(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new EngramError('invalid_endpoint');
  return url.origin;
}
export class EngramCloud {
  #key;
  #fetch;
  #endpoint;
  #timeout;
  #retries;
  constructor({
    endpoint,
    key,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 30000,
    retries = 2,
  }) {
    this.#endpoint = endpointURL(endpoint);
    if (typeof key !== 'string' || !/^egc_[A-Za-z0-9_-]{43}$/.test(key))
      throw new EngramError('invalid_context_key');
    if (
      !Number.isSafeInteger(retries) ||
      retries < 0 ||
      retries > 5 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120000
    )
      throw new EngramError('invalid_client_options');
    this.#key = key;
    this.#fetch = fetchImpl;
    this.#timeout = timeoutMs;
    this.#retries = retries;
  }
  async #request(path, method, input, signal) {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new EngramError('request_aborted');
      let retry = false;
      try {
        const timeout = AbortSignal.timeout(this.#timeout);
        const response = await this.#fetch(this.#endpoint + path, {
          method,
          redirect: 'error',
          headers: { authorization: 'Bearer ' + this.#key, 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        let data;
        try {
          data = await response.json();
        } catch {
          throw new EngramError('invalid_response', response.status);
        }
        if (response.ok) return data;
        retry = [429, 502, 503, 504].includes(response.status);
        const code =
          typeof data.error === 'string' && /^[a-z_]{1,80}$/.test(data.error)
            ? data.error
            : 'request_failed';
        if (!retry || attempt >= this.#retries) throw new EngramError(code, response.status);
      } catch (error) {
        if (error instanceof EngramError) throw error;
        if (signal?.aborted) throw new EngramError('request_aborted');
        if (attempt >= this.#retries) throw new EngramError('connection_failed');
        retry = true;
      }
      if (retry)
        await new Promise((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new EngramError('request_aborted'));
          };
          const timer = setTimeout(
            () => {
              signal?.removeEventListener('abort', abort);
              resolve();
            },
            Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250,
          );
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
    }
  }
  remember(record, { signal } = {}) {
    return this.#request('/v1/records', 'POST', record, signal);
  }
  recall(query, { limit = 8, signal } = {}) {
    return this.#request('/v1/search', 'POST', { query, limit }, signal);
  }
  forget(externalId, { signal } = {}) {
    return this.#request('/v1/records', 'DELETE', { externalId }, signal);
  }
}
