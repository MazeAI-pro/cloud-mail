import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import worker, { readiness } from '../src/mytada';
const SECRET = 'local-test-secret-at-least-32-characters';
const request = (path, token) => new Request(`https://mail.mytada.ai${path}`, { headers: token ? { Authorization: token } : {} });
const readyEnv = () => ({ monitor_token: SECRET,
  db: { prepare: vi.fn(sql => sql.includes('external_key') ? { all: async () => ({ success: true }) } : { first: async () => ({ register: 1 }) }) },
  kv: { get: vi.fn(async () => 'mytada-v1') }, r2: { head: vi.fn(async () => ({ key: 'deployment/ready' })) },
});

describe('mytada deployment boundary', () => {
  it('uses separate resources and disables integration and preview surfaces', () => {
    const config = readFileSync(new URL('../wrangler-mytada.toml', import.meta.url), 'utf8');
    const original = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    for (const expected of ['name = "cloud-mail-mytada"', 'main = "src/mytada.js"', 'domain = ["mytada.ai"]', 'pattern = "mail.mytada.ai"', 'keep_vars = false', 'workers_dev = false', 'feishu_switch = "false"']) expect(config).toContain(expected);
    for (const field of ['database_id', 'id', 'bucket_name']) {
      const match = config.match(new RegExp(`^${field} = "([^"]+)"`, 'm'));
      expect(match).not.toBeNull();
      expect(original).not.toContain(match[1]);
      expect(match[1]).not.toContain('REPLACE');
    }
    expect(config).not.toMatch(/mazeai|people_|feishu_app|jwt_secret\s*=|managed_api_token\s*=/);
  });
  it.each(['/api/register', '/api/init/secret', '/api/oauth/bindUser', '/api/people/sendEmail', '/api/test', '/api/telegram', '/api/oss/attachments/a', '/attachments/a', '/api/webhooks'])('blocks legacy route %s without touching bindings', async path => {
    expect((await worker.fetch(request(path), {}, {})).status).toBe(404);
  });
  it.each([undefined, '', 'wrong'])('fails closed for missing or invalid API secret (%s)', async secret => {
    expect((await worker.fetch(request('/api/public/emailList'), { managed_api_token: secret }, {})).status).toBe(401);
  });
  it('does not expose legacy token rotation or bulk user creation', async () => {
    for (const path of ['/api/public/genToken', '/api/public/addUser']) {
      const response = await worker.fetch(new Request(`https://mail.mytada.ai${path}`, { method: 'POST', headers: { Authorization: SECRET } }), { managed_api_token: SECRET }, {});
      expect(response.status).toBe(404);
    }
  });
  it('keeps liveness lightweight and authenticates readiness separately', async () => {
    expect((await worker.fetch(request('/health/live'), {}, {})).status).toBe(200);
    const env = readyEnv();
    expect((await worker.fetch(request('/health/ready'), env, {})).status).toBe(401);
    expect(env.db.prepare).not.toHaveBeenCalled();
    const response = await worker.fetch(request('/health/ready', SECRET), env, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, checks: { d1: true, kv: true, r2: true } });
    expect(env.kv.get).toHaveBeenCalledWith('deployment:ready');
    expect(env.r2.head).toHaveBeenCalledWith('deployment/ready');
  });
  it.each(['db', 'kv', 'r2'])('reports failure without exception details (%s)', async binding => {
    const env = readyEnv(); env[binding] = undefined;
    const response = await readiness(env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/undefined|stack|secret|email/);
  });
  it('fails readiness when registration is opened', async () => {
    const env = readyEnv();
    env.db.prepare = sql => sql.includes('external_key') ? { all: async () => ({ success: true }) } : { first: async () => ({ register: 0 }) };
    expect((await readiness(env)).status).toBe(503);
  });
});
