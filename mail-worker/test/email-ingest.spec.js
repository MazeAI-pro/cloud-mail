import { describe, expect, it } from 'vitest';
import { emailConst, settingConst } from '../src/const/entity-const';
import { readMessageRaw, resolveReceiveStatus } from '../src/email/email';
import r2Service from '../src/service/r2-service';

function streamFromParts(parts) {
	return new ReadableStream({
		start(controller) {
			for (const part of parts) {
				controller.enqueue(part);
			}
			controller.close();
		},
	});
}

describe('inbound email ingest', () => {
	it('reads raw email bytes without text-decoding binary data', async () => {
		const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x00, 0x80, 0x0a]);

		const raw = await readMessageRaw({
			raw: streamFromParts([pdfBytes.slice(0, 4), pdfBytes.slice(4)]),
		});

		expect(Array.from(new Uint8Array(raw))).toEqual(Array.from(pdfBytes));
	});

	it('allows the people hire mailbox to receive without a local account', () => {
		expect(resolveReceiveStatus({
			account: null,
			noRecipient: settingConst.noRecipient.CLOSE,
			shouldForwardToPeople: true,
		})).toEqual({ rejectReason: null, status: emailConst.status.NOONE });
	});

	it('serves attachment downloads from the active R2 storage backend', async () => {
		const objectBytes = new Uint8Array([1, 2, 3, 4]);
		const response = await r2Service.toObjResp({
			env: {
				domain: ['mazeai.pro'],
				kv: {
					get: async () => ({
						bucket: '',
						endpoint: '',
						s3AccessKey: '',
						s3SecretKey: '',
						resendTokens: '{}',
						emailPrefixFilter: '',
					}),
				},
				r2: {
					get: async (key) => {
						expect(key).toBe('attachments/resume.pdf');
						return {
							body: objectBytes,
							httpMetadata: {
								contentType: 'application/pdf',
								contentDisposition: 'attachment;filename=resume.pdf',
							},
						};
					},
				},
			},
		}, 'attachments/resume.pdf');

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/pdf');
		expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(objectBytes));
	});
});
