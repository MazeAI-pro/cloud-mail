import mytadaWorker from '../src/mytada';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalD1 } from './helpers/local-d1';
import { dbInit } from '../src/init/init';
import publicService from '../src/service/public-service';
import cryptoUtils from '../src/utils/crypto-utils';
import app from '../src/hono/hono';
import '../src/security/security';
import '../src/api/public-api';

const EXTERNAL_KEY = 'tada:dev:550e8400-e29b-41d4-a716-446655440000';
let runtime;
let c;
let env;

async function ensure(externalKey = EXTERNAL_KEY, displayName) {
  return publicService.ensureMailbox(c, { externalKey, displayName });
}

async function seedMail(address) {
  const owner = await env.db.prepare('SELECT account_id, user_id FROM account WHERE email = ?').bind(address).first();
  const row = await env.db.prepare(`INSERT INTO email (account_id,user_id,send_email,to_email,subject,text,content,message_id,in_reply_to,relation,recipient,type,create_time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING email_id`).bind(owner.account_id, owner.user_id, 'sender@example.org', address, 'A subject', 'body text', '<p>body text</p>', '<incoming@example.org>', '<parent@mazeai.pro>', '<root@mazeai.pro> <parent@mazeai.pro>', JSON.stringify([{ address }]), 0, '2026-10-19 10:00:00').first();
  return { ...owner, emailId: row.email_id };
}

beforeAll(async () => {
  runtime = await createLocalD1();
  const settings = new Map();
  env = { db: runtime.db, domain: ['mazeai.pro'], jwt_secret: 'local-test-secret', kv: {
    get: async (key, options) => options?.type === 'json' ? JSON.parse(settings.get(key) || 'null') : settings.get(key) ?? null,
    put: async (key, value) => { settings.set(key, value); },
  } };
  const values = new Map();
  c = { env, req: { param: () => env.jwt_secret, header: () => undefined }, text: (value) => value,
    set: (key, value) => values.set(key, value), get: (key) => values.get(key) };
  await dbInit.init(c);
  await env.kv.put('public_key:', 'local-public-token');
});
afterAll(async () => { await runtime?.dispose(); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await env.db.batch(['DELETE FROM attachments', 'DELETE FROM email', 'DELETE FROM account', 'DELETE FROM user'].map(sql => env.db.prepare(sql)));
});

