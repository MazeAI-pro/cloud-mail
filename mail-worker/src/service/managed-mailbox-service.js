import BizError from '../error/biz-error';
import cryptoUtils from '../utils/crypto-utils';
import roleService from './role-service';
import r2Service from './r2-service';

const MAILBOX_DOMAIN = 'mazeai.pro';
const ADDRESS_COUNT = 90000000;
const MAX_CREATE_ATTEMPTS = 10;
// Reserve two of D1's 100 SQL variables for exact mailbox ownership.
const ATTACHMENT_QUERY_BATCH_SIZE = 98;
const EXTERNAL_KEY_PATTERN = /^tada:[A-Za-z0-9_-]{1,48}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ACCOUNT_SELECT = `SELECT a.email AS address, a.account_id AS accountId, a.user_id AS userId,
  a.status AS accountStatus, a.is_del AS accountDeleted, u.user_id AS ownerId,
  u.status AS userStatus, u.is_del AS userDeleted FROM account a LEFT JOIN user u ON u.user_id = a.user_id`;

function usableAccount(row) {
  if (!row.ownerId || row.accountStatus !== 0 || row.accountDeleted !== 0 || row.userStatus !== 0 || row.userDeleted !== 0) {
    throw new BizError('受管邮箱不可用，请联系管理员', 409);
  }
  return row;
}

function positiveInteger(value, name, allowZero = false) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') {
    throw new BizError(`${name} 参数无效`, 400);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new BizError(`${name} 参数无效`, 400);
  }
  return number;
}

function randomAddress(domain) {
  // Reject the incomplete range so every eight-digit integer is equally likely.
  const limit = Math.floor(0x100000000 / ADDRESS_COUNT) * ADDRESS_COUNT;
  const draw = new Uint32Array(1);
  do { crypto.getRandomValues(draw); } while (draw[0] >= limit);
  return `u${10000000 + draw[0] % ADDRESS_COUNT}@${domain}`;
}

