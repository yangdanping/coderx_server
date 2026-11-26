import validator from 'validator';

export function isFlowRequestId(value: unknown): value is string {
  return typeof value === 'string' && validator.isUUID(value);
}
