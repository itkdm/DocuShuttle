import { AsyncLocalStorage } from "node:async_hooks";

import type { LogContext } from "../types";

const storage = new AsyncLocalStorage<LogContext>();

export const getLogContext = (): LogContext => storage.getStore() ?? {};

export const withLogContext = async <T>(context: LogContext, operation: () => Promise<T>): Promise<T> =>
  storage.run({ ...getLogContext(), ...context }, operation);

export const enrichLogContext = async <T>(context: LogContext, operation: () => Promise<T>): Promise<T> =>
  withLogContext(context, operation);
