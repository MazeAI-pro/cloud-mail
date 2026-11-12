import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createLocalD1 } from './helpers/local-d1';
import { dbInit } from '../src/init/init';
import managed from '../src/service/managed-mailbox-service';
import addressService, { isRetiredAddress, normalizeLocalPart } from '../src/service/mailbox-address-service';
import { email } from '../src/email/email';
const KEY = 'tada:dev:550e8400-e29b-41d4-a716-446655440000';
const OP = '00000000-0000-4000-8000-000000000001';
let runtime, c;
beforeAll(async () => {
  runtime = await createLocalD1();
  const store = new Map();
  c = { env: { db: runtime.db, domain: ['mytada.ai'], managed_mailbox_domain: 'mytada.ai', MAILBOX_ADDRESS_EDIT_ENABLED: 'true', jwt_secret: 'test', kv: { get: async (key, options) => options?.type === 'json' ? JSON.parse(store.get(key) || 'null') : store.get(key), put: async (key, value) => store.set(key, value) } }, req: { param: () => 'test', header: () => undefined }, text: value => value, set: (key, value) => store.set(key, value), get: key => store.get(key) };
  await dbInit.init(c);
});
afterAll(async () => { await runtime.dispose(); });
it('reads existing mailbox without migration and fails closed for edits', async () => {
  const box = await managed.ensureMailbox(c, { externalKey: KEY });
  expect(await addressService.profile(c, { externalKey: KEY })).toMatchObject({ address: box.address, canEditAddress: false });
  await expect(addressService.rename(c, { externalKey: KEY, expectedAddress: box.address, newLocalPart: 'helios', operationId: OP })).rejects.toMatchObject({ code: 503 });
  const migration = readFileSync(new URL('../migrations/0001_managed_address_changes.sql', import.meta.url), 'utf8');
  const statements = migration.match(/CREATE TRIGGER[\s\S]*?\nEND;|CREATE (?:TABLE|UNIQUE INDEX)[\s\S]*?;/g);
  await c.env.db.batch(statements.map(sql => c.env.db.prepare(sql)));
  expect(await addressService.profile(c, { externalKey: KEY })).toMatchObject({ canEditAddress: false, renameUsed: false });
  await expect(addressService.rename(c, { externalKey: KEY, expectedAddress: box.address, newLocalPart: 'helios', operationId: OP })).rejects.toMatchObject({ code: 503 });
  const legacyKey = KEY.replace(/00$/, '99');
  const legacy = await managed.ensureMailbox(c, { externalKey: legacyKey });
  for (const [id, old, target] of [['legacy1', legacy.address, 'legacy-first@mytada.ai'], ['legacy2', 'legacy-first@mytada.ai', 'legacy-second@mytada.ai']]) {
    await c.env.db.prepare('INSERT INTO managed_address_change(operation_id, external_key, expected_address, new_address) VALUES(?,?,?,?)').bind(id, legacyKey, old, target).run();
    await c.env.db.prepare('UPDATE managed_address_change SET finalized = 1 WHERE operation_id = ?').bind(id).run();
  }
  expect(await addressService.profile(c, { externalKey: legacyKey })).toMatchObject({ canEditAddress: false, renameUsed: true });
  const lifetime = readFileSync(new URL('../migrations/0002_managed_address_lifetime.sql', import.meta.url), 'utf8');
  const lifetimeStatements = lifetime.match(/CREATE TRIGGER[\s\S]*?\nEND;|CREATE TABLE[\s\S]*?;|INSERT OR IGNORE[\s\S]*?;/g);
  await c.env.db.batch(lifetimeStatements.map(sql => c.env.db.prepare(sql)));
  expect(await addressService.profile(c, { externalKey: KEY })).toMatchObject({ canEditAddress: true, renameUsed: false });
  expect(await addressService.profile(c, { externalKey: legacyKey })).toMatchObject({ canEditAddress: false, renameUsed: true });
  expect((await c.env.db.prepare('SELECT COUNT(*) AS count FROM managed_address_change WHERE external_key = ?').bind(legacyKey).first()).count).toBe(2);
  await expect(addressService.rename(c, { externalKey: legacyKey, expectedAddress: 'legacy-second@mytada.ai', newLocalPart: 'legacy-third', operationId: OP.replace(/1$/, '9') })).rejects.toMatchObject({ code: 409 });
});
it('atomically renames identity, preserves history, retries and permanently retires old address', async () => {
  const before = await managed.findByExternalKey(c, KEY);
  await c.env.db.prepare("INSERT INTO email(account_id,user_id,send_email,to_email,subject) VALUES(?,?,?,?,?)").bind(before.accountId, before.userId, before.address, 'recipient@test.com', 'History').run();
  const params = { externalKey: KEY, expectedAddress: before.address, newLocalPart: ' HeLios ', operationId: OP };
  const results = await Promise.all([addressService.rename(c, params), addressService.rename(c, params)]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0].address).toBe('helios@mytada.ai');
  const after = await managed.findByExternalKey(c, KEY);
  expect(after).toMatchObject({ accountId: before.accountId, userId: before.userId, displayName: 'helios' });
  expect((await c.env.db.prepare('SELECT email FROM user WHERE user_id = ?').bind(before.userId).first()).email).toBe('helios@mytada.ai');
  expect((await c.env.db.prepare('SELECT send_email FROM email').first()).send_email).toBe(before.address);
  expect(await isRetiredAddress(c, before.address)).toBe(true);
  await expect(c.env.db.prepare('INSERT INTO account(email, user_id) VALUES(?,?)').bind(before.address, before.userId).run()).rejects.toThrow('retired_address');
  await expect(c.env.db.prepare('UPDATE user SET email = ? WHERE user_id = ?').bind(before.address, before.userId).run()).rejects.toThrow('retired_address');
  let rejection;
  await email({ to: before.address, setReject: reason => { rejection = reason; } }, { ...c.env, MAILBOX_ADDRESS_EDIT_ENABLED: 'false' }, {});
  expect(rejection).toBe('Recipient address retired');
  await expect(addressService.rename(c, { ...params, expectedAddress: 'helios@mytada.ai', newLocalPart: 'another', operationId: OP.replace(/1$/, '2') })).rejects.toMatchObject({ code: 409 });
  expect((await addressService.profile(c, { externalKey: KEY })).pendingOperation.operationId).toBe(OP);
  await addressService.finalize(c, { externalKey: KEY, operationId: OP, address: 'helios@mytada.ai' });
  expect(await addressService.profile(c, { externalKey: KEY })).toMatchObject({ pendingOperation: null, renameUsed: true, canEditAddress: false });
  expect(await addressService.rename(c, params)).toMatchObject({ address: 'helios@mytada.ai', operationId: OP });
  await expect(addressService.rename(c, { ...params, expectedAddress: 'helios@mytada.ai', newLocalPart: 'another', operationId: OP.replace(/1$/, '2') })).rejects.toMatchObject({ code: 409 });
  await expect(addressService.rename(c, { ...params, newLocalPart: 'tampered' })).rejects.toMatchObject({ code: 409 });
});
it('rolls back collisions without losing old identity and preserves custom sender name', async () => {
  const key = KEY.replace(/0$/, '1');
  const box = await managed.ensureMailbox(c, { externalKey: key, displayName: 'Custom Name' });
  const params = { externalKey: key, expectedAddress: box.address, newLocalPart: 'helios', operationId: OP.replace(/1$/, '3') };
  await expect(addressService.rename(c, params)).rejects.toMatchObject({ code: 409 });
  expect((await managed.findByExternalKey(c, key)).address).toBe(box.address);
  expect(await isRetiredAddress(c, box.address)).toBe(false);
  expect(await addressService.profile(c, { externalKey: key })).toMatchObject({ renameUsed: false, canEditAddress: true });
  await addressService.rename(c, { ...params, newLocalPart: 'another' });
  expect((await managed.findByExternalKey(c, key)).displayName).toBe('Custom Name');
});
it.each(['ab', 'admin', 'x..y', '.abc', 'abc-', 'a'.repeat(33), '中文', 'u12345678', 'x\r\ny'])('rejects invalid or reserved prefix %j', value => {
  expect(() => normalizeLocalPart(value)).toThrow();
});

