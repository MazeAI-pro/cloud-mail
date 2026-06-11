import app from '../hono/hono';
import result from '../model/result';
import publicService from '../service/public-service';
import peopleService from '../service/people-service';

function verifyPeopleToken(c) {
	const expected = c.env.cloudmail_people_token;
	if (!expected) {
		return false;
	}
	const token = c.req.header('X-Internal-Token');
	return !!token && token === expected;
}

// 外部 URL 为 /api/people/sendEmail；index.js 会剥掉 /api 前缀后进入 Hono
app.post('/people/sendEmail', async (c) => {
	if (!verifyPeopleToken(c)) {
		return c.json({ error: 'not_found' }, 404);
	}

	const from = peopleService.hireMailbox(c.env);
	if (!from) {
		return c.json(result.fail('hire mailbox not configured'), 503);
	}

	const params = await c.req.json();
	const data = await publicService.sendEmail(c, {
		from,
		to: params.to,
		subject: params.subject,
		text: params.text,
		html: params.html,
		inReplyTo: params.inReplyTo,
	});
	return c.json(result.ok(data));
});
