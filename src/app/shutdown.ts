export function createShutdown(resources: Array<() => void | Promise<void>>, tasks: Iterable<{ stop(): void | Promise<void> }>, timeoutMs: number): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => result ??= shutdown(resources, tasks, timeoutMs);
}

export async function shutdown(resources: Array<() => void | Promise<void>>, tasks: Iterable<{ stop(): void | Promise<void> }>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        const stopped = await Promise.allSettled(Array.from(tasks, task => Promise.resolve().then(() => task.stop())));
        const stopErrors = stopped.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason);
        if (stopErrors.length) throw new AggregateError(stopErrors, 'Shutdown failed');
        const closed = await Promise.allSettled(resources.map(close => Promise.resolve().then(close)));
        const errors = closed.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason);
        if (errors.length) throw new AggregateError(errors, 'Shutdown failed');
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Shutdown timed out')), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
