// Shared by the legacy middleware and the isolated HTTP factory.
export default Object.freeze({
  chat: Object.freeze({ windowMs: 60 * 1000, maxRequests: 12 }),
  completion: Object.freeze({ windowMs: 60 * 1000, maxRequests: 30 }),
});
