/**
 * 判断一个值是否为普通对象。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 归一化正整数 ID。
 */
export function normalizePositiveId(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

/**
 * 基于站点基础地址和资源路径拼接公开访问 URL。
 */
export function buildPublicAssetUrl(baseURL: unknown, assetPath: unknown): string {
  const normalizedBase = typeof baseURL === 'string' ? baseURL.trim().replace(/\/+$/, '') : '';
  const normalizedPath = typeof assetPath === 'string' && assetPath.startsWith('/') ? assetPath : `/${String(assetPath || '')}`;
  return normalizedBase ? `${normalizedBase}${normalizedPath}` : normalizedPath;
}

/**
 * 去掉域名、查询参数和 `/dev-api` 前缀，得到服务端公开资源路径。
 */
export function normalizePublicAssetPath(url: unknown): string {
  if (!url) return '';

  const normalizedUrl = String(url).split('?')[0]?.trim() ?? '';
  if (!normalizedUrl || normalizedUrl.startsWith('blob:') || normalizedUrl.startsWith('data:')) {
    return '';
  }

  try {
    const parsed = normalizedUrl.startsWith('/') ? new URL(normalizedUrl, 'http://local.test') : new URL(normalizedUrl);
    return parsed.pathname.replace(/^\/dev-api/, '');
  } catch {
    return normalizedUrl.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/dev-api/, '');
  }
}

/**
 * 当头像指向用户头像接口时，按当前用户 ID 重新生成公开头像地址。
 */
export function resolveAvatarUrl<T>(baseURL: unknown, userId: unknown, avatarUrl: T): string | T {
  const normalizedUserId = normalizePositiveId(userId);
  if (!normalizedUserId) {
    return avatarUrl;
  }

  const normalizedPath = normalizePublicAssetPath(avatarUrl);
  if (!/^\/user\/\d+\/avatar\/?$/.test(normalizedPath)) {
    return avatarUrl;
  }

  return buildPublicAssetUrl(baseURL, `/user/${normalizedUserId}/avatar`);
}

/**
 * 递归遍历对象或数组，原地更新 `avatarUrl` 后返回原始值。
 */
export function hydrateAvatarUrls<T>(value: T, baseURL: unknown): T {
  if (Array.isArray(value)) {
    value.forEach((item) => hydrateAvatarUrls(item, baseURL));
    return value;
  }

  if (!isPlainObject(value)) return value;

  if (Object.prototype.hasOwnProperty.call(value, 'avatarUrl')) {
    const record: Record<string, unknown> = value;
    record.avatarUrl = resolveAvatarUrl(baseURL, record.id ?? record.userId, record.avatarUrl);
  }

  Object.keys(value).forEach((key) => {
    hydrateAvatarUrls(value[key], baseURL);
  });

  return value;
}
