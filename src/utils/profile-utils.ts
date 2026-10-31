import { profileConfig } from "../config";
import type { LocalizedText } from "../types/config";

export type ProfileLocale = keyof LocalizedText;

export function getProfileLocale(pathname: string): ProfileLocale {
	return pathname === "/en" || pathname.startsWith("/en/") || pathname.startsWith("/posts/en-")
		? "en_US"
		: "zh_CN";
}

export function getLocalizedProfile(locale: ProfileLocale) {
	return {
		name: profileConfig.name[locale],
		bio: profileConfig.bio?.[locale] ?? "",
	};
}
