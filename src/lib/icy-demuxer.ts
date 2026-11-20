/**
 * ICY ("Shoutcast/Icecast") in-stream metadata.
 *
 * A stream requested with `Icy-MetaData: 1` is answered with an `icy-metaint: N` header and then
 * interleaves: N bytes of audio, one length byte L (metadata size = L * 16), L * 16 bytes of
 * metadata (zero-padded text such as `StreamTitle='Artist - Song';`), N bytes of audio, ...
 * A length byte of 0 means "no change".
 */

const MAX_METAINT = 1 << 20;
// The length byte is one byte and counts 16-byte units.
const METADATA_UNIT = 16;

interface IcyHandlers {
	/**
	 * A piece of pure audio, in stream order. It is a view into the pushed chunk: copy it
	 * (or use it synchronously) if it must outlive the `push()` call.
	 */
	onAudio: (audio: Uint8Array) => void;
	/** `StreamTitle` of a metadata block, in stream order relative to `onAudio` calls. */
	onTitle: (streamTitle: string) => void;
}

interface IcyDemuxer {
	push: (chunk: Uint8Array) => void;
}

/** UTF-8 first; some stations still send windows-1252, which is not valid UTF-8 for accents. */
function decodeMetadata(bytes: Uint8Array) {
	let end = bytes.length;
	while (end > 0 && bytes[end - 1] === 0) end--; // zero padding
	const text = bytes.subarray(0, end);
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(text);
	} catch {
		return new TextDecoder('windows-1252').decode(text);
	}
}

/** Extracts the value of `StreamTitle='…';` (the value may itself contain quotes). */
function parseStreamTitle(metadata: string): string | undefined {
	const marker = "StreamTitle='";
	const start = metadata.indexOf(marker);
	if (start === -1) return undefined;
	const valueStart = start + marker.length;
	// The value ends at the quote that precedes the next field (`;StreamUrl=`) or the last `';`.
	const nextField = metadata.indexOf("';", valueStart);
	if (nextField === -1) return metadata.slice(valueStart);
	let end = nextField;
	const afterTitle = /^';\s*[A-Za-z]+='/;
	for (;;) {
		if (afterTitle.test(metadata.slice(end)) || end + 2 >= metadata.trimEnd().length) break;
		const following = metadata.indexOf("';", end + 1);
		if (following === -1) break;
		end = following;
	}
	return metadata.slice(valueStart, end);
}

/** "Artist - Song" → `{ artist, song }`; without " - " the whole text is the song. */
function splitArtistSong(streamTitle: string) {
	const separator = streamTitle.indexOf(' - ');
	if (separator === -1) return { artist: '', song: streamTitle.trim() };
	return {
		artist: streamTitle.slice(0, separator).trim(),
		song: streamTitle.slice(separator + 3).trim(),
	};
}

function createIcyDemuxer(metaint: number, handlers: IcyHandlers): IcyDemuxer {
	if (!Number.isInteger(metaint) || metaint <= 0 || metaint > MAX_METAINT) {
		throw new RangeError(`Invalid icy-metaint: ${String(metaint)}`);
	}

	type Mode = 'audio' | 'length' | 'metadata';
	let mode: Mode = 'audio';
	let remaining = metaint; // bytes left in the current audio run or metadata block
	let metadata = new Uint8Array(0);
	let metadataFilled = 0;

	function push(chunk: Uint8Array) {
		let position = 0;
		while (position < chunk.length) {
			if (mode === 'audio') {
				const size = Math.min(remaining, chunk.length - position);
				handlers.onAudio(chunk.subarray(position, position + size));
				position += size;
				remaining -= size;
				if (remaining === 0) mode = 'length';
			} else if (mode === 'length') {
				const size = chunk[position++] * METADATA_UNIT;
				if (size === 0) {
					mode = 'audio';
					remaining = metaint;
				} else {
					mode = 'metadata';
					remaining = size;
					metadata = new Uint8Array(size);
					metadataFilled = 0;
				}
			} else {
				const size = Math.min(remaining, chunk.length - position);
				metadata.set(chunk.subarray(position, position + size), metadataFilled);
				metadataFilled += size;
				position += size;
				remaining -= size;
				if (remaining === 0) {
					const title = parseStreamTitle(decodeMetadata(metadata));
					if (title !== undefined) handlers.onTitle(title);
					mode = 'audio';
					remaining = metaint;
				}
			}
		}
	}

	return { push };
}

export { createIcyDemuxer, MAX_METAINT, parseStreamTitle, splitArtistSong };
export type { IcyDemuxer, IcyHandlers };
