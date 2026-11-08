// Persisted cookie jar, shared by the page thread and the fetch worker.
type PersistedCookieState = {
	updatedAt: number;
	cookies: string;
};

const COOKIE_DB_NAME = "__kaze_controller";
const COOKIE_STORE_NAME = "state";
const COOKIE_STATE_KEY = "cookies";
export const BROADCASTCHANNEL_NAME = "__kaze_controller_channel";

let cookieDbPromise: Promise<IDBDatabase> | null = null;

function parsePersistedCookieState(
	value: unknown
): PersistedCookieState | null {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as PersistedCookieState).updatedAt !== "number" ||
		!Number.isFinite((value as PersistedCookieState).updatedAt) ||
		typeof (value as PersistedCookieState).cookies !== "string"
	) {
		return null;
	}

	return value as PersistedCookieState;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});
}

function openCookieDatabase(): Promise<IDBDatabase> {
	if (cookieDbPromise) {
		return cookieDbPromise;
	}

	cookieDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(COOKIE_DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(COOKIE_STORE_NAME)) {
				db.createObjectStore(COOKIE_STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("Failed to open cookie database"));
	});

	return cookieDbPromise;
}

export async function readCookieState(): Promise<PersistedCookieState | null> {
	try {
		const db = await openCookieDatabase();
		const transaction = db.transaction(COOKIE_STORE_NAME, "readonly");
		const store = transaction.objectStore(COOKIE_STORE_NAME);
		const value = await requestToPromise(store.get(COOKIE_STATE_KEY));
		await transactionToPromise(transaction);
		return parsePersistedCookieState(value);
	} catch (error) {
		console.error("Failed to read persisted controller cookies:", error);
		return null;
	}
}

export async function writeCookieState(
	cookies: string,
	currentUpdatedAt: number
): Promise<number> {
	try {
		const db = await openCookieDatabase();
		const transaction = db.transaction(COOKIE_STORE_NAME, "readwrite");
		const store = transaction.objectStore(COOKIE_STORE_NAME);
		const existing = parsePersistedCookieState(
			await requestToPromise(store.get(COOKIE_STATE_KEY))
		);
		const updatedAt = Math.max(
			Date.now(),
			currentUpdatedAt + 1,
			(existing?.updatedAt ?? 0) + 1
		);
		const state: PersistedCookieState = {
			updatedAt,
			cookies,
		};
		store.put(state, COOKIE_STATE_KEY);
		await transactionToPromise(transaction);
		return updatedAt;
	} catch (error) {
		console.error("Failed to persist controller cookies:", error);
		return currentUpdatedAt;
	}
}
