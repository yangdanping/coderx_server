function requiredName(value, fieldName) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new Error(`${fieldName} is required`);
  return name;
}

async function publishCandidates({ repository, authorName, tagName, limit = 10 }) {
  return await repository.publishApproved({
    authorName: requiredName(authorName, 'authorName'),
    tagName: requiredName(tagName, 'tagName'),
    limit,
  });
}

module.exports = {
  publishCandidates,
};
