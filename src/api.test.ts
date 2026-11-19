import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';

const fetchMock = vi.fn();

function respondWith(body: string) {
	fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
}

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	fetchMock.mockReset();
	vi.unstubAllGlobals();
});

describe('api.getStreamUrl', () => {
	const playlistUrl = 'https://api.somafm.com/groovesalad.pls';

	it('parses a CRLF playlist and ignores surrounding lines', async () => {
		respondWith(
			'[playlist]\r\nnumberofentries=1\r\nFile1=https://ice1.somafm.com/groovesalad-128-mp3\r\nTitle1=SomaFM\r\n',
		);
		await expect(api.getStreamUrl(playlistUrl)).resolves.toBe(
			'https://ice1.somafm.com/groovesalad-128-mp3',
		);
	});

	it('upgrades http streams on SomaFM hosts to https', async () => {
		respondWith('File1=http://ice2.somafm.com/groovesalad-128-mp3\n');
		await expect(api.getStreamUrl(playlistUrl)).resolves.toBe(
			'https://ice2.somafm.com/groovesalad-128-mp3',
		);
	});

	it('rejects a stream on a foreign host', async () => {
		respondWith('File1=https://evil.example/stream.mp3\n');
		await expect(api.getStreamUrl(playlistUrl)).rejects.toThrow('Untrusted URL host');
	});

	it('rejects look-alike hosts', async () => {
		respondWith('File1=https://notsomafm.com/stream.mp3\n');
		await expect(api.getStreamUrl(playlistUrl)).rejects.toThrow('Untrusted URL host');
	});

	it('rejects a playlist without any URL', async () => {
		respondWith('[playlist]\nnumberofentries=0\n');
		await expect(api.getStreamUrl(playlistUrl)).rejects.toThrow('Stream URL not found');
	});

	it('does not fetch a playlist from an untrusted host', async () => {
		await expect(api.getStreamUrl('https://evil.example/x.pls')).rejects.toThrow(
			'Untrusted URL host',
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects non-http(s) schemes', async () => {
		await expect(api.getStreamUrl('ftp://api.somafm.com/groovesalad.pls')).rejects.toThrow(
			'Untrusted URL host',
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('api.getChannelSongs', () => {
	it('encodes the channel id in the URL path', async () => {
		respondWith(JSON.stringify({ songs: [] }));
		await api.getChannelSongs('a/b?c');
		expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/songs\/a%2Fb%3Fc\.json$/);
	});

	it('throws on a non-2xx response', async () => {
		fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }));
		await expect(api.getChannelSongs('x')).rejects.toThrow('status 503');
	});
});
