import { z } from 'zod';

export const structuredObject = z.custom<Record<string, unknown>>(value =>
  typeof value === 'object' && value !== null && !Array.isArray(value),
);

export function parseDraftInteger(value: unknown, minimum: 0 | 1): number | null {
  const decimal = minimum === 0 ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  const numeric = typeof value === 'string' && decimal.test(value) ? Number(value) : value;
  return typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric >= minimum ? numeric : null;
}
