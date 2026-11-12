import { Hono } from 'hono';
import worker from './index';
import publicService from './service/public-service';
import result from './model/result';

const managedApp = new Hono();
const PUBLIC_METHODS = {
  ensureMailbox: 'ensureMailbox',
  mailboxProfile: 'mailboxProfile',
  checkMailboxAddress: 'checkMailboxAddress',
  renameMailbox: 'renameMailbox',
  finalizeMailboxRename: 'finalizeMailboxRename',
  emailList: 'emailList',
  sendEmail: 'sendEmail',
  attachment: 'attachment',
};

managedApp.onError((error, c) => {
  const status = Number.isInteger(error.code) && error.code >= 400 && error.code <= 599 ? error.code : 500;
  return c.json({ code: status, message: 'Request failed' }, status);
});
for (const [path, method] of Object.entries(PUBLIC_METHODS)) {
  managedApp.post(`/api/public/${path}`, async c => {
    const params = await c.req.json();
    if (method === 'emailList' && (typeof params?.ownerEmail !== 'string' || !params.ownerEmail.trim())) {
      return c.json({ code: 400, message: 'ownerEmail is required' }, 400);
    }
    const response = await publicService[method](c, params);
    return response instanceof Response ? response : c.json(result.ok(response));
  });
}

function authorized(request, secret) {
  return typeof secret === 'string' && secret.length >= 32 && request.headers.get('Authorization') === secret;
}

function isolatedEnv(env) {
  // Keep integrations disabled even if stale variables are accidentally added later.
  return { ...env, feishu_switch: 'false', feishu_app_secret: undefined,
    cloudmail_people_token: undefined, people_inbound_url: undefined };
}

export async function readiness(env) {
  const probes = {
    d1: async () => {
      const row = await env.db.prepare("SELECT external_key FROM account WHERE 0").all();
      const settings = await env.db.prepare('SELECT register FROM setting LIMIT 1').first();
      return row.success === true && settings?.register === 1;
    },
    kv: async () => (await env.kv.get('deployment:ready')) === 'mytada-v1',
    r2: async () => (await env.r2.head('deployment/ready')) !== null,
  };
  const entries = await Promise.all(Object.entries(probes).map(async ([key, probe]) => {
    let timer;
    try {
      const value = await Promise.race([probe(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 3000);
      })]);
      return [key, value === true];
    } catch { return [key, false]; }
    finally { clearTimeout(timer); }
  }));
  const checks = Object.fromEntries(entries);
  const ok = Object.values(checks).every(Boolean);
  return Response.json({ ok, checks }, { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    // Hono decodes paths after dispatch. Reject encoded paths before either router sees them.
    if (path.includes('%')) return new Response('Invalid path', { status: 400 });
    if (path === '/health/live') {
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (path === '/health/ready') {
      if (!authorized(request, env.monitor_token)) return new Response('Unauthorized', { status: 401 });
      return readiness(env);
    }
    // Block bootstrap, self-registration, integrations and unauthenticated attachment access.
    if (/^\/api\/(register|init|oauth|people|test|telegram|oss|webhooks)(\/|$)/.test(path) || path.startsWith('/attachments/')) {
      return new Response('Not found', { status: 404 });
    }
    if (path.startsWith('/api/public')) {
      if (!authorized(request, env.managed_api_token)) return new Response('Unauthorized', { status: 401 });
      return managedApp.fetch(request, isolatedEnv(env), ctx);
    }
    return worker.fetch(request, isolatedEnv(env), ctx);
  },
  email(message, env, ctx) { return worker.email(message, isolatedEnv(env), ctx); },
  scheduled(event, env, ctx) { return worker.scheduled(event, isolatedEnv(env), ctx); },
};
