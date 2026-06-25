import BizError from "../error/biz-error";
import orm from "../entity/orm";
import {oauth} from "../entity/oauth";
import { eq, inArray } from 'drizzle-orm';
import userService from "./user-service";
import loginService from "./login-service";
import cryptoUtils from "../utils/crypto-utils";
import { t } from '../i18n/i18n.js';

function feishuSwitchOn(c) {
	const v = c.env.feishu_switch;
	if (typeof v === 'string' && v === 'true') return true;
	if (v === true) return true;
	return false;
}

function allowedFeishuTenantKeys(c) {
	const raw = c.env.FEISHU_ALLOWED_TENANT_KEYS ?? c.env.feishu_allowed_tenant_keys ?? '';
	return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function extractTenantKeyFromPayload(data) {
	if (!data || typeof data !== 'object') return undefined;
	const inner = data.data;
	if (inner && typeof inner === 'object' && 'tenant_key' in inner) {
		const tk = inner.tenant_key;
		if (tk != null && String(tk)) return String(tk);
	}
	const tk = data.tenant_key;
	if (tk != null && String(tk)) return String(tk);
	return undefined;
}

function extractTenantKeyFromUser(u) {
	if (!u || typeof u !== 'object') return undefined;
	const tk = u.tenant_key;
	if (tk != null && String(tk)) return String(tk);
	return undefined;
}

function assertFeishuTenantAllowed(c, tokenData, userU) {
	if (!feishuSwitchOn(c)) return;

	const allowed = allowedFeishuTenantKeys(c);
	if (allowed.length === 0) {
		throw new BizError(t('feishuTenantAllowlistMissing'), 403);
	}

	let tenantKey = extractTenantKeyFromPayload(tokenData) ?? extractTenantKeyFromUser(userU);
	if (!tenantKey) {
		throw new BizError(t('feishuTenantKeyMissing'), 403);
	}

	if (!new Set(allowed).has(tenantKey)) {
		throw new BizError(t('feishuTenantNotAllowed'), 403);
	}
}

const oauthService = {

	async bindUser(c, params) {

		const { email, oauthUserId } = params;

		const oauthRow = await this.getById(c, oauthUserId);

		let userRow = await userService.selectByIdIncludeDel(c, oauthRow.userId);

		if (userRow) {
			throw new BizError('用户已绑定有邮箱')
		}

		await loginService.register(c, { email, password: cryptoUtils.genRandomPwd() }, true, true);

		userRow = await userService.selectByEmail(c, email);

		orm(c).update(oauth).set({ userId: userRow.userId }).where(eq(oauth.oauthUserId, oauthUserId)).run();
		const jwtToken = await loginService.login(c, { email, password: null }, true);

		return { userInfo: oauthRow, token: jwtToken}
	},

	async feishuLogin(c, params) {

		const { code } = params;

		const reqParams = new URLSearchParams()
		reqParams.append('grant_type', 'authorization_code')
		reqParams.append('client_id', c.env.feishu_app_id)
		reqParams.append('client_secret', c.env.feishu_app_secret)
		reqParams.append('code', code)
		reqParams.append('redirect_uri', c.env.feishu_redirect_uri)

		const tokenRes = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: reqParams.toString()
		})

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText)
		}

		const tokenData = await tokenRes.json()
		const accessToken = tokenData.access_token
			?? tokenData.data?.access_token
		if (!accessToken) {
			throw new BizError('飞书授权失败：无法获取 access_token')
		}

		const userRes = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
			headers: { Authorization: 'Bearer ' + accessToken }
		})

		if (!userRes.ok) {
			throw new BizError(userRes.statusText)
		}

		const userData = await userRes.json()
		const u = userData.data ?? userData

		assertFeishuTenantAllowed(c, tokenData, u)

		const userInfo = {
			oauthUserId: String(u.user_id ?? u.open_id ?? u.sub ?? ''),
			username: String(u.name ?? ''),
			name: String(u.name ?? ''),
			avatar: String(u.avatar_url ?? u.picture ?? ''),
			active: 0,
			trustLevel: 0,
			silenced: 0,
		}

		const oauthRow = await this.saveUser(c, userInfo);
		const userRow = await userService.selectByIdIncludeDel(c, oauthRow.userId);

		if (!userRow) {
			return { userInfo: oauthRow, token: null }
		}

		const JwtToken = await loginService.login(c, { email: userRow.email, password: null }, true);
		return { userInfo: oauthRow, token: JwtToken }
	},

	async saveUser(c, userInfo) {

		const userInfoRow = await this.getById(c, userInfo.oauthUserId);

		if (!userInfoRow) {
			return await orm(c).insert(oauth).values(userInfo).returning().get();
		} else {
			return await orm(c).update(oauth).set(userInfo).where(eq(oauth.oauthUserId, userInfo.oauthUserId)).returning().get();
		}

	},

	async getById(c, oauthUserId) {
		return await orm(c).select().from(oauth).where(eq(oauth.oauthUserId, oauthUserId)).get();
	},

	async deleteByUserId(c, userId) {
		await this.deleteByUserIds(c, [userId]);
	},

	async deleteByUserIds(c, userIds) {
		await orm(c).delete(oauth).where(inArray(oauth.userId, userIds)).run();
	},

	//定时任务凌晨清除未绑定邮箱的oauth用户
	async clearNoBindOathUser(c) {
		await orm(c).delete(oauth).where(eq(oauth.userId, 0)).run();
	},

}

export default  oauthService
