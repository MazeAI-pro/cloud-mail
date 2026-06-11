import settingService from './setting-service';
import domainUtils from '../utils/domain-uitls';

/**
 * 与 people 项目（Maze·小觅）的集成。
 *
 * 当 hire@ 邮箱收到候选人邮件时，把正文 + 附件（R2 公网链接）回调给 people，
 * 由 people 完成简历提取/入库/通知面试官。
 *
 * 走 wrangler env 配置，fire-and-forget：失败只打日志，绝不阻断既有收件流程。
 */
const peopleService = {

	/**
	 * 是否需要把这封邮件转发给 people。
	 * 收件箱地址匹配 env.people_hire_mailbox（默认 hire@<第一个域名>）时触发。
	 */
	shouldForward(env, toEmail) {
		if (!env || !env.people_inbound_url || !env.cloudmail_people_token) {
			return false;
		}
		const target = (this.hireMailbox(env) || '').toLowerCase();
		return !!target && (toEmail || '').toLowerCase() === target;
	},

	hireMailbox(env) {
		if (env.people_hire_mailbox) {
			return env.people_hire_mailbox;
		}
		// 兜底：hire@ + 第一个受管域名
		let domainList = env.domain;
		if (typeof domainList === 'string') {
			try {
				domainList = JSON.parse(domainList);
			} catch {
				domainList = [domainList];
			}
		}
		const domain = Array.isArray(domainList) ? domainList[0] : null;
		return domain ? `hire@${domain}` : null;
	},

	/**
	 * 用 hash key 构造附件的可公开访问 URL。
	 * 优先用配置的 r2Domain（OSS 自定义域），否则回落到 worker 自身 origin 的 /attachments/ 路径。
	 */
	buildAttachmentUrl(env, r2Domain, workerOrigin, key) {
		const base = domainUtils.toOssDomain(r2Domain);
		if (base) {
			return `${base}/${key}`;
		}
		// key 形如 attachments/<hash>.<ext>，worker 在 index.js 中以 /attachments/ 提供服务
		const origin = workerOrigin || (env.people_worker_origin ?? '');
		if (origin) {
			return `${origin.replace(/\/$/, '')}/${key}`;
		}
		return key;
	},

	/**
	 * 把入站邮件回调给 people。fire-and-forget。
	 *
	 * @param {object} env
	 * @param {object} payload 邮件正文 + 附件元数据
	 */
	async forwardInbound(env, payload) {
		try {
			const resp = await fetch(env.people_inbound_url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Internal-Token': env.cloudmail_people_token,
				},
				body: JSON.stringify(payload),
			});
			if (!resp.ok) {
				const body = await resp.text().catch(() => '');
				console.error(`[people] 回调失败 status=${resp.status} body=${body.slice(0, 500)}`);
			}
		} catch (e) {
			console.error('[people] 回调异常: ', e);
		}
	},

	/**
	 * 从解析后的邮件构造回调 payload（含附件 R2 链接）。
	 */
	async buildPayload(c, env, email, message, attachments, r2Domain) {
		let r2Resolved = r2Domain;
		if (r2Resolved === undefined) {
			try {
				const s = await settingService.query(c);
				r2Resolved = s.r2Domain;
			} catch {
				r2Resolved = null;
			}
		}

		let workerOrigin = env.people_worker_origin ?? null;
		if (!workerOrigin && c?.req?.url) {
			try {
				workerOrigin = new URL(c.req.url).origin;
			} catch {
				workerOrigin = null;
			}
		}

		const atts = (attachments || []).map((att) => ({
			filename: att.filename,
			contentType: att.mimeType,
			size: att.size,
			url: this.buildAttachmentUrl(env, r2Resolved, workerOrigin, att.key),
		}));

		return {
			to: message.to,
			from: email.from?.address ?? null,
			fromName: email.from?.name ?? null,
			subject: email.subject ?? null,
			text: email.text ?? null,
			html: email.html ?? null,
			messageId: email.messageId ?? null,
			inReplyTo: email.inReplyTo ?? null,
			references: email.references ?? null,
			attachments: atts,
		};
	},

	/**
	 * 站内信投递到 hire@ 时，从已落库的发件记录构造 people 回调 payload。
	 */
	async buildPayloadFromSentRow(c, env, sendEmailData, attList, toEmail, r2Domain) {
		let r2Resolved = r2Domain;
		if (r2Resolved === undefined) {
			try {
				const s = await settingService.query(c);
				r2Resolved = s.r2Domain;
			} catch {
				r2Resolved = null;
			}
		}

		let workerOrigin = env.people_worker_origin ?? null;
		if (!workerOrigin && c?.req?.url) {
			try {
				workerOrigin = new URL(c.req.url).origin;
			} catch {
				workerOrigin = null;
			}
		}

		const atts = (attList || []).map((att) => ({
			filename: att.filename,
			contentType: att.mimeType,
			size: att.size,
			url: this.buildAttachmentUrl(env, r2Resolved, workerOrigin, att.key),
		}));

		return {
			to: toEmail,
			from: sendEmailData.sendEmail ?? null,
			fromName: sendEmailData.name ?? null,
			subject: sendEmailData.subject ?? null,
			text: sendEmailData.text ?? null,
			html: sendEmailData.content ?? null,
			messageId: sendEmailData.messageId ?? null,
			inReplyTo: sendEmailData.inReplyTo ?? null,
			references: sendEmailData.relation ?? null,
			attachments: atts,
		};
	},
};

export default peopleService;
