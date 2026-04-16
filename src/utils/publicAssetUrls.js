/**
 * 判断一个值是否为普通对象。
 *
 * @param {unknown} value 待判断的值。
 * @returns {boolean} 是否为非数组的对象。
 */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 归一化正整数 ID。
 *
 * @param {unknown} value 待归一化的 ID。
 * @returns {number|null} 合法正整数返回数字，否则返回 null。
 */
function normalizePositiveId(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

/**
 * 基于站点基础地址和资源路径拼接公开访问 URL。
 *
 * @param {string} baseURL 站点基础地址。
 * @param {string} assetPath 资源路径。
 * @returns {string} 可直接返回给前端的资源 URL。
 */
function buildPublicAssetUrl(baseURL, assetPath) {
  const normalizedBase = typeof baseURL === 'string' ? baseURL.trim().replace(/\/+$/, '') : '';
  const normalizedPath = typeof assetPath === 'string' && assetPath.startsWith('/') ? assetPath : `/${String(assetPath || '')}`;
  return normalizedBase ? `${normalizedBase}${normalizedPath}` : normalizedPath;
}

/**
 * 将资源 URL 归一化为服务端公开资源路径。
 *
 * @param {unknown} url 原始 URL 或路径。
 * @returns {string} 去掉域名、查询参数和 `/dev-api` 前缀后的路径。
 */
function normalizePublicAssetPath(url) {
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
 *
 * @param {string} baseURL 站点基础地址。
 * @param {unknown} userId 当前对象关联的用户 ID。
 * @param {unknown} avatarUrl 原始头像地址。
 * @returns {unknown} 重写后的头像地址，或保留原始值。
 */
function resolveAvatarUrl(baseURL, userId, avatarUrl) {
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
 * 递归遍历对象/数组，为其中的 `avatarUrl` 字段补全当前环境可访问的公开地址。
 *
 * @param {unknown} value 需要处理的对象、数组或其他值。
 * @param {string} baseURL 站点基础地址。
 * @returns {unknown} 原地更新后的原始值。
 */
function hydrateAvatarUrls(value, baseURL) {
  if (Array.isArray(value)) {
    value.forEach((item) => hydrateAvatarUrls(item, baseURL));
    return value;
  }

  if (!isPlainObject(value)) return value;

  if (Object.prototype.hasOwnProperty.call(value, 'avatarUrl')) {
    value.avatarUrl = resolveAvatarUrl(baseURL, value.id ?? value.userId, value.avatarUrl);
  }

  Object.keys(value).forEach((key) => {
    hydrateAvatarUrls(value[key], baseURL);
  });

  return value;
}

module.exports = {
  buildPublicAssetUrl,
  hydrateAvatarUrls,
  normalizePositiveId,
  normalizePublicAssetPath,
  resolveAvatarUrl,
};
