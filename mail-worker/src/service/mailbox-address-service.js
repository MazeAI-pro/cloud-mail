import BizError from '../error/biz-error';
import managedMailboxService from './managed-mailbox-service';

const KEY_PATTERN = /^tada:[A-Za-z0-9_-]{1,48}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LOCAL_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

export function normalizeLocalPart(value) {
  if (typeof value !== 'string') throw new BizError('邮箱前缀格式无效', 400);
  const name = value.trim().toLowerCase();
  if (name.length < 3 || name.length > 36) throw new BizError('邮箱前缀需为 3–36 位', 400);
  if (!LOCAL_PATTERN.test(name)) throw new BizError('邮箱前缀格式无效', 400);
  return name;
}

function validateParams(params, allowed) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !allowed.includes(key)) || !KEY_PATTERN.test(params.externalKey || '')) {
    throw new BizError('邮箱参数无效', 400);
  }
}

const mailboxAddressService = {
  async profile(c, params) {
    validateParams(params, ['externalKey']);
    const row = await managedMailboxService.findByExternalKey(c, params.externalKey);
    if (!row) return { provisioned: false, address: null };
    await managedMailboxService.resolveOwner(c, row.address);
    return { provisioned: true, address: row.address };
  },

  async check(c, params) {
    validateParams(params, ['externalKey', 'newLocalPart']);
    const name = normalizeLocalPart(params.newLocalPart);
    if (c.env.managed_mailbox_domain !== 'mytada.ai') throw new BizError('仅支持 mytada.ai 邮箱', 400);
    const profile = await this.profile(c, { externalKey: params.externalKey });
    if (!profile.provisioned) throw new BizError('邮箱尚未创建', 409);
    const address = `${name}@mytada.ai`;
    const occupied = await c.env.db.prepare(`SELECT 1 FROM account WHERE email = ? COLLATE NOCASE
      UNION ALL SELECT 1 FROM user WHERE email = ? COLLATE NOCASE LIMIT 1`).bind(address, address).first();
    return { available: !occupied, address };
  },

  async rename(c, params) {
    validateParams(params, ['externalKey', 'expectedAddress', 'newLocalPart']);
    const name = normalizeLocalPart(params.newLocalPart);
    if (c.env.managed_mailbox_domain !== 'mytada.ai' || typeof params.expectedAddress !== 'string' || !params.expectedAddress.endsWith('@mytada.ai')) throw new BizError('邮箱参数无效', 400);
    const address = `${name}@mytada.ai`;
    const row = await managedMailboxService.findByExternalKey(c, params.externalKey);
    if (!row) throw new BizError('邮箱尚未创建', 409);
    await managedMailboxService.resolveOwner(c, row.address);
    if (row.address === address) return { address };
    if (row.address !== params.expectedAddress) throw new BizError('邮箱地址已变化，请刷新', 409);
    try {
      // D1 serializes this transaction; the second update runs only after the first CAS wins.
      const result = await c.env.db.batch([
        c.env.db.prepare(`UPDATE user SET email = ? WHERE user_id = ? AND email = ? AND status = 0 AND is_del = 0
          AND EXISTS (SELECT 1 FROM account WHERE external_key = ? AND email = ? AND user_id = user.user_id AND status = 0 AND is_del = 0)`)
          .bind(address, row.userId, params.expectedAddress, params.externalKey, params.expectedAddress),
        c.env.db.prepare(`UPDATE account SET email = ?, name = CASE WHEN name = ? THEN ? ELSE name END
          WHERE external_key = ? AND email = ? AND changes() = 1`)
          .bind(address, params.expectedAddress.split('@')[0], name, params.externalKey, params.expectedAddress),
      ]);
      if (result[1].meta.changes !== 1) throw new BizError('邮箱地址已变化，请刷新', 409);
    } catch (error) {
      if (/UNIQUE/.test(error.message)) throw new BizError('邮箱地址已被占用', 409);
      throw error;
    }
    return { address };
  },
};
export default mailboxAddressService;
