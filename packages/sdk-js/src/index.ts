export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface RpaClient {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  get(name: string): Promise<unknown>;
  set(name: string, value: unknown): Promise<unknown>;
  output(value: unknown): Promise<void>;
}

/** Reject values that would silently lose data when sent across the process boundary. */
export function assertJson(value: unknown, ancestors = new Set<unknown>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('RPC values must be JSON-compatible');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('RPC values must contain only JSON objects and arrays');
  }
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) assertJson(item, ancestors);
  ancestors.delete(value);
}

export function createRpaClient(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  output: (value: unknown) => void,
): RpaClient {
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    if (typeof method !== 'string' || !method) throw new TypeError('RPC method must be a non-empty string');
    assertJson(params);
    return request(method, params);
  };
  return {
    call,
    get: (name) => call('variables.get', { name }),
    set: (name, value) => call('variables.set', { name, value }),
    output: async (value) => { assertJson(value); output(value); },
  };
}
