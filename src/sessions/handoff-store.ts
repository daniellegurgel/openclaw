/**
 * Persistent store for active handoff entries.
 *
 * State file: ~/.openclaw/state/handoff.json
 *
 * The store is global (not per-agent) because a handoff pauses a phone number
 * regardless of which agent would normally handle it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { HandoffEntry, HandoffStoreData } from "../config/types.handoff.js";
import { normalizeE164 } from "../utils.js";

const STORE_FILENAME = "handoff.json";

function resolveHandoffStorePath(): string {
  return path.join(resolveStateDir(), "state", STORE_FILENAME);
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

function loadStore(): HandoffStoreData {
  const storePath = resolveHandoffStorePath();
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw) as HandoffStoreData;
    if (parsed && Array.isArray(parsed.entries)) {
      const now = Date.now();
      parsed.entries = parsed.entries.filter((e) => e.expiresAt > now);
      return parsed;
    }
  } catch {
    // File missing or invalid — return empty store.
  }
  return { entries: [] };
}

async function saveStore(store: HandoffStoreData): Promise<void> {
  const storePath = resolveHandoffStorePath();
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);

  if (process.platform === "win32") {
    await fs.promises.writeFile(storePath, json, "utf-8");
  } else {
    // Atomic write: temp file → rename.
    const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fs.promises.rename(tmp, storePath);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a phone number is currently under active handoff (paused).
 * Returns the matching entry or `undefined`.
 */
export function isHandoffActive(senderE164: string): HandoffEntry | undefined {
  const normalized = normalizeE164(senderE164);
  const now = Date.now();
  return loadStore().entries.find(
    (e) => normalizeE164(e.number) === normalized && e.expiresAt > now,
  );
}

/**
 * Activate handoff for a phone number.
 * If already active, resets the timer.
 */
export async function activateHandoff(
  number: string,
  activatedBy: string,
  durationMinutes: number,
): Promise<HandoffEntry> {
  const normalized = normalizeE164(number);
  const store = loadStore();
  // Remove existing entry for same number (reset timer).
  store.entries = store.entries.filter((e) => normalizeE164(e.number) !== normalized);

  const now = Date.now();
  const entry: HandoffEntry = {
    number: normalized,
    activatedBy,
    activatedAt: now,
    expiresAt: now + durationMinutes * 60 * 1000,
  };
  store.entries.push(entry);
  await saveStore(store);
  return entry;
}

/**
 * Deactivate handoff for a phone number.
 * Returns `true` if an active entry was found and removed.
 */
export async function deactivateHandoff(number: string): Promise<boolean> {
  const normalized = normalizeE164(number);
  const store = loadStore();
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => normalizeE164(e.number) !== normalized);
  if (store.entries.length < before) {
    await saveStore(store);
    return true;
  }
  return false;
}

/**
 * List all currently active (non-expired) handoff entries.
 */
export function listActiveHandoffs(): HandoffEntry[] {
  return loadStore().entries;
}