const managedMailboxService = {
  async findByExternalKey(c, externalKey) {
    return c.env.db.prepare(`${ACCOUNT_SELECT} WHERE a.external_key = ?`).bind(externalKey).first();
  },

  async ensureMailbox(c, params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new BizError('邮箱参数无效', 400);
    const { externalKey, displayName } = params;
    if (typeof externalKey !== 'string' || externalKey !== externalKey.trim() || !EXTERNAL_KEY_PATTERN.test(externalKey)) {
      throw new BizError('externalKey 必须为 tada:<scope>:<UUID>', 400);
    }
    if (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > 30 || /[\x00-\x1f\x7f]/.test(displayName))) {
      throw new BizError('displayName 必须为不超过 30 字符的单行名称', 400);
    }
    try {
      const mailboxDomain = c.env.managed_mailbox_domain || MAILBOX_DOMAIN;
      let domains = c.env.domain;
      if (typeof domains === 'string') domains = JSON.parse(domains);
      if (!Array.isArray(domains) || !domains.includes(mailboxDomain)) {
        throw new BizError(`未配置受管邮箱域名 ${mailboxDomain}`, 503);
      }
      const existing = await this.findByExternalKey(c, externalKey);
      if (existing) return { address: usableAccount(existing).address, created: false };
      const defaultRole = await roleService.selectDefaultRole(c);
      if (!defaultRole || !roleService.hasAvailDomainPerm(defaultRole.availDomain || '', `u10000000@${mailboxDomain}`)) {
        throw new BizError('默认邮箱角色未配置或无域名权限', 503);
      }
      const passwordBytes = crypto.getRandomValues(new Uint8Array(32));
      const { salt, hash } = await cryptoUtils.hashPassword(btoa(String.fromCharCode(...passwordBytes)));
      for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
        const address = randomAddress(mailboxDomain);
        try {
          // D1 batches are transactional; an account conflict also rolls back its user.
          await c.env.db.batch([
            c.env.db.prepare('INSERT INTO user (email,password,salt,type) VALUES (?,?,?,?)').bind(address, hash, salt, defaultRole.roleId),
            c.env.db.prepare(`INSERT INTO account (email,name,user_id,external_key)
              VALUES (?, ?, (SELECT user_id FROM user WHERE email = ? COLLATE NOCASE), ?)`)
              .bind(address, displayName || address.split('@')[0], address, externalKey),
          ]);
          return { address, created: true };
        } catch (error) {
          // A concurrent creator or a committed request whose response timed out wins.
          const winner = await this.findByExternalKey(c, externalKey);
          if (winner) return { address: usableAccount(winner).address, created: false };
          if (!/UNIQUE constraint failed: (?:account|user)\.email\b/i.test(error.message)) throw error;
        }
      }
      throw new BizError('邮箱地址分配冲突，请重试', 503);
    } catch (error) {
      if (error instanceof BizError) throw error;
      throw new BizError('邮箱创建失败，请稍后重试', 503);
    }
  },

  async resolveOwner(c, ownerEmail) {
    if (typeof ownerEmail !== 'string' || ownerEmail.length > 254 || !/^[^\s%@]+@[^\s%@]+\.[^\s%@]+$/.test(ownerEmail)) {
      throw new BizError('ownerEmail 参数无效', 400);
    }
    const row = await c.env.db.prepare(`${ACCOUNT_SELECT} WHERE a.email = ? COLLATE NOCASE`).bind(ownerEmail).first();
    if (!row) throw new BizError('ownerEmail 对应邮箱不存在', 404);
    return usableAccount(row);
  },

  async listScope(c, params) {
    const scopeKeys = ['ownerEmail', 'direction', 'emailId', 'messageId', 'inReplyTo', 'since', 'afterEmailId'];
    if (!scopeKeys.some(key => params[key] !== undefined)) return null;
    if (!params.ownerEmail) throw new BizError('使用邮箱范围过滤必须提供 ownerEmail', 400);
    const owner = await this.resolveOwner(c, params.ownerEmail);
    const scope = { owner };
    if (params.direction !== undefined && !['inbound', 'outbound'].includes(params.direction)) throw new BizError('direction 参数无效', 400);
    if (params.emailId !== undefined) scope.emailId = positiveInteger(params.emailId, 'emailId');
    if (params.afterEmailId !== undefined) scope.afterEmailId = positiveInteger(params.afterEmailId, 'afterEmailId', true);
    for (const key of ['messageId', 'inReplyTo']) {
      if (params[key] !== undefined && (typeof params[key] !== 'string' || params[key].length === 0 || params[key].length > 998 || /[\x00-\x1f\x7f]/.test(params[key]))) throw new BizError(`${key} 参数无效`, 400);
    }
    if (params.since !== undefined) {
      if (typeof params.since !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(params.since) || !Number.isFinite(Date.parse(params.since))) throw new BizError('since 必须为 UTC ISO 时间', 400);
      scope.since = new Date(params.since).toISOString();
      if (scope.since.slice(0, 19) !== params.since.slice(0, 19)) throw new BizError('since 时间无效', 400);
    }
    scope.size = params.size === undefined ? 20 : positiveInteger(params.size, 'size');
    scope.num = params.num === undefined ? 1 : positiveInteger(params.num, 'num');
    if (scope.size > 100 || !Number.isSafeInteger((scope.num - 1) * scope.size)) throw new BizError('分页参数无效', 400);
    return scope;
  },

  async addAttachments(c, rows, owner) {
    if (!rows.length) return;
    for (let offset = 0; offset < rows.length; offset += ATTACHMENT_QUERY_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + ATTACHMENT_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      const { results } = await c.env.db.prepare(`SELECT att_id AS attId, email_id AS emailId, filename,
        mime_type AS mimeType, size, disposition, content_id AS contentId, type FROM attachments
        WHERE user_id = ? AND account_id = ? AND status = 0 AND email_id IN (${placeholders})`)
        .bind(owner.userId, owner.accountId, ...batch.map(row => row.emailId)).all();
      for (const row of batch) row.attachments = results.filter(att => att.emailId === row.emailId).map(({ emailId, ...metadata }) => metadata);
    }
  },

  async attachment(c, params) {
    const owner = await this.resolveOwner(c, params.ownerEmail);
    const emailId = positiveInteger(params.emailId, 'emailId');
    const attId = positiveInteger(params.attId, 'attId');
    const attachment = await c.env.db.prepare(`SELECT a.key FROM attachments a JOIN email e ON e.email_id = a.email_id
      WHERE a.att_id = ? AND e.email_id = ? AND a.user_id = ? AND a.account_id = ?
      AND e.user_id = ? AND e.account_id = ? AND e.is_del = 0 AND a.status = 0`)
      .bind(attId, emailId, owner.userId, owner.accountId, owner.userId, owner.accountId).first();
    if (!attachment) throw new BizError('附件不存在或不属于指定邮箱', 404);
    return r2Service.toObjResp(c, attachment.key);
  },
};

export default managedMailboxService;
