export async function checkReadiness(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(check).then(value => value === true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
