import { describe, expect, it } from 'vitest';
import { createIcyDemuxer, parseStreamTitle, splitArtistSong } from '@/lib/icy-demuxer';

const encoder = new TextEncoder();

/** Builds the metadata block (length byte + zero-padded text) the way an Icecast server does. */
function metadataBlock(text: string | Uint8Array) {
	const bytes = typeof text === 'string' ? encoder.encode(text) : text;
	const units = Math.ceil(bytes.length / 16);
	const block = new Uint8Array(1 + units * 16);
	block[0] = units;
	block.set(bytes, 1);
	return block;
}

/** `audio` runs of `metaint` bytes (value = index of the run) separated by the given blocks. */
function buildStream(metaint: number, blocks: (Uint8Array | null)[]) {
	const parts: Uint8Array[] = [];
	const audio: number[] = [];
	blocks.forEach((block, index) => {
		const run = new Uint8Array(metaint).fill(index + 1);
		audio.push(...run);
		parts.push(run, block ?? new Uint8Array([0]));
	});
	const stream = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		stream.set(part, offset);
		offset += part.length;
	}
	return { stream, audio: Uint8Array.from(audio) };
}

function demux(metaint: number, chunks: Uint8Array[]) {
	const audio: number[] = [];
	const titles: { title: string; audioBefore: number }[] = [];
	const demuxer = createIcyDemuxer(metaint, {
		onAudio: (part) => audio.push(...part),
		onTitle: (title) => titles.push({ title, audioBefore: audio.length }),
	});
	for (const chunk of chunks) demuxer.push(chunk);
	return { audio: Uint8Array.from(audio), titles };
}

/** Deterministic pseudo-random split into chunks of 1..maxSize bytes. */
function split(stream: Uint8Array, seed: number, maxSize: number) {
	let state = seed;
	const next = () => (state = (state * 1_664_525 + 1_013_904_223) % 2 ** 32) / 2 ** 32;
	const chunks: Uint8Array[] = [];
	for (let position = 0; position < stream.length;) {
		const size = 1 + Math.floor(next() * maxSize);
		chunks.push(stream.subarray(position, position + size));
		position += size;
	}
	return chunks;
}

describe('createIcyDemuxer', () => {
	const metaint = 100;
	const blocks = [
		metadataBlock("StreamTitle='First - Song';StreamUrl='';"),
		null, // no change
		metadataBlock("StreamTitle='Second - Song';"),
	];
	const { stream, audio } = buildStream(metaint, blocks);

	it('separates audio from metadata in one piece', () => {
		const result = demux(metaint, [stream]);
		expect(result.audio).toEqual(audio);
		expect(result.titles).toEqual([
			{ title: 'First - Song', audioBefore: metaint },
			{ title: 'Second - Song', audioBefore: metaint * 3 },
		]);
	});

	it('gives the same result for byte-by-byte delivery', () => {
		const chunks = Array.from(stream, (byte) => Uint8Array.of(byte));
		const result = demux(metaint, chunks);
		expect(result.audio).toEqual(audio);
		expect(result.titles.map((item) => item.title)).toEqual(['First - Song', 'Second - Song']);
	});

	it.each([1, 2, 3, 4, 5, 6, 7, 8])(
		'is independent of how the network splits the stream (fuzz, seed %i)',
		(seed) => {
			const result = demux(metaint, split(stream, seed, 150));
			expect(result.audio).toEqual(audio);
			expect(result.titles).toEqual([
				{ title: 'First - Song', audioBefore: metaint },
				{ title: 'Second - Song', audioBefore: metaint * 3 },
			]);
		},
	);

	it('handles a chunk that ends exactly at the audio/metadata boundaries', () => {
		const firstRunEnd = metaint;
		const chunks = [
			stream.subarray(0, firstRunEnd), // exactly the audio run
			stream.subarray(firstRunEnd, firstRunEnd + 1), // exactly the length byte
			stream.subarray(firstRunEnd + 1),
		];
		const result = demux(metaint, chunks);
		expect(result.titles[0]).toEqual({ title: 'First - Song', audioBefore: metaint });
		expect(result.audio).toEqual(audio);
	});

	it('does not report an empty block (no change)', () => {
		const { stream: quiet } = buildStream(metaint, [null, null]);
		expect(demux(metaint, [quiet]).titles).toEqual([]);
	});

	it('ignores metadata without StreamTitle', () => {
		const { stream: other } = buildStream(metaint, [metadataBlock("StreamUrl='http://x';")]);
		expect(demux(metaint, [other]).titles).toEqual([]);
	});

	it('handles the maximum block size (255 units)', () => {
		const title = 'x'.repeat(255 * 16 - 20);
		const { stream: big } = buildStream(metaint, [metadataBlock(`StreamTitle='${title}';`)]);
		expect(demux(metaint, split(big, 3, 700)).titles[0].title).toBe(title);
	});

	it('decodes multi-byte UTF-8 even when a character is split across chunks', () => {
		const { stream: utf } = buildStream(metaint, [metadataBlock("StreamTitle='Björk - Jóga';")]);
		for (let cut = 1; cut < utf.length; cut++) {
			const result = demux(metaint, [utf.subarray(0, cut), utf.subarray(cut)]);
			expect(result.titles[0].title).toBe('Björk - Jóga');
		}
	});

	it('falls back to windows-1252 for stations that do not send UTF-8', () => {
		// "Café" with the single byte 0xE9, which is invalid UTF-8.
		const bytes = Uint8Array.from([
			...encoder.encode("StreamTitle='Caf"),
			0xe9,
			...encoder.encode("';"),
		]);
		const { stream: latin } = buildStream(metaint, [metadataBlock(bytes)]);
		expect(demux(metaint, [latin]).titles[0].title).toBe('Café');
	});

	it('rejects an invalid metaint', () => {
		const handlers = {
			onAudio: () => {
				/* ignored */
			},
			onTitle: () => {
				/* ignored */
			},
		};
		for (const value of [0, -1, 1.5, Number.NaN, 2 ** 30]) {
			expect(() => createIcyDemuxer(value, handlers)).toThrow(RangeError);
		}
	});
});

describe('parseStreamTitle', () => {
	it.each([
		["StreamTitle='Artist - Song';", 'Artist - Song'],
		["StreamTitle='Artist - Song';StreamUrl='';", 'Artist - Song'],
		["StreamTitle='';StreamUrl='';", ''],
		["StreamTitle='Don't Stop - It's Me';", "Don't Stop - It's Me"],
		["StreamTitle='Say 'hi'; ok';StreamUrl='http://x';", "Say 'hi'; ok"],
		["StreamTitle='no terminator", 'no terminator'],
		["StreamUrl='x';StreamTitle='After';", 'After'],
	])('parses %s', (metadata, expected) => {
		expect(parseStreamTitle(metadata)).toBe(expected);
	});

	it('returns undefined when there is no StreamTitle', () => {
		expect(parseStreamTitle("StreamUrl='x';")).toBeUndefined();
		expect(parseStreamTitle('')).toBeUndefined();
	});
});

describe('splitArtistSong', () => {
	it.each([
		['Artist - Song', 'Artist', 'Song'],
		['Artist - Song - Remix', 'Artist', 'Song - Remix'],
		['Just a title', '', 'Just a title'],
		['  Spaced   -   Out  ', 'Spaced', 'Out'],
		['', '', ''],
	])('splits "%s"', (input, artist, song) => {
		expect(splitArtistSong(input)).toEqual({ artist, song });
	});
});
