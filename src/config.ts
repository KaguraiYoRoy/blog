import type {
	ExpressiveCodeConfig,
	LicenseConfig,
	NavBarConfig,
	ProfileConfig,
	SiteConfig,
} from "./types/config";
import { LinkPreset } from "./types/config";

export const siteConfig: SiteConfig = {
	title: "悠笙の开发日记",
	icp: "皖ICP备2025072622号-1", // Leave empty to hide the ICP registration in the footer.
	umami: {
		enable: true,
		src: "https://analytics.iyoroy.cn/script.js",
		websiteId: "2931abea-9a02-4a63-a98f-4715f44e3413",
		domains: ["blog.iyoroy.cn", "www.iyoroy.cn"],
	},
	lang: "zh_CN",
	themeColor: {
		hue: 0, // Theme hue.
		fixed: false, // Hide the theme color picker for visitors
	},
	banner: {
		enable: false,
		src: "/favicon.png", // Relative to the /src directory. Relative to the /public directory if it starts with '/'
		position: "center", // Equivalent to object-position, only supports 'top', 'center', 'bottom'. 'center' by default
		credit: {
			enable: false, // Display the credit text of the banner image
			text: "", // Credit text to be displayed
			url: "", // (Optional) URL link to the original artwork or artist's page
		},
	},
	toc: {
		enable: true, // Display the table of contents on the right side of the post
		depth: 2, // Maximum heading depth to show in the table, from 1 to 3
	},
	favicon: [
		{
			src: "/favicon-128.png",
			sizes: "128x128",
		},
	],
};

export const navBarConfig: NavBarConfig = {
	links: [
		LinkPreset.Home,
		LinkPreset.Archive,
		LinkPreset.About,
		{
			name: "友链",
			url: "/friends/",
		},
		{
			name: "DN42",
			url: "/dn42/",
		},
	],
};

export const profileConfig: ProfileConfig = {
	avatar: "assets/images/profile-avatar.png",
	name: {
		zh_CN: "神楽悠笙",
		en_US: "Kagura iYoRoy",
	},
	bio: {
		zh_CN: "愿世间万物都能被温柔以待",
		en_US: "May all things in the world be treated with tenderness.",
	},
	links: [
		{
			name: "GitHub",
			icon: "fa6-brands:github",
			url: "https://github.com/KaguraiYoRoy",
		},
		{
			name: "Email",
			icon: "fa6-solid:envelope",
			url: "mailto:i@iyoroy.cn",
		},
	],
};

export const licenseConfig: LicenseConfig = {
	enable: false,
	name: "CC BY-NC-SA 4.0",
	url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
};

export const expressiveCodeConfig: ExpressiveCodeConfig = {
	// Note: Some styles (such as background color) are being overridden, see the astro.config.mjs file.
	// Please select a dark theme, as this blog theme currently only supports dark background color
	theme: "github-dark",
};
