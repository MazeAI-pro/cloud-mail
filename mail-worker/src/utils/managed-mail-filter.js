import { sql } from 'drizzle-orm';
import BizError from '../error/biz-error';

const D1_LIKE_MAX_BYTES = 50;
const encoder = new TextEncoder();

export function managedMailFilter(column, pattern, field) {
  if (typeof pattern !== 'string' || pattern.includes('\0')) {
    throw new BizError(`${field} must be a string without NUL characters`, 400);
  }
  if (encoder.encode(pattern).length <= D1_LIKE_MAX_BYTES) {
    return sql`${column} COLLATE NOCASE LIKE ${pattern}`;
  }
  // D1 limits LIKE patterns by UTF-8 bytes, even when they contain no wildcards.
  if (!/[%_]/.test(pattern)) {
    return sql`${column} COLLATE NOCASE = ${pattern}`;
  }
  if (!/^%?[^%_]+%?$/.test(pattern)) {
    throw new BizError(`${field}: patterns over 50 UTF-8 bytes support only a literal with an optional leading or trailing %`, 400);
  }
  const leading = pattern.startsWith('%');
  const trailing = pattern.endsWith('%');
  const literal = pattern.slice(leading ? 1 : 0, trailing ? -1 : undefined);
  // SQLite lower/NOCASE preserve LIKE's ASCII-only case folding.
  if (leading && trailing) {
    return sql`instr(lower(${column}), lower(${literal})) > 0`;
  }
  if (leading) {
    return sql`substr(${column}, -length(${literal})) COLLATE NOCASE = ${literal}`;
  }
  return sql`substr(${column}, 1, length(${literal})) COLLATE NOCASE = ${literal}`;
}
