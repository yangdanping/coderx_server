const OAUTH_PROVIDER_COLUMN = {
  github: 'github_id',
  google: 'google_id',
};

function getOauthProviderColumn(provider) {
  const column = OAUTH_PROVIDER_COLUMN[provider];
  if (!column) {
    throw new Error(`Unsupported oauth provider: ${provider}`);
  }
  return column;
}

function getUserTable() {
  return '"user"';
}

function buildFindUserByGoogleIdSql() {
  return `SELECT * FROM ${getUserTable()} WHERE google_id = ?;`;
}

function buildFindUserByGitHubIdSql() {
  return `SELECT * FROM ${getUserTable()} WHERE github_id = ?;`;
}

function buildFindUserByEmailSql() {
  return `
      SELECT u.*, p.email as "profileEmail"
      FROM ${getUserTable()} u
      LEFT JOIN profile p ON u.id = p.user_id
      WHERE p.email = ?;
    `;
}

function buildCreateOAuthUserSql(provider) {
  const providerColumn = getOauthProviderColumn(provider);
  return `INSERT INTO ${getUserTable()} (name, password, ${providerColumn}, oauth_provider) VALUES (?, NULL, ?, ?) RETURNING id;`;
}

function buildLinkOAuthAccountSql(provider) {
  const providerColumn = getOauthProviderColumn(provider);
  return `UPDATE ${getUserTable()} SET ${providerColumn} = ?, oauth_provider = ? WHERE id = ?;`;
}

module.exports = {
  buildCreateOAuthUserSql,
  buildFindUserByEmailSql,
  buildFindUserByGitHubIdSql,
  buildFindUserByGoogleIdSql,
  buildLinkOAuthAccountSql,
};