it('rejects differently cased no-op rename at API and SQL boundary', async () => {
  await expect(addressService.rename(c, { externalKey: KEY, expectedAddress: 'HELIOS@mytada.ai', newLocalPart: 'helios', operationId: OP.replace(/1$/, '7') })).rejects.toMatchObject({ code: 400 });
  const key = KEY.replace(/0$/, '7');
  const box = await managed.ensureMailbox(c, { externalKey: key });
  await expect(c.env.db.prepare('INSERT INTO managed_address_change(operation_id, external_key, expected_address, new_address) VALUES(?,?,?,?)').bind(OP.replace(/1$/, '7'), key, box.address.toUpperCase(), box.address).run()).rejects.toThrow('address_unchanged');
  expect(await addressService.profile(c, { externalKey: key })).toMatchObject({ renameUsed: false, canEditAddress: true });
  expect(await isRetiredAddress(c, 'helios@mytada.ai')).toBe(false);
});

it('allows exactly one winner for concurrent different operations and targets', async () => {
  const key = KEY.replace(/0$/, '2');
  const box = await managed.ensureMailbox(c, { externalKey: key });
  const requests = ['race-first', 'race-second'].map((newLocalPart, index) => ({ externalKey: key, expectedAddress: box.address, newLocalPart, operationId: OP.replace(/1$/, String(index + 4)) }));
  const results = await Promise.allSettled(requests.map(params => addressService.rename(c, params)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  const winner = results.findIndex(result => result.status === 'fulfilled');
  await addressService.finalize(c, { externalKey: key, operationId: requests[winner].operationId, address: results[winner].value.address });
  expect(await addressService.profile(c, { externalKey: key })).toMatchObject({ renameUsed: true, canEditAddress: false, pendingOperation: null });
  await expect(c.env.db.prepare('DELETE FROM managed_address_lifetime WHERE external_key = ?').bind(key).run()).rejects.toThrow('lifetime_claim_permanent');
});

it('disables writes but preserves reads and durable used state', async () => {
  const disabled = { ...c, env: { ...c.env, MAILBOX_ADDRESS_EDIT_ENABLED: 'false' } };
  expect(await addressService.profile(disabled, { externalKey: KEY })).toMatchObject({ renameUsed: true, canEditAddress: false });
  await expect(addressService.rename(disabled, { externalKey: KEY, expectedAddress: 'helios@mytada.ai', newLocalPart: 'blocked', operationId: OP })).rejects.toMatchObject({ code: 403 });
});

it('allows one operation when distinct requests race for the same target', async () => {
  const key = KEY.replace(/0$/, '8');
  const box = await managed.ensureMailbox(c, { externalKey: key });
  const results = await Promise.allSettled(['a', 'b'].map(suffix => addressService.rename(c, { externalKey: key, expectedAddress: box.address, newLocalPart: 'same-target', operationId: OP.replace(/1$/, suffix) })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(await addressService.profile(c, { externalKey: key })).toMatchObject({ renameUsed: true, canEditAddress: false });
});

it('fails closed if the lifetime enforcement trigger is missing', async () => {
  await c.env.db.prepare('DROP TRIGGER managed_address_lifetime_claim').run();
  expect(await addressService.profile(c, { externalKey: KEY })).toMatchObject({ renameUsed: true, canEditAddress: false });
  await expect(addressService.rename(c, { externalKey: KEY, expectedAddress: 'helios@mytada.ai', newLocalPart: 'blocked', operationId: OP })).rejects.toMatchObject({ code: 503 });
});
