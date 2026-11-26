'use client';

import { useSyncExternalStore } from 'react';

export interface ServiceStatus {
  name: string;
  url: string;
  displayUrl?: string;
  status: 'up' | 'down';
  latencyMs?: number;
  detail?: unknown;
  error?: string;
}

const POLL_INTERVAL_MS = 2000;
const EMPTY: readonly ServiceStatus[] = [];

// One polling loop and one last-good snapshot shared by every consumer, so the
// overview, the detail view and the sidebar never disagree and a failed fetch
// simply retries on the next tick instead of leaving a one-shot fetch empty.
let snapshot: readonly ServiceStatus[] = EMPTY;
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function notify(): void {
  for (const listener of subscribers) listener();
}

async function load(): Promise<void> {
  try {
    const res = await fetch('/api/services', { cache: 'no-store' });
    if (!res.ok) return;
    const data = (await res.json()) as { services?: unknown };
    if (Array.isArray(data.services)) {
      snapshot = data.services as ServiceStatus[];
    }
  } catch {
    // Keep the last good view; the next tick retries.
  } finally {
    notify();
  }
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  if (timer === null) {
    void load();
    timer = setInterval(() => void load(), POLL_INTERVAL_MS);
  }
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): readonly ServiceStatus[] {
  return snapshot;
}

function getServerSnapshot(): readonly ServiceStatus[] {
  return EMPTY;
}

/** Shared, retrying service-health feed for the overview, detail and sidebar. */
export function useServices(): readonly ServiceStatus[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
