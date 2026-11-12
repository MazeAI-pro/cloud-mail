import BizError from '../error/biz-error';
import managedMailboxService from './managed-mailbox-service';

const RESERVED = new Set(['admin', 'postmaster', 'abuse', 'security', 'support', 'system', 'root', 'noreply', 'no-reply', 'mailer-daemon', 'webmaster', 'hostmaster', 'mail']);
const KEY_PATTERN = /^tada:[A-Za-z0-9_-]{1,48}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function normalizeLocalPart(value) {
  if (typeof value !== 'string') throw new BizError('newLocalPart 参数无效', 400);
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(name) || name.includes('..') || RESERVED.has(name) || /^u[0-9]{8}$/.test(name)) {
    throw new BizError('邮箱前缀不可用，请使用 3–32 位字母、数字、点、下划线或短横线', 400);
  }
  return name;
}

export async function addressSchemaReady(c) {
  // A read-only schema probe supports workers deployed before the explicit migration.
  return Boolean(await c.env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'managed_retired_address'").first());
}

export async function isRetiredAddress(c, address) {
  if (!(await addressSchemaReady(c))) return false;
  return Boolean(await c.env.db.prepare('SELECT address FROM managed_retired_address WHERE address = ? COLLATE NOCASE').bind(address).first());
}

function validateParams(params, allowed) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !allowed.includes(key)) || !KEY_PATTERN.test(params.externalKey || '')) {
    throw new BizError('邮箱参数无效', 400);
  }
}

async function operation(c, operationId) {
  return c.env.db.prepare('SELECT operation_id AS operationId, external_key AS externalKey, expected_address AS expectedAddress, new_address AS address, finalized FROM managed_address_change WHERE operation_id = ?').bind(operationId).first();
}

const mailboxAddressService = {
  async profile(c, params) {
    validateParams(params, ['externalKey']);
    const row = await managedMailboxService.findByExternalKey(c, params.externalKey);
    if (!row) return { provisioned: false, address: null, pendingOperation: null };
    await managedMailboxService.resolveOwner(c, row.address);
    const ready = await addressSchemaReady(c);
    const pendingOperation = ready ? await c.env.db.prepare('SELECT operation_id AS operationId, expected_address AS expectedAddress, new_address AS address FROM managed_address_change WHERE external_key = ? AND finalized = 0').bind(params.externalKey).first() : null;
    return { provisioned: true, address: row.address, pendingOperation, canEditAddress: ready && c.env.MAILBOX_ADDRESS_EDIT_ENABLED === 'true' };
  },

  async rename(c, params) {
    validateParams(params, ['externalKey', 'expectedAddress', 'newLocalPart', 'operationId']);
    if (c.env.MAILBOX_ADDRESS_EDIT_ENABLED !== 'true') throw new BizError('邮箱地址修改尚未开放', 403);
    if (!(await addressSchemaReady(c))) throw new BizError('邮箱地址迁移尚未完成', 503);
    if (!UUID_PATTERN.test(params.operationId || '') || typeof params.expectedAddress !== 'string') throw new BizError('邮箱参数无效', 400);
    const name = normalizeLocalPart(params.newLocalPart);
    const domain = c.env.managed_mailbox_domain || 'mazeai.pro';
    if (domain !== 'mytada.ai') throw new BizError('仅支持 mytada.ai 邮箱', 400);
    const address = `${name}@${domain}`;
    const matching = row => {
      if (row.externalKey !== params.externalKey || row.expectedAddress !== params.expectedAddress || row.address !== address) throw new BizError('operationId 冲突', 409);
      return row;
    };
    const previous = await operation(c, params.operationId);
    if (previous) return matching(previous);
    if (address === params.expectedAddress) throw new BizError('邮箱地址未改变', 400);
    try {
      // The migration's trigger performs both identity updates and retirement atomically.
      await c.env.db.prepare('INSERT INTO managed_address_change(operation_id, external_key, expected_address, new_address) VALUES (?, ?, ?, ?)')
        .bind(params.operationId, params.externalKey, params.expectedAddress, address).run();
    } catch (error) {
      const retry = await operation(c, params.operationId);
      if (retry) return matching(retry);
      if (/UNIQUE|retired_address|address_changed_or_unavailable/.test(error.message)) throw new BizError('邮箱地址已被占用或修改尚未完成，请刷新后重试', 409);
      throw error;
    }
    return matching(await operation(c, params.operationId));
  },

  async finalize(c, params) {
    validateParams(params, ['externalKey', 'operationId', 'address']);
    if (!UUID_PATTERN.test(params.operationId || '')) throw new BizError('operationId 参数无效', 400);
    if (!(await addressSchemaReady(c))) throw new BizError('邮箱地址迁移尚未完成', 503);
    const row = await operation(c, params.operationId);
    if (!row || row.externalKey !== params.externalKey || row.address !== params.address) throw new BizError('邮箱操作不匹配', 409);
    await c.env.db.prepare('UPDATE managed_address_change SET finalized = 1 WHERE operation_id = ?').bind(params.operationId).run();
    return { address: row.address, operationId: row.operationId, finalized: true };
  },
};
export default mailboxAddressService;
