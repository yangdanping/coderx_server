export interface SuccessResult<T> {
  data: T;
  code: number;
}

export interface FailureResult<T = string> {
  msg: T;
  code: number;
}

export default class Result {
  static success(): SuccessResult<undefined>;
  static success<T>(data: T, code?: number): SuccessResult<T>;
  static success<T>(data?: T, code = 0): SuccessResult<T | undefined> {
    return { data, code };
  }

  static fail<T>(msg: T, code = -1): FailureResult<T> {
    return { msg, code };
  }
}
