import BizError from '../error/biz-error';

export function formatSender(name, address) {
  if (typeof name !== 'string' || /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(name)) throw new BizError('发件人名称无效', 400);
  // Quote phrases containing specials; Resend performs Unicode header encoding.
  const phrase = /^[A-Za-z0-9 ]+$/.test(name) ? name : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `${phrase} <${address}>`;
}
