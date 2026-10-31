export type CategoryDefinition = {
	name: string;
	children?: readonly string[];
};

const categoryDefinitions = {
	zh_CN: [
		{ name: "Android" },
		{ name: "运维" },
		{ name: "NAS" },
		{ name: "开发" },
		{ name: "网络技术" },
		{
			name: "专题向研究",
			children: ["DN42", "个人ISP", "CTF", "Kubernetes"],
		},
		{ name: "网络安全" },
		{ name: "奇思妙想" },
		{ name: "物联网" },
	],
	en_US: [
		{ name: "Android" },
		{ name: "Ops" },
		{ name: "NAS" },
		{ name: "Develop" },
		{ name: "Network" },
		{
			name: "Projects",
			children: ["DN42", "One Man ISP", "CTF", "Kubernetes"],
		},
		{ name: "Cybersecurity" },
		{ name: "Brain Dumps" },
		{ name: "IoT" },
	],
} as const satisfies Record<"zh_CN" | "en_US", readonly CategoryDefinition[]>;

export function getCategoryDefinitions(
	locale: "zh_CN" | "en_US" = "zh_CN",
): readonly CategoryDefinition[] {
	return categoryDefinitions[locale];
}
