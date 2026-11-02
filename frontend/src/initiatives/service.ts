import { INITIAL_INITIATIVES } from "./mockData";
import { Initiative } from "./types";

const STORAGE_KEY = "ai-harness.initiatives.v2";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function read(): Initiative[] {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return clone(INITIAL_INITIATIVES);
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed as Initiative[] : clone(INITIAL_INITIATIVES);
  } catch {
    return clone(INITIAL_INITIATIVES);
  }
}

function write(items: Initiative[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

async function pause(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 180));
}

export const initiativeService = {
  async list(): Promise<Initiative[]> {
    await pause();
    const items = read();
    if (!window.localStorage.getItem(STORAGE_KEY)) write(items);
    return clone(items);
  },
  async get(id: string): Promise<Initiative | null> {
    await pause();
    return clone(read().find((item) => item.initiative_id === id) ?? null);
  },
  async save(initiative: Initiative): Promise<Initiative> {
    await pause();
    const items = read();
    const index = items.findIndex((item) => item.initiative_id === initiative.initiative_id);
    if (index >= 0) items[index] = clone(initiative); else items.unshift(clone(initiative));
    write(items);
    return clone(initiative);
  },
  async reset(): Promise<Initiative[]> {
    await pause();
    const items = clone(INITIAL_INITIATIVES);
    write(items);
    return items;
  },
};

export function nextInitiativeId(items: Initiative[]): string {
  const maximum = items.reduce((max, item) => Math.max(max, Number(item.initiative_id.match(/(\d+)$/)?.[1] ?? 1023)), 1023);
  return `AI-INIT-${maximum + 1}`;
}
