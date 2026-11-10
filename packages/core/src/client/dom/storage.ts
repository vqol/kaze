import { KazeClient } from "@client/index";
import { Object_keys, Reflect_get, Reflect_ownKeys } from "@/shared/snapshot";

export default function (client: KazeClient, self: Self) {
	// the separator matters: "a.com" must not claim keys that belong to "a.com.evil"
	// about:blank / srcdoc frames share their creator's storage, so key on the
	// inherited origin and not on their own (empty) host
	const prefix = () => client.meta.origin.host + "@";
	const ownedKeys = (target: Storage) =>
		Object_keys(target).filter((key) => key.startsWith(prefix()));

	const handler: ProxyHandler<Storage> = {
		get(target, prop) {
			switch (prop) {
				case "getItem":
					return (key: string) => {
						return target.getItem(prefix() + key);
					};

				case "setItem":
					return (key: string, value: string) => {
						return target.setItem(prefix() + key, value);
					};

				case "removeItem":
					return (key: string) => {
						return target.removeItem(prefix() + key);
					};

				case "clear":
					return () => {
						// collect first: removing while enumerating shifts the keys
						for (const key of ownedKeys(target)) {
							target.removeItem(key);
						}
					};

				case "key":
					return (index: number) => {
						// WebIDL unsigned long: coerce, anything out of range is null
						const key = ownedKeys(target)[Number(index) >>> 0];
						return key === undefined ? null : key.slice(prefix().length);
					};

				case "length":
					return ownedKeys(target).length;

				default:
					if (prop in Object.prototype || typeof prop === "symbol") {
						return Reflect_get(target, prop);
					}

					// a missing key reads as undefined as a property, null only
					// from getItem()
					return target.getItem(prefix() + (prop as string)) ?? undefined;
			}
		},

		deleteProperty(target, prop) {
			if (typeof prop === "symbol") return Reflect.deleteProperty(target, prop);
			target.removeItem(prefix() + prop);

			return true;
		},

		set(target, prop, value) {
			target.setItem(prefix() + (prop as string), value);

			return true;
		},

		has(target, prop) {
			return target.getItem(prefix() + (prop as string)) !== null;
		},

		ownKeys(target) {
			return Reflect_ownKeys(target)
				.filter((f) => typeof f === "string" && f.startsWith(prefix()))
				.map((f) =>
					typeof f === "string" ? f.substring(prefix().length) : f
				);
		},

		getOwnPropertyDescriptor(target, property) {
			// TODO: probably not right
			if (
				target.getItem(prefix() + (property as string)) === null
			) {
				return undefined;
			}

			return {
				value: target.getItem(prefix() + (property as string)),
				enumerable: true,
				configurable: true,
				writable: true,
			};
		},

		defineProperty(target, property, attributes) {
			target.setItem(
				prefix() + (property as string),
				attributes.value
			);

			return true;
		},
	};

	const localStorageProxy = new Proxy(self.localStorage, handler);
	const sessionStorageProxy = new Proxy(self.sessionStorage, handler);

	delete self.localStorage;
	delete self.sessionStorage;

	self.localStorage = localStorageProxy;
	self.sessionStorage = sessionStorageProxy;
}
