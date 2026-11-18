import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const CACHE_DIR = join(import.meta.dirname, "..", ".cache");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function getCachePath(key: string): string {
  return join(CACHE_DIR, `${hashKey(key)}.json`);
}

export function getCached<T>(key: string): T | null {
  const path = getCachePath(key);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, "utf-8");
    const entry: CacheEntry<T> = JSON.parse(content);

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      return null;
    }

    return entry.data;
  } catch {
    return null;
  }
}

export function setCache<T>(key: string, data: T, ttl: number = DEFAULT_TTL_MS): void {
  ensureCacheDir();

  const entry: CacheEntry<T> = {
    data,
    timestamp: Date.now(),
    ttl,
  };

  const path = getCachePath(key);
  writeFileSync(path, JSON.stringify(entry, null, 2));
}

export async function fetchWithCache(url: string, ttl?: number): Promise<string> {
  const cached = getCached<string>(url);
  if (cached !== null) {
    console.log(`  [cache hit] ${url}`);
    return cached;
  }

  console.log(`  [fetching] ${url}`);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const text = await response.text();
      setCache(url, text, ttl);
      return text;
    } catch (error) {
      lastError = error as Error;
      if (attempt < 2) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`  [retry ${attempt + 1}] waiting ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
