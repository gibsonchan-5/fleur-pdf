/**
 * Secret storage — the API key lives in one of two places, picked by the user
 * through the `secretStorageMode` setting:
 *
 *   system (default) - the system keychain, via Obsidian's official
 *                      SecretStorage API (`app.secretStorage`, Obsidian 1.11.4+).
 *                      Never written to `data.json`, so the key never travels
 *                      with the vault (Obsidian Sync / iCloud / OneDrive).
 *   vault            - plain text inside `data.json`. The key then syncs with
 *                      the vault and is shared across devices, at the cost of
 *                      being stored in clear text.
 *
 * Everything here degrades gracefully: if SecretStorage is missing (older
 * Obsidian) the vault backend is used instead, so no key is ever lost.
 */

import type { App } from 'obsidian';

/** Settings fields that must never be persisted as plain text on the keychain backend. */
export const SECRET_FIELDS = ['apiKey'] as const;

export type SecretField = typeof SECRET_FIELDS[number];

/** Where a secret is kept. */
export type SecretBackend = 'system' | 'vault';

/**
 * Secret IDs. Obsidian requires lowercase alphanumeric characters with
 * optional dashes, and namespaces them per app internally.
 */
export const SECRET_IDS: Record<SecretField, string> = {
  apiKey: 'fleur-pdf-api-key',
};

interface SecretStorageLike {
  getSecret?(id: string): string | null | Promise<string | null>;
  setSecret?(id: string, secret: string): void | Promise<void>;
}

/**
 * Returns the SecretStorage object only when it looks usable, so a partially
 * featured or future implementation cannot break the plugin.
 */
function storageOf(app: App | null | undefined): SecretStorageLike | null {
  const storage = (app as unknown as { secretStorage?: SecretStorageLike } | null | undefined)
    ?.secretStorage;
  if (!storage) return null;
  if (typeof storage.getSecret !== 'function') return null;
  if (typeof storage.setSecret !== 'function') return null;
  return storage;
}

/** Whether the system keychain can be used at all on this build. */
export function secretStorageAvailable(app: App | null | undefined): boolean {
  return storageOf(app) !== null;
}

/**
 * Resolves the backend that is actually in effect.
 *
 * `system` is only honoured when the keychain exists; anything else (explicit
 * `vault`, a missing setting, older Obsidian) falls back to `vault`, which
 * keeps the key in `data.json` rather than losing it.
 */
export function resolveBackend(app: App | null | undefined, mode: unknown): SecretBackend {
  if (mode === 'vault') return 'vault';
  return secretStorageAvailable(app) ? 'system' : 'vault';
}

