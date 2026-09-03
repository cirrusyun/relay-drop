export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(data?.error || `请求失败（${response.status}）`, response.status);
  }
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}
