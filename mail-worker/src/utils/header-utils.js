function asciiFallback(filename) {
	const fallback = (filename || 'attachment')
		.replace(/[^\x20-\x7E]/g, '_')
		.replace(/["\\]/g, '_')
		.trim();
	return fallback || 'attachment';
}

function encodeRFC5987Value(value) {
	return encodeURIComponent(value || 'attachment')
		.replace(/['()]/g, escape)
		.replace(/\*/g, '%2A');
}

function filenameFromDisposition(disposition) {
	if (!disposition) return null;
	const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i);
	if (!match?.[1]) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}

export function contentDisposition(type, filename) {
	const dispositionType = type === 'inline' ? 'inline' : 'attachment';
	const name = filename || 'attachment';
	return `${dispositionType}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeRFC5987Value(name)}`;
}

export function normalizeContentDisposition(disposition, fallbackType = 'attachment') {
	const type = disposition?.toLowerCase().startsWith('inline') ? 'inline' : fallbackType;
	return contentDisposition(type, filenameFromDisposition(disposition));
}