describe('managed mailbox allocation with real D1', () => {
  it('creates one bound user/account and preserves the original address on retries', async () => {
    const first = await ensure(EXTERNAL_KEY, "O'Brien");
    expect(first).toEqual({ address: expect.stringMatching(/^u[1-9]\d{7}@mazeai\.pro$/), created: true });
    expect(await ensure(EXTERNAL_KEY, 'Changed')).toEqual({ address: first.address, created: false });
    const account = await env.db.prepare('SELECT * FROM account').first();
    const user = await env.db.prepare('SELECT * FROM user').first();
    expect(account.external_key).toBe(EXTERNAL_KEY);
    expect(account.name).toBe("O'Brien");
    expect(account.user_id).toBe(user.user_id);
    expect(user.password).toBeTruthy();
    expect(user.salt).toBeTruthy();
    expect(await cryptoUtils.verifyPassword('', user.salt, user.password)).toBe(false);
  });

  it('recovers the committed address when a batch response is lost', async () => {
    const realBatch = env.db.batch.bind(env.db);
    let committedAddress;
    const originalDb = c.env.db;
    c.env.db = new Proxy(originalDb, {
      get(target, key) {
        if (key === 'batch') return async statements => {
          await realBatch(statements);
          committedAddress = (await originalDb.prepare('SELECT email FROM account').first()).email;
          throw new Error('Simulated lost D1 response');
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      const result = await ensure();
      expect(result).toEqual({ address: committedAddress, created: false });
    } finally { c.env.db = originalDb; }
    expect(await ensure()).toEqual({ address: committedAddress, created: false });
    expect(await env.db.prepare('SELECT count(*) AS total FROM user').first()).toEqual({ total: 1 });
  });

  it('converges concurrent requests without orphan users', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => ensure()));
    expect(new Set(results.map(row => row.address)).size).toBe(1);
    expect(results.filter(row => row.created)).toHaveLength(1);
    expect(await env.db.prepare('SELECT count(*) AS total FROM user').first()).toEqual({ total: 1 });
    expect(await env.db.prepare('SELECT count(*) AS total FROM account').first()).toEqual({ total: 1 });
  });

  it('rejects disabled/deleted accounts and disabled/deleted owners without replacements', async () => {
    const { address } = await ensure();
    for (const [table, column] of [['account', 'status'], ['account', 'is_del'], ['user', 'status'], ['user', 'is_del']]) {
      await env.db.prepare(`UPDATE ${table} SET ${column} = 1`).run();
      await expect(ensure()).rejects.toThrow('不可用');
      await env.db.prepare(`UPDATE ${table} SET ${column} = 0`).run();
    }
    expect((await ensure()).address).toBe(address);
    expect(await env.db.prepare('SELECT count(*) AS total FROM account').first()).toEqual({ total: 1 });
  });

  it('retries real address collisions and rolls back the losing user insert', async () => {
    await env.db.prepare("INSERT INTO user(email,password,salt) VALUES ('legacy@mazeai.pro','hash','salt')").run();
    await env.db.prepare("INSERT INTO account(email,user_id) SELECT 'u10000000@mazeai.pro',user_id FROM user WHERE email='legacy@mazeai.pro'").run();
    const original = crypto.getRandomValues.bind(crypto);
    let draw = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      if (array instanceof Uint32Array && array.length === 1) { array[0] = draw++; return array; }
      return original(array);
    });
    expect((await ensure()).address).toBe('u10000001@mazeai.pro');
    expect(await env.db.prepare('SELECT count(*) AS total FROM user').first()).toEqual({ total: 2 });
  });

  it('rejects the incomplete random range and allows both eight-digit endpoints', async () => {
    const original = crypto.getRandomValues.bind(crypto);
    const draws = [0xffffffff, 89999999, 0];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      if (array instanceof Uint32Array && array.length === 1) { array[0] = draws.shift(); return array; }
      return original(array);
    });
    expect((await ensure()).address).toBe('u99999999@mazeai.pro');
    expect((await ensure('tada:dev:650e8400-e29b-41d4-a716-446655440000')).address).toBe('u10000000@mazeai.pro');
    expect(draws).toHaveLength(0);
  });

  it('stops after ten real collisions without creating users or repairing unrelated accounts', async () => {
    await env.db.prepare("INSERT INTO account(email,user_id) VALUES ('u10000000@mazeai.pro',0)").run();
    const original = crypto.getRandomValues.bind(crypto);
    let draws = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      if (array instanceof Uint32Array && array.length === 1) { array[0] = 0; draws++; return array; }
      return original(array);
    });
    await expect(ensure()).rejects.toThrow('分配冲突');
    expect(draws).toBe(10);
    expect(await env.db.prepare('SELECT count(*) AS total FROM user').first()).toEqual({ total: 0 });
    expect(await env.db.prepare('SELECT user_id FROM account').first()).toEqual({ user_id: 0 });
  });

  it('rolls back unexpected database faults and returns a sanitized error', async () => {
    await env.db.prepare("CREATE TRIGGER reject_managed_account BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'secret backend failure'); END").run();
    try {
      await expect(ensure()).rejects.toThrow('邮箱创建失败');
      expect(await env.db.prepare('SELECT count(*) AS total FROM user').first()).toEqual({ total: 0 });
    } finally {
      await env.db.prepare('DROP TRIGGER reject_managed_account').run();
    }
  });

  it('validates stable keys, names and configured domain before allocation', async () => {
    for (const key of ['', 'tada:dev:not-uuid', 'x'.repeat(300), null, 10, 'tada:dev:550e8400-e29b-41d4-a716-446655440000\n']) {
      await expect(ensure(key)).rejects.toThrow('externalKey');
    }
    await expect(ensure(EXTERNAL_KEY, 'x'.repeat(31))).rejects.toThrow('displayName');
    await expect(ensure(EXTERNAL_KEY, 'a\nb')).rejects.toThrow('displayName');
    env.domain = ['example.org'];
    try { await expect(ensure()).rejects.toThrow('mazeai.pro'); } finally { env.domain = ['mazeai.pro']; }
    await expect(publicService.ensureMailbox(c, null)).rejects.toThrow('参数');
    expect(await env.db.prepare('SELECT count(*) AS total FROM user').first()).toEqual({ total: 0 });
  });

  it('adds a nullable unique external key through a repeatable incremental migration', async () => {
    await dbInit.v2_11DB(c);
    await dbInit.v2_11DB(c);
    const preservedKey = 'tada:dev:750e8400-e29b-41d4-a716-446655440000';
    const preserved = await ensure(preservedKey);
    const expectedMigrationWarnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { await dbInit.init(c); } finally { expectedMigrationWarnings.mockRestore(); }
    expect(await ensure(preservedKey)).toEqual({ address: preserved.address, created: false });
    await env.db.prepare("INSERT INTO account(email,user_id) VALUES ('one@example.org',1),('two@example.org',2)").run();
    await env.db.prepare('UPDATE account SET external_key = ? WHERE email = ?').bind(EXTERNAL_KEY, 'one@example.org').run();
    await expect(env.db.prepare('UPDATE account SET external_key = ? WHERE email = ?').bind(EXTERNAL_KEY, 'two@example.org').run()).rejects.toThrow(/UNIQUE/);
  });
});

