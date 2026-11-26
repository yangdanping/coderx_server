/** A positive safe bigint can arrive as a decimal string from a borrowed pg client. */
export function readInsertedId(result: unknown): string | number {
  const id = typeof result === 'object' && result !== null && 'insertId' in result
    ? result.insertId
    : undefined;
  if ((typeof id !== 'number' && typeof id !== 'string') || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    throw new Error('PostgreSQL INSERT did not return a positive safe id');
  }
  return id;
}
