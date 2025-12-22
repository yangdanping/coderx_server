const { config } = require('../app');
const baseURL = `${config.APP_HOST}:${config.APP_PORT}`;
const redirectURL = `${config.APP_HOST}:${config.ASSETS_PORT}`;
const ollamaBaseURL = `${config.OLLAMA_HOST}:${config.OLLAMA_PORT}/v1`;

module.exports = {
  baseURL,
  redirectURL,
  ollamaBaseURL,
};
