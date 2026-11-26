interface UrlConfiguration {
  PUBLIC_API_ORIGIN?: string;
  FRONTEND_URL?: string;
  APP_HOST?: string;
  APP_PORT?: string;
  ASSETS_PORT?: string;
  OLLAMA_HOST?: string;
  OLLAMA_PORT?: string;
}

export function buildUrls(config: UrlConfiguration) {
  return {
    baseURL: (config.PUBLIC_API_ORIGIN || `${config.APP_HOST}:${config.APP_PORT}`).replace(/\/+$/, ''),
    redirectURL: (config.FRONTEND_URL || `${config.APP_HOST}:${config.ASSETS_PORT}`).replace(/\/+$/, ''),
    ollamaBaseURL: `${config.OLLAMA_HOST}:${config.OLLAMA_PORT}/v1`,
  };
}
