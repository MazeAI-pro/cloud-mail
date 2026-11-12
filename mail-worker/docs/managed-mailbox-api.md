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

## Address rename replacement (local implementation; no migration/deployment yet)

The previous sender-name editor is removed: `updateMailboxProfile` is removed. `POST /api/public/mailboxProfile` accepts exactly `{externalKey}` and performs a noncreating lookup. It returns `{provisioned,address,pendingOperation,renameUsed,canEditAddress}`. Pending operations contain `{operationId,expectedAddress,address}`. `renameUsed` is the durable lifetime usage state. `canEditAddress` requires both explicit migrations, an unused lifetime allowance and `MAILBOX_ADDRESS_EDIT_ENABLED=true`; default is disabled.

`POST /api/public/renameMailbox` accepts exactly `{externalKey,expectedAddress,newLocalPart,operationId}`. The operation ID is a caller-generated UUID retained across retries. The prefix is trimmed/lowercased and must contain 3–32 ASCII letters/digits/dot/underscore/hyphen, begin and end with alphanumeric, and contain no consecutive dots. Administrative names and the generated `u` plus 8-digit namespace are reserved. Only `mytada.ai` supports this operation. The service token and exact active external-key/current-address pair are required. Reusing an operation ID for different arguments conflicts. Each immutable external key may successfully rename only once ever, including across callers. Default allocation does not consume the allowance. A committed rename consumes it immediately even while Account synchronization is pending; finalization never restores it. Same-operation retries remain idempotent after finalization. Failed transactions consume nothing.

Apply `migrations/0001_managed_address_changes.sql`, then `migrations/0002_managed_address_lifetime.sql` explicitly after all readers are compatible; runtime code never executes DDL. A single operation insertion triggers the atomic account.email/user.email change, retirement reservation, and default sender-name follow-up (only when name equals the previous local part). The additive lifetime migration backfills every identity with prior operation history (including finalized and multiple legacy changes), retaining all audit rows. A primary-key lifetime claim and insert trigger enforce one winner atomically even for concurrent operations; claims cannot be updated or deleted. User/account IDs, external key, custom names, and historical message/attachment fields are unchanged. Retired addresses cannot be assigned through any account/user INSERT or email UPDATE, including bootstrap, registration and automatic mailbox creation. Inbound mail is rejected before catch-all and forwarding; internal delivery skips retired recipients. Retirement remains enforced when editing is disabled.

After Maze Account CAS confirms the new binding, the trusted caller invokes `POST /api/public/finalizeMailboxRename` with `{externalKey,operationId,address}`. The record is retained for idempotency. Profile reads expose existing pending operations for recovery but never rename or provision. A read-only sqlite_master probe makes pre-migration reads work without querying missing tables. The lifetime extension is implemented and tested locally; neither migration nor deployment nor any real-address change has been performed. Deployment order: compatible Cloud Mail/Account/Tada readers, explicit schema migrations, then enable edits; do not enable a preview writer against shared data before production readers are compatible. Never drop retirement or operation data on rollback.
