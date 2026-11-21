interface PaginationQuery {
  pageNum?: unknown;
  pageSize?: unknown;
  offset?: unknown;
  limit?: unknown;
}

export function readPaginationParams({ pageNum, pageSize, offset, limit }: PaginationQuery) {
  const page = Number(pageNum) || 1;
  const size = Number(pageSize) || (limit ? Number(limit) : 10);
  const explicitOffset = offset !== undefined && offset !== null;
  const parsedOffset = explicitOffset ? Number(offset) : (page - 1) * size;
  const parsedLimit = explicitOffset ? (limit ? Number(limit) : 10) : size;

  return {
    offset: String(Number.isNaN(parsedOffset) ? 0 : parsedOffset),
    limit: String(Number.isNaN(parsedLimit) ? 10 : parsedLimit),
  };
}
