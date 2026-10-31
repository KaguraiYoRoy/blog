import { type CollectionEntry, getCollection } from "astro:content";
import { getCategoryDefinitions } from "@constants/categories";
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import { getCategoryUrl } from "@utils/url-utils.ts";

// // Retrieve posts and sort them by publication date
async function getRawSortedPosts(locale?: "zh_CN" | "en_US") {
	const allBlogPosts = await getCollection("posts", ({ data }) => {
		return (
			(import.meta.env.PROD ? data.draft !== true : true) &&
			(!locale || !data.lang || data.lang === locale)
		);
	});

	const sorted = allBlogPosts.sort((a, b) => {
		const dateA = new Date(a.data.published);
		const dateB = new Date(b.data.published);
		return dateA > dateB ? -1 : 1;
	});
	return sorted;
}

export async function getSortedPosts(locale?: "zh_CN" | "en_US") {
	const sorted = await getRawSortedPosts(locale);

	for (let i = 1; i < sorted.length; i++) {
		sorted[i].data.nextSlug = sorted[i - 1].slug;
		sorted[i].data.nextTitle = sorted[i - 1].data.title;
	}
	for (let i = 0; i < sorted.length - 1; i++) {
		sorted[i].data.prevSlug = sorted[i + 1].slug;
		sorted[i].data.prevTitle = sorted[i + 1].data.title;
	}

	return sorted;
}
export type PostForList = {
	slug: string;
	data: CollectionEntry<"posts">["data"];
};
export async function getSortedPostsList(
	locale?: "zh_CN" | "en_US",
): Promise<PostForList[]> {
	const sortedFullPosts = await getRawSortedPosts(locale);

	// delete post.body
	const sortedPostsList = sortedFullPosts.map((post) => ({
		slug: post.slug,
		data: post.data,
	}));

	return sortedPostsList;
}
export type Tag = {
	name: string;
	count: number;
};

export async function getTagList(locale?: "zh_CN" | "en_US"): Promise<Tag[]> {
	const allBlogPosts = await getCollection<"posts">("posts", ({ data }) => {
		return (
			(import.meta.env.PROD ? data.draft !== true : true) &&
			(!locale || !data.lang || data.lang === locale)
		);
	});

	const countMap: { [key: string]: number } = {};
	allBlogPosts.forEach((post: { data: { tags: string[] } }) => {
		post.data.tags.forEach((tag: string) => {
			if (!countMap[tag]) countMap[tag] = 0;
			countMap[tag]++;
		});
	});

	// sort tags
	const keys: string[] = Object.keys(countMap).sort((a, b) => {
		return a.toLowerCase().localeCompare(b.toLowerCase());
	});

	return keys.map((key) => ({ name: key, count: countMap[key] }));
}

export type Category = {
	name: string;
	count: number;
	url: string;
	children: Category[];
};

export async function getCategoryList(
	locale?: "zh_CN" | "en_US",
): Promise<Category[]> {
	const allBlogPosts = await getCollection<"posts">("posts", ({ data }) => {
		return (
			(import.meta.env.PROD ? data.draft !== true : true) &&
			(!locale || !data.lang || data.lang === locale)
		);
	});
	const postsByCategory = new Map<string, Set<string>>();
	const uncategorizedPosts = new Set<string>();
	allBlogPosts.forEach((post) => {
		const categories = post.data.categories.length
			? post.data.categories
			: post.data.category
				? [post.data.category]
				: [];

		if (categories.length === 0) {
			uncategorizedPosts.add(post.id);
			return;
		}

		for (const category of categories) {
			const categoryName = category.trim();
			if (!postsByCategory.has(categoryName))
				postsByCategory.set(categoryName, new Set());
			postsByCategory.get(categoryName)?.add(post.id);
		}
	});

	const definitions = getCategoryDefinitions(locale);
	const knownNames = new Set<string>();
	const ret: Category[] = [];

	for (const definition of definitions) {
		knownNames.add(definition.name);
		for (const child of definition.children ?? []) knownNames.add(child);

		const children = (definition.children ?? [])
			.filter((child) => postsByCategory.get(child)?.size)
			.map((child) => ({
				name: child,
				count: postsByCategory.get(child)?.size ?? 0,
				url: getCategoryUrl(child, locale),
				children: [],
			}));
		const parentPosts = new Set(postsByCategory.get(definition.name) ?? []);
		for (const child of children) {
			for (const postId of postsByCategory.get(child.name) ?? [])
				parentPosts.add(postId);
		}

		if (parentPosts.size > 0) {
			const descendants = children.map((child) => child.name);
			ret.push({
				name: definition.name,
				count: parentPosts.size,
				url: getCategoryUrl([definition.name, ...descendants], locale),
				children,
			});
		}
	}

	const unknown = [...postsByCategory.keys()]
		.filter((name) => !knownNames.has(name))
		.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	for (const name of unknown) {
		ret.push({
			name,
			count: postsByCategory.get(name)?.size ?? 0,
			url: getCategoryUrl(name, locale),
			children: [],
		});
	}

	const uncategorized = i18n(I18nKey.uncategorized, locale);
	if (uncategorizedPosts.size) {
		ret.push({
			name: uncategorized,
			count: uncategorizedPosts.size,
			url: getCategoryUrl(uncategorized, locale),
			children: [],
		});
	}

	return ret;
}
