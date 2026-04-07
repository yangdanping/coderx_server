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

function getUserTable(dialect) {
  return dialect === 'pg' ? '"user"' : 'user';
}

function buildFindUserByGoogleIdSql(dialect) {
  return `SELECT * FROM ${getUserTable(dialect)} WHERE google_id = ?;`;
}

function buildFindUserByGitHubIdSql(dialect) {
  return `SELECT * FROM ${getUserTable(dialect)} WHERE github_id = ?;`;
}

function buildFindUserByEmailSql(dialect) {
  const q = (name) => (dialect === 'pg' ? `"${name}"` : name);
  return `
      SELECT u.*, p.email as ${q('profileEmail')}
      FROM ${getUserTable(dialect)} u
      LEFT JOIN profile p ON u.id = p.user_id
      WHERE p.email = ?;
    `;
}

function buildCreateOAuthUserSql(dialect, provider) {
  const providerColumn = getOauthProviderColumn(provider);
  const insertSuffix = dialect === 'pg' ? ' RETURNING id' : '';
  return `INSERT INTO ${getUserTable(dialect)} (name, password, ${providerColumn}, oauth_provider) VALUES (?, NULL, ?, ?)${insertSuffix};`;
}

function buildLinkOAuthAccountSql(dialect, provider) {
  const providerColumn = getOauthProviderColumn(provider);
  return `UPDATE ${getUserTable(dialect)} SET ${providerColumn} = ?, oauth_provider = ? WHERE id = ?;`;
}

module.exports = {
  buildCreateOAuthUserSql,
  buildFindUserByEmailSql,
  buildFindUserByGitHubIdSql,
  buildFindUserByGoogleIdSql,
  buildLinkOAuthAccountSql,
};
