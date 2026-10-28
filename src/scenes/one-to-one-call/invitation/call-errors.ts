export interface CallErrorDetails {
  code?: number | string;
  message: string;
}

/** SDK wrappers may retain the original failure in cause. */
export function callErrorDetails(error: unknown): CallErrorDetails {
  let source = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!(source instanceof Error) || source.cause === undefined || source.cause === source) break;
    source = source.cause;
  }
  const value = source as { errorCode?: unknown; code?: unknown; message?: unknown } | null;
  const code = value?.errorCode ?? value?.code;
  return {
    ...(typeof code === 'number' || typeof code === 'string' ? { code } : {}),
    message: typeof value?.message === 'string' ? value.message : String(source),
  };
}
