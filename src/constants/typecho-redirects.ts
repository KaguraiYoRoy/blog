const postIds = [
	7, 8, 15, 23, 26, 28, 31, 35, 38, 42, 43, 52, 58, 84, 103, 112, 117, 118, 132,
	181, 182, 207, 208, 226, 231, 233, 238, 245, 252, 260, 261, 265, 278, 279, 305,
	309,
];

// Only migrated posts had Typecho URLs; new Astro posts do not need aliases.
export const typechoPostRedirects = Object.fromEntries(
	postIds.flatMap((id) => [
		[`/archives/${id}/`, `/posts/${id}/`],
		[`/en/archives/${id}/`, `/posts/en-${id}/`],
	]),
);

export const typechoPageRedirects = Object.fromEntries(
	["about", "friends", "privacy", "dn42"].flatMap((slug) =>
		["", "/en"].map((prefix) => [
			`${prefix}/${slug}.html`,
			`${prefix}/${slug}/`,
		]),
	),
);
