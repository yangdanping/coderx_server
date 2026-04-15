function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePositiveId(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function buildPublicAssetUrl(baseURL, assetPath) {
  const normalizedBase = typeof baseURL === 'string' ? baseURL.trim().replace(/\/+$/, '') : '';
  const normalizedPath = typeof assetPath === 'string' && assetPath.startsWith('/') ? assetPath : `/${String(assetPath || '')}`;
  return normalizedBase ? `${normalizedBase}${normalizedPath}` : normalizedPath;
}

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

function hydrateAvatarUrls(value, baseURL) {
  if (Array.isArray(value)) {
    value.forEach((item) => hydrateAvatarUrls(item, baseURL));
    return value;
  }

  if (!isPlainObject(value)) {
    return value;
  }

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
