async function purgePlaceholderArticles({ repository, apply = false }) {
  if (!repository || typeof repository.listPlaceholderArticles !== 'function' || typeof repository.deletePlaceholderArticles !== 'function') {
    throw new Error('placeholder cleanup repository is required');
  }
  const manifest = await repository.listPlaceholderArticles();
  if (!apply || manifest.length === 0) {
    return {
      matched: manifest.length,
      deleted: 0,
      manifest,
    };
  }

  const deleted = await repository.deletePlaceholderArticles(manifest.map((article) => article.articleId));
  return {
    matched: manifest.length,
    deleted: deleted.length,
    manifest: deleted,
  };
}

module.exports = {
  purgePlaceholderArticles,
};
