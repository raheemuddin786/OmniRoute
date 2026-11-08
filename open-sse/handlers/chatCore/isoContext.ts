export interface IsoContext {
  getSessionLock(key: string): unknown;
  setSessionLock(key: string, value: unknown): void;
  deleteSessionLock(key: string): void;
}

export class IsoContextImpl implements IsoContext {
  private readonly store = new Map<string, unknown>();

  getSessionLock(key: string): unknown {
    return this.store.get(key);
  }

  setSessionLock(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  deleteSessionLock(key: string): void {
    this.store.delete(key);
  }
}

const isoContextInstance = new IsoContextImpl();

export const getIsoContext = (): IsoContext => isoContextInstance;

export function createIsoContextKey(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts].join(":");
}

export function runInIsoContext<T>(
  key: string,
  fn: (value: unknown) => T,
  options?: { createIfNotExists?: boolean }
): T {
  const context = getIsoContext();
  let value = context.getSessionLock(key);

  if (value === undefined && options?.createIfNotExists) {
    value = {};
    context.setSessionLock(key, value);
  }

  if (value === undefined) {
    throw new Error(`No value found in ISO context for key: ${key}`);
  }

  return fn(value);
}

export function setIsoContextValue(key: string, value: unknown): void {
  getIsoContext().setSessionLock(key, value);
}

export function getIsoContextValue<T>(key: string): T | undefined {
  return getIsoContext().getSessionLock(key) as T | undefined;
}
