import { resolveLocation } from "./location";
import { coach } from "./telegram";

/** Home by default; a location shared on Telegram overrides it for a while (see location.ts). */
export async function currentLocation(env: Env) {
  const { home, last } = await coach(env).getRouteSettings();
  return resolveLocation(home, last);
}

export async function weatherLocation(env: Env) {
  return (await currentLocation(env))?.point ?? null;
}
