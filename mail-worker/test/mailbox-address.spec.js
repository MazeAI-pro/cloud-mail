import { beforeAll, afterAll, expect, it } from 'vitest';
import { createLocalD1 } from './helpers/local-d1';
import { dbInit } from '../src/init/init';
import managed from '../src/service/managed-mailbox-service';
import addressService, { normalizeLocalPart } from '../src/service/mailbox-address-service';
const KEY = 'tada:dev:550e8400-e29b-41d4-a716-446655440000';
let runtime, c;
beforeAll(async () => {
  runtime = await createLocalD1();
  const store = new Map();
  c = { env: { db: runtime.db, domain: ['mytada.ai'], managed_mailbox_domain: 'mytada.ai', jwt_secret: 'test', kv: { get: async (key, options) => options?.type === 'json' ? JSON.parse(store.get(key) || 'null') : store.get(key), put: async (key, value) => store.set(key, value) } }, req: { param: () => 'test', header: () => undefined }, text: value => value, set: (key, value) => store.set(key, value), get: key => store.get(key) };
  await dbInit.init(c);
});
afterAll(async () => { await runtime.dispose(); });
it('checks read-only without any additional migration', async () => {
  expect(await addressService.profile(c, { externalKey: KEY })).toEqual({ provisioned: false, address: null });
  const box = await managed.ensureMailbox(c, { externalKey: KEY });
  expect(await addressService.check(c, { externalKey: KEY, newLocalPart: 'helios' })).toEqual({ available: true, address: 'helios@mytada.ai' });
  expect((await addressService.profile(c, { externalKey: KEY })).address).toBe(box.address);
});
it('preserves mailbox IDs/history, retries same target and releases old binding', async () => {
  const before = await managed.findByExternalKey(c, KEY);
  await c.env.db.prepare('INSERT INTO email(account_id,user_id,send_email,to_email,subject) VALUES(?,?,?,?,?)').bind(before.accountId, before.userId, before.address, 'recipient@test.com', 'History').run();
  const params = { externalKey: KEY, expectedAddress: before.address, newLocalPart: ' HeLios ' };
  expect(await addressService.rename(c, params)).toEqual({ address: 'helios@mytada.ai' });
  expect(await addressService.rename(c, params)).toEqual({ address: 'helios@mytada.ai' });
  const after = await managed.findByExternalKey(c, KEY);
  expect(after.accountId).toBe(before.accountId);
  expect(after.userId).toBe(before.userId);
  expect((await c.env.db.prepare('SELECT email FROM user WHERE user_id = ?').bind(before.userId).first()).email).toBe(after.address);
  expect((await c.env.db.prepare('SELECT send_email FROM email WHERE account_id = ?').bind(before.accountId).first()).send_email).toBe(before.address);
  await expect(managed.resolveOwner(c, before.address)).rejects.toMatchObject({ code: 404 });
  expect((await addressService.check(c, { externalKey: KEY, newLocalPart: before.address.split('@')[0] })).available).toBe(true);
});
it('occupancy failure rolls back both rows; later valid request succeeds', async () => {
  const key = KEY.replace(/00$/, '01');
  const box = await managed.ensureMailbox(c, { externalKey: key });
  await expect(addressService.rename(c, { externalKey: key, expectedAddress: box.address, newLocalPart: 'helios' })).rejects.toMatchObject({ code: 409 });
  const row = await managed.findByExternalKey(c, key);
  expect(row.address).toBe(box.address);
  expect((await c.env.db.prepare('SELECT email FROM user WHERE user_id = ?').bind(row.userId).first()).email).toBe(box.address);
  expect(await addressService.rename(c, { externalKey: key, expectedAddress: box.address, newLocalPart: 'valid' })).toEqual({ address: 'valid@mytada.ai' });
});
it('only one concurrent old-address CAS wins', async () => {
  const key = KEY.replace(/00$/, '02');
  const box = await managed.ensureMailbox(c, { externalKey: key });
  const results = await Promise.allSettled(['winner-a', 'winner-b'].map(newLocalPart => addressService.rename(c, { externalKey: key, expectedAddress: box.address, newLocalPart })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const current = await managed.findByExternalKey(c, key);
  expect((await c.env.db.prepare('SELECT email FROM user WHERE user_id = ?').bind(current.userId).first()).email).toBe(current.address);
});
it('requires the owner identity and old address', async () => {
  await expect(addressService.rename(c, { externalKey: KEY, expectedAddress: 'someone@mytada.ai', newLocalPart: 'other' })).rejects.toMatchObject({ code: 409 });
  await expect(addressService.profile(c, { externalKey: KEY, ownerEmail: 'someone@mytada.ai' })).rejects.toMatchObject({ code: 400 });
});
it('accepts supported syntax without business reservations', () => {
  for (const name of ['abc', 'admin', 'u12345678', 'a'.repeat(36), '_a-']) expect(normalizeLocalPart(name)).toBe(name);
  for (const name of ['', 'a', 'ni', '.a', 'a.', 'a..b', 'a'.repeat(37), 'a+b', '中文']) expect(() => normalizeLocalPart(name)).toThrow();
});

it('rejects invalid lengths for new checks and renames', async () => {
  for (const newLocalPart of ['ni', 'a'.repeat(37)]) {
    const params = { externalKey: KEY, newLocalPart };
    await expect(addressService.check(c, params)).rejects.toMatchObject({ code: 400, message: '邮箱前缀需为 3–36 位' });
    await expect(addressService.rename(c, { ...params, expectedAddress: 'helios@mytada.ai' })).rejects.toMatchObject({ code: 400, message: '邮箱前缀需为 3–36 位' });
    expect((await addressService.profile(c, { externalKey: KEY })).address).toBe('helios@mytada.ai');
  }
});
it('keeps existing short addresses readable and resolvable for mail operations', async () => {
  const key = KEY.replace(/00$/, '03');
  const box = await managed.ensureMailbox(c, { externalKey: key });
  const before = await managed.findByExternalKey(c, key);
  // Seed a legacy address without passing through the new-address validation.
  await c.env.db.batch([
    c.env.db.prepare('UPDATE account SET email = ? WHERE email = ?').bind('ni@mytada.ai', box.address),
    c.env.db.prepare('UPDATE user SET email = ? WHERE email = ?').bind('ni@mytada.ai', box.address),
  ]);
  expect(await addressService.profile(c, { externalKey: key })).toEqual({ provisioned: true, address: 'ni@mytada.ai' });
  const owner = await managed.resolveOwner(c, 'ni@mytada.ai');
  expect(owner.accountId).toBe(before.accountId);
  expect(owner.userId).toBe(before.userId);
});
