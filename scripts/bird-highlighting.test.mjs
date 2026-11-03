import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRenderer } from "astro-expressive-code";

const grammar = JSON.parse(
	await readFile(
		new URL("../vendor/bird2/bird2.tmLanguage.json", import.meta.url),
		"utf8",
	),
);
const { ec } = await createRenderer({
	themes: ["github-dark"],
	shiki: { langs: [grammar], langAlias: { bird: "bird2" } },
});
const exportFunction = (
	await readFile(
		new URL("./fixtures/bird2-export.conf", import.meta.url),
		"utf8",
	)
).trimEnd();

function getCodeTokens(node) {
	if (
		node.type === "element" &&
		node.tagName === "span" &&
		node.properties?.style
	) {
		return [{ text: getText(node), style: node.properties.style }];
	}
	return (node.children ?? []).flatMap(getCodeTokens);
}

function getText(node) {
	return node.type === "text"
		? node.value
		: (node.children ?? []).map(getText).join("");
}

function getCodeLines(node) {
	if (node.properties?.className?.includes("ec-line")) {
		return [node];
	}
	return (node.children ?? []).flatMap(getCodeLines);
}

const code = [
	"# BIRD2 routing configuration",
	"protocol bgp upstream {",
	"    local as 4242422024;",
	"    neighbor fd18:3e15:61d0::1 as 4242423377;",
	"}",
	"function check_upstream() {",
	"    bgp_large_community.add((205369, 1, 1));",
	"    if bgp_path ~ [= 64512 =] then reject;",
	"    return true;",
	"}",
].join("\n");

for (const language of ["bird2", "bird"]) {
	test(`${language} highlights BIRD2 protocols, addresses, filters and communities`, async () => {
		const { renderedGroupAst } = await ec.render({ code, language });
		const tokens = getCodeTokens(renderedGroupAst);
		for (const expected of [
			"protocol",
			"4242422024",
			"fd18:3e15:61d0::1",
			"bgp_large_community",
			"bgp_path",
			"64512",
			"check_upstream",
		]) {
			assert.ok(
				tokens.some(({ text }) => text.includes(expected)),
				`Missing highlighted token: ${expected}`,
			);
		}
		const styleFor = (text) =>
			tokens.find((token) => token.text === text)?.style;
		assert.ok(styleFor("protocol"));
		assert.ok(styleFor("check_upstream"));
		assert.ok(styleFor("# BIRD2 routing configuration"));
		assert.notEqual(styleFor("protocol"), styleFor("check_upstream"));
		assert.notEqual(
			styleFor("protocol"),
			styleFor("# BIRD2 routing configuration"),
		);
	});

	test(`${language} preserves and highlights the complete export-control function`, async () => {
		const { renderedGroupAst } = await ec.render({
			code: exportFunction,
			language,
		});
		const lines = getCodeLines(renderedGroupAst);
		assert.equal(
			lines
				.map((line) => {
					const text = getText(line);
					return text === "\n" ? "" : text;
				})
				.join("\n"),
			exportFunction,
		);
		const tokens = getCodeTokens(renderedGroupAst);
		for (const expected of [
			"iana_apply_export",
			"int",
			"peer_as",
			"->",
			"bool",
			"COMM_FN_DENY_REGION",
			"bgp_large_community",
			"&&",
			"prepend",
			"COMM_FN_ATTACH_NO_ADVERTISE_OTHERS",
			"bgp_community",
			"add",
			"true",
		]) {
			assert.ok(
				tokens.some(({ text }) => text.includes(expected)),
				`Missing token: ${expected}`,
			);
		}
		const styleFor = (text) =>
			tokens.find((token) => token.text === text)?.style;
		assert.ok(styleFor("int"));
		assert.ok(styleFor("bool"));
		assert.equal(styleFor("int"), styleFor("bool"));
		assert.notEqual(styleFor("int"), styleFor("iana_apply_export"));
		for (const token of tokens.filter(({ text }) => text === "if")) {
			assert.equal(token.style, styleFor("then"));
		}
		for (const line of lines.filter((line) =>
			/bgp_path\.prepend|bgp_community\.add/.test(getText(line)),
		)) {
			const methodTokens = getCodeTokens(line);
			assert.ok(
				methodTokens.some(({ text }) => /^(prepend|add)$/.test(text)),
				`Method lost highlighting: ${getText(line)}`,
			);
		}
		assert.ok(
			getCodeTokens(lines.at(-2)).some(({ text }) => text === "return"),
		);
	});
}

test("nginx keeps its own syntax highlighting", async () => {
	const { renderedGroupAst } = await ec.render({
		code: "location /en/ {\n    try_files $uri $uri/ =404;\n}",
		language: "nginx",
	});
	const tokens = getCodeTokens(renderedGroupAst);
	assert.ok(tokens.some(({ text }) => text.includes("location")));
	assert.ok(new Set(tokens.map(({ style }) => style)).size > 1);
});
