import app from '../hono/hono';
import result from '../model/result';
import publicService from '../service/public-service';

app.post('/public/genToken', async (c) => {
	const data = await publicService.genToken(c, await c.req.json());
	return c.json(result.ok(data));
});

app.post('/public/emailList', async (c) => {
	const list = await publicService.emailList(c, await c.req.json());
	return c.json(result.ok(list));
});

app.post('/public/addUser', async (c) => {
	await publicService.addUser(c, await c.req.json());
	return c.json(result.ok());
});

app.post('/public/sendEmail', async (c) => {
	const data = await publicService.sendEmail(c, await c.req.json());
	return c.json(result.ok(data));
});

app.post('/public/ensureMailbox', async (c) => {
  const data = await publicService.ensureMailbox(c, await c.req.json());
  return c.json(result.ok(data));
});

app.post('/public/attachment', async (c) => {
  return publicService.attachment(c, await c.req.json());
});

for (const method of ['mailboxProfile', 'checkMailboxAddress', 'renameMailbox', 'finalizeMailboxRename']) {
  app.post(`/public/${method}`, async c => c.json(result.ok(await publicService[method](c, await c.req.json()))));
}
