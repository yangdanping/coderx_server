const test = require('node:test');
const assert = require('node:assert/strict');

const { createPresenceRegistry } = require('../../src/socket/presenceRegistry');

test('presenceRegistry: 同一用户第二个连接断开后仍在线', () => {
  const p = createPresenceRegistry();
  p.addConnection({ userId: '1', socketId: 's1', userName: 'alice', avatarUrl: '' });
  assert.equal(p.size(), 1);

  p.addConnection({ userId: '1', socketId: 's2', userName: 'alice', avatarUrl: '' });
  assert.equal(p.size(), 1);
  assert.equal(p.serializeUserList().length, 1);

  p.removeConnection({ userId: '1', socketId: 's1' });
  assert.equal(p.size(), 1);
  const still = p.serializeUserList();
  assert.equal(still.length, 1);
  assert.equal(still[0].status, 'online');

  p.removeConnection({ userId: '1', socketId: 's2' });
  assert.equal(p.size(), 0);
  assert.equal(p.serializeUserList().length, 0);
});

test('presenceRegistry: 多用户互不影响', () => {
  const p = createPresenceRegistry();
  p.addConnection({ userId: '1', socketId: 'a', userName: 'u1', avatarUrl: '' });
  p.addConnection({ userId: '2', socketId: 'b', userName: 'u2', avatarUrl: '' });
  assert.equal(p.size(), 2);

  p.removeConnection({ userId: '1', socketId: 'a' });
  assert.equal(p.size(), 1);
  assert.deepEqual(
    p.serializeUserList().map((u) => u.userId),
    ['2'],
  );
});

test('presenceRegistry: removeConnection 对未知用户安全', () => {
  const p = createPresenceRegistry();
  const r = p.removeConnection({ userId: '9', socketId: 'x' });
  assert.equal(r.hadEntry, false);
  assert.equal(r.removedUser, false);
  assert.equal(r.userConnectionCount, 0);
});

test('presenceRegistry: addConnection 返回 isFirstSocket 与 userConnectionCount', () => {
  const p = createPresenceRegistry();
  const r1 = p.addConnection({ userId: '1', socketId: 's1', userName: 'alice' });
  assert.equal(r1.isFirstSocket, true);
  assert.equal(r1.userConnectionCount, 1);

  const r2 = p.addConnection({ userId: '1', socketId: 's2', userName: 'alice' });
  assert.equal(r2.isFirstSocket, false);
  assert.equal(r2.userConnectionCount, 2);
});

test('presenceRegistry: totalConnections 汇总所有用户的 socket 数', () => {
  const p = createPresenceRegistry();
  assert.equal(p.totalConnections(), 0);

  p.addConnection({ userId: '1', socketId: 's1', userName: 'u1' });
  p.addConnection({ userId: '1', socketId: 's2', userName: 'u1' });
  p.addConnection({ userId: '2', socketId: 's3', userName: 'u2' });
  assert.equal(p.totalConnections(), 3);

  p.removeConnection({ userId: '1', socketId: 's1' });
  assert.equal(p.totalConnections(), 2);
});
