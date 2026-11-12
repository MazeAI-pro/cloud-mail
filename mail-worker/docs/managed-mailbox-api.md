# Managed mailbox API (local implementation, unpublished)

These endpoints are implemented locally and have not been deployed. They use the existing public API token: `Authorization: <token>` (the raw token, without a `Bearer` prefix). They are intended for trusted server callers; do not expose the token to browsers or agents. Worker URLs include `/api`; internal Hono paths omit it.

Run the existing secret-protected initialization endpoint after updating the worker. Migration `v2_11DB` adds nullable `account.external_key` and its unique index; it is safe to run again. Existing accounts keep `NULL` keys. No tables or bindings are added.

## Ensure a mailbox

`POST /api/public/ensureMailbox`

```json
{"externalKey":"tada:dev:550e8400-e29b-41d4-a716-446655440000","displayName":"Alice"}
```

`externalKey` is `tada:<scope>:<UUID>`; scope allows 1–48 ASCII letters, digits, underscores or hyphens. Supply the same exact key on every retry. Optional `displayName` is a single line of at most 30 characters. Unknown fields do not select an address or domain.

```json
{"code":200,"message":"success","data":{"address":"u12345678@mazeai.pro","created":true}}
```

The address uses an unbiased random integer from 10000000 through 99999999. `mazeai.pro` must be present in the existing `domain` environment setting. The account and its hashed random-password user are created in one D1 transaction using the default role. No password is returned. Repeated/concurrent calls return the original address and `created:false`. A disabled or soft-deleted account/user fails explicitly rather than being replaced. Preserve managed account rows: permanent deletion also deletes the only external-key mapping.

## Read a mailbox

`POST /api/public/emailList`

```json
{"ownerEmail":"u12345678@mazeai.pro","direction":"inbound","inReplyTo":"<parent@mazeai.pro>","since":"2026-10-19T00:00:00Z","afterEmailId":0,"timeSort":"asc","num":1,"size":20}
```

`ownerEmail` resolves one account and its user by exact case-insensitive address. Queries are restricted to both IDs and nondeleted emails; disabled/deleted accounts/users fail. Optional `direction` is `inbound` or `outbound`; omitting it reads both. Optional exact filters: database integer `emailId`, RFC `messageId`, RFC `inReplyTo`. `since` is an inclusive UTC ISO timestamp ending in `Z`; `afterEmailId` is an exclusive nonnegative integer cursor. Filters combine with AND. Pagination starts at `num:1`, defaults to `size:20`, and allows at most 100 rows per scoped page.

Existing `sendEmail`, `toEmail`, `sendName`, `subject`, `content`, `type`, `isDel`, `timeSort`, `num`, `size` filters remain available. For scoped requests, `sendEmail`, `toEmail`, `sendName`, `subject`, and `content` retain SQL LIKE behavior for patterns up to 50 UTF-8 bytes (including `%` and `_`). Longer filters support literal exact matches, `%literal%` (contains), `literal%` (prefix), and `%literal` (suffix), using parameterized comparisons that bypass the [D1 LIKE pattern limit](https://developers.cloudflare.com/d1/platform/limits/). Case matching remains ASCII case-insensitive; non-ASCII characters remain case-sensitive. Long patterns with `_`, internal `%`, or repeated `%` return code 400 rather than being truncated or changing meaning. As before, falsy filter values (including empty strings, `null`, `false`, and `0`) are ignored. Active filters must be strings without NUL characters; otherwise they return code 400. The isolated mytada endpoint returns HTTP 400 for these invalid patterns; the legacy public API uses its existing error envelope. New filters require `ownerEmail`; legacy admin requests using only existing fields preserve their existing behavior.

The response remains `{code:200,message:"success",data:[...]}`. Scoped rows include all previous fields plus `messageId`, `inReplyTo`, `relation` (stored References header), `recipient` (existing JSON string), and `attachments`. Attachment metadata is `{attId,filename,mimeType,size,disposition,contentId,type}` and contains no storage keys or URLs. `emailId` is a database ID; the unchanged `/api/public/sendEmail` response contains an RFC `messageId`.

## Download an owned attachment

`POST /api/public/attachment`, with the same Authorization token:

```json
{"ownerEmail":"u12345678@mazeai.pro","emailId":123,"attId":456}
```

The email and attachment must belong to the exact account/user; deleted emails and inactive attachment records are rejected. Success returns binary data from the existing configured storage backend with its content headers. No caller-supplied URL or storage key is accepted. Errors use the existing `{code,message}` envelope (the public API convention uses the JSON code, not necessarily an HTTP error status).

## Local verification

From `mail-worker`, run `node node_modules/vitest/vitest.mjs run --config vitest.unit.config.js` (or `pnpm test:unit`). Tests use Wrangler's already-installed Miniflare D1 runtime and do not access deployed services. The Cloudflare worker-pool starter test remains in the separate `vitest.config.js` suite.

## Sender profile (local implementation, not deployed)

`POST /api/public/mailboxProfile` accepts exactly `{ownerEmail, externalKey}`.
`POST /api/public/updateMailboxProfile` accepts exactly `{ownerEmail, externalKey, displayName}`.
Both are included in the isolated mytada service-token route allowlist and use the same Authorization header as existing managed endpoints. The address and `tada:<scope>:<UUID>` key must identify the same active account and user; mismatches fail closed. Missing mailboxes return 404 without creating anything. Unknown fields are rejected.

Success returns `{code:200,message:"success",data:{address,displayName}}`. Updates trim whitespace, require 1–40 Unicode codepoints, and reject control/surrogate characters and line separators. The only persisted change is `account.name`; the response comes from the updated row. Account IDs, email, external key, user nickname, creation defaults and historical messages do not change. Public and signed-in send paths safely quote display-name phrases (including Chinese and quotes) for Resend; unsafe pre-existing names fail before external sending. Changes apply to future sends only.
