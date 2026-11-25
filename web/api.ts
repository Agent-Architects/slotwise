// Thin client for /api/v1. The web UI uses nothing else.

let csrf = "";
export function setCsrf(t: string) {
  csrf = t;
}

export class ApiFail extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrf) headers["x-csrf-token"] = csrf;
  const res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error ?? {};
    const issues = e.details?.issues as { path: string; message: string }[] | undefined;
    const msg = issues?.length ? `${e.message}: ${issues.map((i) => `${i.path || "value"} ${i.message}`).join("; ")}` : (e.message ?? `Request failed (${res.status})`);
    throw new ApiFail(res.status, e.code ?? "error", msg, e.details);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>("POST", p, b);
export const patch = <T = any>(p: string, b: unknown) => api<T>("PATCH", p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>("PUT", p, b);
export const del = <T = any>(p: string) => api<T>("DELETE", p);
