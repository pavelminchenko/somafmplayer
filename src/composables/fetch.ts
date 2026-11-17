export interface FetchParams {
	url: string;
	headers?: HeadersInit;
	body?: BodyInit;
	method?: 'get' | 'post' | 'put' | 'delete' | 'patch';
	responseHandler?: 'arrayBuffer' | 'blob' | 'formData' | 'json' | 'text';
	signal?: AbortSignal;
}

export async function useFetch<T>({
	url,
	headers,
	body,
	method = 'get',
	responseHandler = 'json',
	signal,
}: FetchParams): Promise<T> {
	const response = await fetch(url, {
		headers,
		body,
		method: method.toUpperCase(),
		signal,
	});
	if (!response.ok) {
		throw new Error(`Request failed with status ${response.status}`);
	}
	return (await response[responseHandler]()) as T;
}
