import * as types from '../constants/errorTypes.js';
const statuses: Record<string, number> = {
  [types.NAME_OR_PWD_IS_INCORRECT]: 400, [types.PWD_IS_INCORRECT]: 400,
  [types.UNAUTH]: 401, [types.USERNAME_EXISTS]: 409, [types.NAME_EXISTS]: 409,
  [types.USER_DOES_NOT_EXISTS]: 404, [types.UNPERMISSION]: 403,
  [types.INTERNAL_SERVER_ERROR]: 500, [types.DATABASE_ERROR]: 500,
  [types.SERVICE_UNAVAILABLE]: 503,
};
/** Explicit adapter for legacy app.emit('error'); ordinary thrown errors follow error middleware instead. */
export class LegacyEmittedError extends Error {
  readonly httpStatus: number;
  constructor(message: string) {
    const status = Object.hasOwn(statuses, message) ? statuses[message] : 500;
    super(Object.hasOwn(statuses, message) ? message : 'Internal Server Error');
    this.httpStatus = status;
  }
}
