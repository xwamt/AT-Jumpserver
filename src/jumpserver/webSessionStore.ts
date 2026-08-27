import type { JumpServerWebSessionStore } from './JumpServerClient';

/**
 * The subset of vscode.SecretStorage the web-session store needs, declared
 * structurally so nothing under src/jumpserver ever imports the vscode module
 * and the client stays testable with a plain in-memory object.
 */
export interface SecretKeyValueStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export function webSessionStoreKey(bastionId: string): string {
  return `jumpserver.webSession.${bastionId}`;
}

/**
 * Adapts SecretStorage into the client's per-bastion web-session store. What
 * flows through here is the serialized sessionid/csrftoken cookie pair - live
 * session credentials - which is exactly why they belong in SecretStorage
 * next to the password rather than in globalState.
 */
export function createWebSessionSecretStore(
  secrets: SecretKeyValueStore,
  bastionId: string
): JumpServerWebSessionStore {
  const key = webSessionStoreKey(bastionId);
  return {
    load: () => Promise.resolve(secrets.get(key)),
    save: (value) => Promise.resolve(secrets.store(key, value)),
    clear: () => Promise.resolve(secrets.delete(key))
  };
}
