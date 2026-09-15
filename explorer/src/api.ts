export async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`api/${endpoint}`, options);
  if (!response.ok) {
    const body = await response.json();
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

export const post = <T,>(endpoint: string, body: unknown) => request<T>(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