/** Reads a secret from the keychain. Returns '' when unset or unavailable. */
export async function readSecret(app: App | null | undefined, id: string): Promise<string> {
  const storage = storageOf(app);
  if (!storage?.getSecret) return '';
  try {
    // The API is synchronous today; Promise.resolve keeps this future-proof.
    const value = await Promise.resolve(storage.getSecret(id));
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * Writes a secret to the keychain and verifies it by reading it back.
 * Returns false when the write could not be confirmed.
 */
export async function writeSecret(
  app: App | null | undefined,
  id: string,
  value: string,
): Promise<boolean> {
  const storage = storageOf(app);
  if (!storage?.setSecret) return false;
  try {
    await Promise.resolve(storage.setSecret(id, value));
    const readBack = await readSecret(app, id);
    return readBack === value;
  } catch {
    return false;
  }
}

export interface HydrateSecretsResult {
  /** Whether the system keychain is usable on this build. */
  available: boolean;
  /** Backend actually in effect. */
  backend: SecretBackend;
  /** Fields that were still plain text and got moved into the keychain. */
  migrated: SecretField[];
  /** Fields that were restored from the keychain. */
  hydrated: SecretField[];
}

/**
 * Reconciles secrets across the keychain, the in-memory settings object and
 * whatever plain-text values are still on disk.
 *
 * On the keychain backend the keychain always wins; a plain-text value is only
 * taken as the source when the keychain has nothing for that field yet, in
 * which case it is promoted into the keychain.
 *
 * On the vault backend the file is the source of truth and nothing is written
 * to the keychain, so the plain-text value is simply kept in memory and will
 * be persisted again on the next save.
 *
 * @param settings In-memory settings object, mutated in place.
 * @param legacy   Raw persisted data, used to recover legacy copies.
 * @param backend  Backend in effect, see {@link resolveBackend}.
 */
export async function hydrateSecrets(
  app: App | null | undefined,
  settings: Record<string, unknown>,
  legacy?: Record<string, unknown> | null,
  backend: SecretBackend = 'system',
): Promise<HydrateSecretsResult> {
  const available = secretStorageAvailable(app);
  const keychainUsable = backend === 'system' && available;
  const migrated: SecretField[] = [];
  const hydrated: SecretField[] = [];

  for (const field of SECRET_FIELDS) {
    const id = SECRET_IDS[field];

    if (keychainUsable) {
      const stored = await readSecret(app, id);
      if (stored) {
        settings[field] = stored;
        hydrated.push(field);
        continue;
      }
    }

    const inSettings = typeof settings[field] === 'string' ? (settings[field] as string) : '';
    const onDisk = typeof legacy?.[field] === 'string' ? (legacy[field] as string) : '';
    const plain = inSettings || onDisk;
    if (!plain) continue;

    settings[field] = plain;
    if (!keychainUsable) continue;

    if (await writeSecret(app, id, plain)) migrated.push(field);
  }

  return { available, backend, migrated, hydrated };
}

/**
 * Builds the object that will actually be written to `data.json`.
 *
 * On the keychain backend every secret is pushed to the keychain first and is
 * only blanked from the returned copy once the keychain confirms it holds the
 * value. When the keychain is unavailable the plain-text value is kept, so
 * downgrading Obsidian never loses a key.
 *
 * On the vault backend the values are returned untouched — keeping them in
 * clear text is precisely what the user asked for.
 */
export async function scrubSecretsForPersistence(
  app: App | null | undefined,
  settings: Record<string, unknown>,
  backend: SecretBackend = 'system',
): Promise<Record<string, unknown>> {
  const persisted: Record<string, unknown> = { ...settings };

  if (backend === 'vault') return persisted;

  for (const field of SECRET_FIELDS) {
    const value = typeof settings[field] === 'string' ? (settings[field] as string) : '';
    if (!value) {
      persisted[field] = '';
      continue;
    }
    const stored = await writeSecret(app, SECRET_IDS[field], value);
    persisted[field] = stored ? '' : value;
  }

  return persisted;
}

export interface SecretMigrationResult {
  /** True when every non-empty secret reached the target backend. */
  ok: boolean;
  /** Fields carried over successfully. */
  moved: SecretField[];
  /** Fields whose move could not be confirmed (keychain write failed). */
  failed: SecretField[];
}

/**
 * Carries the current secrets over to `target` when the user switches the
 * storage location.
 *
 * Moving to the keychain is verified write-by-write; moving back to the file
 * needs no extra work here because the caller simply stops blanking the
 * fields. Empty values are skipped, which makes this safe to call repeatedly.
 */
export async function migrateSecrets(
  app: App | null | undefined,
  settings: Record<string, unknown>,
  target: SecretBackend,
): Promise<SecretMigrationResult> {
  const moved: SecretField[] = [];
  const failed: SecretField[] = [];

  for (const field of SECRET_FIELDS) {
    const value = typeof settings[field] === 'string' ? (settings[field] as string) : '';
    if (!value) continue;

    if (target === 'vault') {
      // Nothing to write: persistence keeps the value as-is from here on.
      moved.push(field);
      continue;
    }

    const ok = await writeSecret(app, SECRET_IDS[field], value);
    if (ok) moved.push(field);
    else failed.push(field);
  }

  return { ok: failed.length === 0, moved, failed };
}