describe('scoped mailbox queries', () => {
  it('restricts body, filters and attachment metadata to exact owner and direction', async () => {
    const { address } = await ensure();
    const own = await seedMail(address);
    const other = await ensure('tada:dev:650e8400-e29b-41d4-a716-446655440000');
    await seedMail(other.address);
    await env.db.prepare(`INSERT INTO attachments (user_id,email_id,account_id,key,filename,mime_type,size) VALUES (?,?,?,?,?,?,?)`).bind(own.user_id, own.emailId, own.account_id, 'attachments/private.pdf', 'private.pdf', 'application/pdf', 4).run();
    const rows = await publicService.emailList(c, { ownerEmail: address.toUpperCase(), direction: 'inbound', messageId: '<incoming@example.org>', inReplyTo: '<parent@mazeai.pro>', since: '2026-10-19T09:00:00Z', afterEmailId: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ emailId: own.emailId, text: 'body text', messageId: '<incoming@example.org>', inReplyTo: '<parent@mazeai.pro>', relation: '<root@mazeai.pro> <parent@mazeai.pro>', recipient: expect.any(String), attachments: [{ attId: expect.any(Number), filename: 'private.pdf', mimeType: 'application/pdf', size: 4, disposition: null, contentId: null, type: 0 }] });
    expect(JSON.stringify(rows)).not.toContain('attachments/private.pdf');
    expect(await publicService.emailList(c, { ownerEmail: address, direction: 'outbound' })).toEqual([]);
    expect(await publicService.emailList(c, { ownerEmail: address, emailId: own.emailId + 1 })).toEqual([]);
    expect(await publicService.emailList(c, { ownerEmail: address, since: '2026-10-19T11:00:00Z' })).toEqual([]);
    expect(await publicService.emailList(c, { ownerEmail: address, afterEmailId: own.emailId })).toEqual([]);
    expect(await publicService.emailList(c, { toEmail: address })).toHaveLength(1);
  });

  it.each([99, 100])('returns %i scoped rows with empty and owned attachment metadata within D1 limits', async size => {
    const { address } = await ensure();
    const owner = await env.db.prepare('SELECT account_id, user_id FROM account WHERE email = ?').bind(address).first();
    const { results: inserted } = await env.db.prepare(`WITH RECURSIVE sequence(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
    ) INSERT INTO email (account_id,user_id,send_email,to_email,subject,text,content,type)
      SELECT ?,?,'sender@example.org',?,'subject','body text','<p>body text</p>',0 FROM sequence RETURNING email_id`)
      .bind(size, owner.account_id, owner.user_id, address).all();
    const firstEmailId = inserted[0].email_id;
    const lastEmailId = inserted.at(-1).email_id;
    await env.db.batch([firstEmailId, lastEmailId].map(emailId => env.db.prepare(`INSERT INTO attachments
      (user_id,email_id,account_id,key,filename,mime_type,size) VALUES (?,?,?,?,?,?,?)`)
      .bind(owner.user_id, emailId, owner.account_id, `attachments/${emailId}.pdf`, `${emailId}.pdf`, 'application/pdf', 4)));
    await env.db.prepare(`INSERT INTO attachments (user_id,email_id,account_id,key,filename)
      VALUES (?,?,?,?,?)`).bind(owner.user_id + 1, lastEmailId, owner.account_id + 1, 'attachments/foreign.pdf', 'foreign.pdf').run();
    const rows = await publicService.emailList(c, { ownerEmail: address, direction: 'inbound', size, timeSort: 'asc' });
    expect(rows).toHaveLength(size);
    expect(rows[0]).toMatchObject({ emailId: firstEmailId, attachments: [{ attId: expect.any(Number), filename: `${firstEmailId}.pdf`, mimeType: 'application/pdf', size: 4, disposition: null, contentId: null, type: 0 }] });
    expect(rows.at(-1)).toMatchObject({ emailId: lastEmailId, attachments: [{ attId: expect.any(Number), filename: `${lastEmailId}.pdf`, mimeType: 'application/pdf', size: 4, disposition: null, contentId: null, type: 0 }] });
    expect(rows.slice(1, -1).every(row => row.attachments.length === 0)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('foreign.pdf');
    expect(JSON.stringify(rows)).not.toContain('attachments/');
  });

  it('fails closed for new filters missing an owner or malformed scope', async () => {
    for (const params of [{ direction: 'inbound' }, { emailId: 1 }, { messageId: 'a' }, { inReplyTo: 'a' }, { since: '2026-01-01T00:00:00Z' }, { afterEmailId: 0 }]) {
      await expect(publicService.emailList(c, params)).rejects.toThrow('ownerEmail');
    }
    const { address } = await ensure();
    for (const params of [{ direction: 'wrong' }, { emailId: -1 }, { afterEmailId: 'no' }, { since: 'yesterday' }, { since: '2026-02-31T00:00:00Z' }, { since: '2026-01-01T00:00:00+08:00' }, { size: 10001 }, { num: 0 }]) {
      await expect(publicService.emailList(c, { ownerEmail: address, ...params })).rejects.toThrow();
    }
    await expect(publicService.emailList(c, { ownerEmail: '%' })).rejects.toThrow();
  });

  it('authenticates the public routes and serves only attachment records owned by that mailbox', async () => {
    const request = (path, body, token = 'local-public-token') => app.request(`http://local/public/${path}`, { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
    expect((await (await request('ensureMailbox', { externalKey: EXTERNAL_KEY }, 'bad-token')).json()).code).toBe(401);
    const allocated = await (await request('ensureMailbox', { externalKey: EXTERNAL_KEY })).json();
    expect(allocated).toMatchObject({ code: 200, data: { created: true } });
    const own = await seedMail(allocated.data.address);
    const other = await ensure('tada:dev:650e8400-e29b-41d4-a716-446655440000');
    const { att_id: attId } = await env.db.prepare('INSERT INTO attachments(user_id,email_id,account_id,key,filename) VALUES (?,?,?,?,?) RETURNING att_id').bind(own.user_id, own.emailId, own.account_id, 'attachments/private.pdf', 'private.pdf').first();
    env.r2 = { get: async key => { expect(key).toBe('attachments/private.pdf'); return { body: new Uint8Array([1, 2, 3, 4]), httpMetadata: { contentType: 'application/pdf' } }; } };
    const denied = await request('attachment', { ownerEmail: other.address, emailId: own.emailId, attId });
    expect((await denied.json()).code).not.toBe(200);
    const response = await request('attachment', { ownerEmail: allocated.data.address, emailId: own.emailId, attId });
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3, 4]);
    await env.db.prepare('UPDATE email SET is_del = 1 WHERE email_id = ?').bind(own.emailId).run();
    expect((await (await request('attachment', { ownerEmail: allocated.data.address, emailId: own.emailId, attId })).json()).code).not.toBe(200);
    delete env.r2;
  });
});

describe('isolated mytada entrypoint integration', () => {
  it('allocates a scoped mailbox using its own Worker secret without a KV public token', async () => {
    const token = 'independent-mytada-test-api-secret-123456';
    const mytadaEnv = { ...env, domain: ['mytada.ai'], managed_mailbox_domain: 'mytada.ai', managed_api_token: token };
    const response = await mytadaWorker.fetch(new Request('https://mail.mytada.ai/api/public/ensureMailbox', {
      method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalKey: EXTERNAL_KEY }),
    }), mytadaEnv, {});
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.address).toMatch(/^u[1-9]\d{7}@mytada\.ai$/);
    expect(await env.kv.get('public_key:')).toBe('local-public-token');
  });

  it('requires an owner and never returns another mailbox through the isolated list route', async () => {
    const token = 'independent-mytada-test-api-secret-123456';
    const mytadaEnv = { ...env, domain: ['mytada.ai'], managed_mailbox_domain: 'mytada.ai', managed_api_token: token };
    const request = (path, params) => mytadaWorker.fetch(new Request(`https://mail.mytada.ai/api/public/${path}`, {
      method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify(params),
    }), mytadaEnv, {});
    const first = (await (await request('ensureMailbox', { externalKey: EXTERNAL_KEY })).json()).data;
    const second = (await (await request('ensureMailbox', { externalKey: 'tada:dev:650e8400-e29b-41d4-a716-446655440000' })).json()).data;
    const own = await seedMail(first.address);
    const other = await seedMail(second.address);
    for (const params of [{}, null, { ownerEmail: '' }, { ownerEmail: ' ' }, { ownerEmail: 1 }, { toEmail: first.address }]) {
      const denied = await request('emailList', params);
      expect(denied.status).toBe(400);
      expect((await denied.json()).data).toBeUndefined();
    }
    const rows = (await (await request('emailList', { ownerEmail: first.address })).json()).data;
    expect(rows.map(row => row.emailId)).toEqual([own.emailId]);
    const filtered = await request('emailList', { ownerEmail: first.address, emailId: other.emailId });
    expect((await filtered.json()).data).toEqual([]);
    const addressed = await request('emailList', { ownerEmail: first.address, toEmail: second.address });
    expect((await addressed.json()).data).toEqual([]);
  });

});
