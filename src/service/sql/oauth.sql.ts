const OAUTH_PROVIDER_COLUMN = {
  github: 'github_id',
  google: 'google_id',
};

export type OAuthProvider = keyof typeof OAUTH_PROVIDER_COLUMN;

function getOauthProviderColumn(provider: OAuthProvider) {
  const column = OAUTH_PROVIDER_COLUMN[provider];
  if (!column) {
    throw new Error(`Unsupported oauth provider: ${provider}`);
  }
  return column;
}

function getUserTable() {
  return '"user"';
}

export function buildFindUserByGoogleIdSql() {
  return `SELECT * FROM ${getUserTable()} WHERE google_id = ?;`;
}

export function buildFindUserByGitHubIdSql() {
  return `SELECT * FROM ${getUserTable()} WHERE github_id = ?;`;
}

export function buildFindUserByEmailSql() {
  return `
      SELECT u.*, p.email as "profileEmail"
      FROM ${getUserTable()} u
      LEFT JOIN profile p ON u.id = p.user_id
      WHERE p.email = ?;
    `;
}

export function buildCreateOAuthUserSql(provider: OAuthProvider) {
  const providerColumn = getOauthProviderColumn(provider);
  return `INSERT INTO ${getUserTable()} (name, password, ${providerColumn}, oauth_provider) VALUES (?, NULL, ?, ?) RETURNING id;`;
}

export function buildLinkOAuthAccountSql(provider: OAuthProvider) {
  const providerColumn = getOauthProviderColumn(provider);
  return `UPDATE ${getUserTable()} SET ${providerColumn} = ?, oauth_provider = ? WHERE id = ?;`;
}
