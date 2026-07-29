const TRACKING_PARAM_NAMES = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'source']);

function isTrackingParam(name) {
  const normalizedName = name.toLowerCase();
  return normalizedName.startsWith('utm_') || TRACKING_PARAM_NAMES.has(normalizedName);
}

function normalizePathname(pathname) {
  if (pathname === '/') return '';
  return pathname.replace(/\/+$/, '');
}

function normalizeCanonicalUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';

  try {
    const url = new URL(rawUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';

    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    url.pathname = normalizePathname(url.pathname);

    const keptParams = Array.from(url.searchParams.entries())
      .filter(([name]) => !isTrackingParam(name))
      .sort(([leftName, leftValue], [rightName, rightValue]) => {
        const nameOrder = leftName.localeCompare(rightName);
        return nameOrder || leftValue.localeCompare(rightValue);
      });

    url.search = '';
    keptParams.forEach(([name, value]) => url.searchParams.append(name, value));

    return url.toString();
  } catch {
    return '';
  }
}

module.exports = {
  normalizeCanonicalUrl,
};
