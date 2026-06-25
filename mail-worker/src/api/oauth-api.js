import app from '../hono/hono';
import result from "../model/result";
import oauthService from "../service/oauth-service";

app.post('/oauth/feishu/login', async (c) => {
	const loginInfo = await oauthService.feishuLogin(c, await c.req.json());
	return c.json(result.ok(loginInfo))
});

app.put('/oauth/bindUser', async (c) => {
	const loginInfo = await oauthService.bindUser(c, await c.req.json());
	return c.json(result.ok(loginInfo))
})
