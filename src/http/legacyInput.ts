import { readPaginationParams } from '../utils/pagination.js';

export function bodyFields(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
}

export function queryValue(search: URLSearchParams, key: string): string | string[] | undefined {
  const values = search.getAll(key);
  return values.length > 1 ? values : values[0];
}

export function pagination(search: URLSearchParams) {
  return readPaginationParams({
    pageNum: queryValue(search, 'pageNum'),
    pageSize: queryValue(search, 'pageSize'),
    offset: queryValue(search, 'offset'),
    limit: queryValue(search, 'limit'),
  });
}
