const { config } = require('../app');
const baseURL = `${config.APP_HOST}:${config.APP_PORT}`;
const redirectURL = `${config.APP_HOST}:${config.ASSETS_PORT}`;

module.exports = {
  baseURL,
  redirectURL
};
