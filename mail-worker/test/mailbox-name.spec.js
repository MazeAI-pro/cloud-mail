import { expect, it } from 'vitest';
import { formatSender } from '../src/utils/mailbox-name';

it('preserves default names and quotes Unicode, quotes, slashes and address-like phrases', () => {
  expect(formatSender('u12345678', 'u12345678@mytada.ai')).toBe('u12345678 <u12345678@mytada.ai>');
  expect(formatSender('小王 "旅行"', 'u12345678@mytada.ai')).toBe('"小王 \\"旅行\\"" <u12345678@mytada.ai>');
  expect(formatSender('x <evil@example.org>', 'u12345678@mytada.ai')).toBe('"x <evil@example.org>" <u12345678@mytada.ai>');
});
it.each(['bad\r\nBcc: x', 'bad\x00', 'bad\x85'])('rejects unsafe existing names before sending', name => {
  expect(() => formatSender(name, 'u12345678@mytada.ai')).toThrow();
});
