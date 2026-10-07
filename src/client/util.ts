import { useEffect, useState } from 'react';

export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`wikiwow:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`wikiwow:${key}`, value);
    } catch {
      /* private mode: per-device conveniences only */
    }
  },
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { json?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.json !== undefined ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status);
  return data as T;
}

// -- toast ------------------------------------------------------------------

const TOAST_EVENT = 'wikiwow:toast';

export function toast(message: string) {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: message }));
}

export function useToast(): string | null {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let timer = 0;
    const onToast = (e: Event) => {
      setMsg((e as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = window.setTimeout(() => setMsg(null), 2600);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);
  return msg;
}

// -- routing ----------------------------------------------------------------

export function navigate(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export async function share(url: string, title: string) {
  if (navigator.share) {
    try {
      await navigator.share({ url, title });
      return;
    } catch {
      /* cancelled or unsupported: fall through to copy */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    toast(url);
  }
}

export function usePlayerName(): [string, (n: string) => void] {
  const [name, setName] = useState(() => store.get('name') || '');
  return [
    name,
    (n: string) => {
      setName(n);
      store.set('name', n.trim());
    },
  ];
}

/** True when keys would travel unencrypted to a non-local server. */
export function isPlainHttp(): boolean {
  return location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}
