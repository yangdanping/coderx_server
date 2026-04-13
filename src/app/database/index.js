const client = require('./pg.client');

module.exports = Object.assign({}, client, {
  dialect: 'pg',
});
