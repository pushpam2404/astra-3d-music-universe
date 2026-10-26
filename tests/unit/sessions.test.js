import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodec } from '../../server/sessions.js';

const session = { accessToken: 'a', refreshToken: 'r', expiresAt: 123, scope: 'user-top-read' };

test('a session survives an encrypt and decrypt round trip', () => {
  const codec = createCodec('secret-one');
  assert.deepEqual(codec.decrypt(codec.encrypt(session)), session);
});

test('a cookie encrypted with another secret is rejected', () => {
  const token = createCodec('secret-one').encrypt(session);
  assert.equal(createCodec('secret-two').decrypt(token), null);
});

test('a tampered cookie is rejected', () => {
  const codec = createCodec('secret-one');
  const token = codec.encrypt(session);
  const flipped = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(codec.decrypt(flipped), null);
  assert.equal(codec.decrypt('not-a-cookie'), null);
  assert.equal(codec.decrypt(''), null);
});

test('with no secret there is no codec, so forged cookies cannot become sessions', () => {
  assert.equal(createCodec(''), null);
});
