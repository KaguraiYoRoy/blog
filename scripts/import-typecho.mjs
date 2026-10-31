import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [zhDump, enDump] = process.argv.slice(2);
if (!zhDump || !enDump) throw new Error("Usage: pnpm import-typecho <zh.sql.gz> <en.sql.gz>");

const zipUploads = path.resolve(root, "../migration-input/usr/uploads");
const postsRoot = path.join(root, "src/content/posts");
const downloadsRoot = path.join(root, "public/downloads");
const imageExtensions = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

function parseRows(sql, table) {
	const marker = `INSERT INTO \`typecho_${table}\` VALUES `;
	const start = sql.indexOf(marker);
	if (start < 0) return [];
	const rows = [];
	let row = [], token = "", depth = 0, quoted = false, escaped = false;
	for (const char of sql.slice(start + marker.length)) {
		if (quoted) {
			token += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "'") quoted = false;
			continue;
		}
		if (char === "'") { quoted = true; token += char; }
		else if (char === "(") { depth++; if (depth === 1) { row = []; token = ""; } else token += char; }
		else if (char === ")") { depth--; if (depth === 0) { row.push(token.trim()); rows.push(row); } else token += char; }
		else if (char === "," && depth === 1) { row.push(token.trim()); token = ""; }
		else if (depth > 0) token += char;
		else if (char === ";") break;
	}
	return rows;
}

function decode(token) {
	if (token === "NULL") return null;
	if (!token.startsWith("'")) return Number.isNaN(Number(token)) ? token : Number(token);
	return token.slice(1, -1).replace(/\\(.)/gs, (_, char) => ({ "0": "\0", b: "\b", n: "\n", r: "\r", t: "\t", Z: "\x1a" })[char] ?? char);
}

function objects(sql, table, columns) {
	return parseRows(sql, table).map((row) => Object.fromEntries(columns.map((key, index) => [key, decode(row[index])] )));
}

function quote(value) { return JSON.stringify(value ?? ""); }

function decodeHtmlEntities(text) {
	return text.replace(/&(?:amp|lt|gt|quot|apos|#39|#x[\da-f]+|#\d+);/gi, (entity) => {
		const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" };
		if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
		const numeric = entity.match(/^&#(?:x([\da-f]+)|(\d+));$/i);
		if (numeric) return String.fromCodePoint(Number.parseInt(numeric[1] ?? numeric[2], numeric[1] ? 16 : 10));
		return entity;
	});
}

function getAssetFiles() {
	if (!fs.existsSync(zipUploads)) throw new Error(`Missing ${zipUploads}; extract usr/uploads from the Typecho archive first.`);
	return new Set(fs.readdirSync(zipUploads, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(zipUploads, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")));
}

const assets = getAssetFiles();
function copyAttachment(uploadPath) {
	const relative = uploadPath.replace(/^\/+/, "");
	const source = path.join(zipUploads, relative);
	if (!assets.has(relative) || !fs.existsSync(source)) return null;
	const extension = path.extname(relative).toLowerCase();
	if (imageExtensions.has(extension)) return relative;
	const target = path.join(downloadsRoot, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(source, target);
	return `/downloads/${relative}`;
}

function relativeImage(fromFile, relative) {
	const imagePath = path.join("images", relative);
	const target = path.join(path.dirname(fromFile), imagePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const source = path.join(zipUploads, relative);
	if (!assets.has(relative) || !fs.existsSync(source)) return null;
	fs.copyFileSync(source, target);
	return `./${imagePath.split(path.sep).join("/")}`;
}

function transformOutsideCode(body, transform) {
	let fence = null;
	let regular = "";
	let code = "";
	let output = "";
	for (const line of body.split(/(?<=\n)/)) {
		const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (match) {
			const marker = match[1][0];
			if (!fence) {
				output += protectInlineCode(regular, transform);
				regular = "";
				fence = marker;
				code += line;
			} else {
				code += line;
				if (marker === fence) {
					output += code;
					code = "";
					fence = null;
				}
			}
		} else if (fence) code += line;
		else regular += line;
	}
	output += fence ? code : protectInlineCode(regular, transform);
	return output;
}

function protectInlineCode(text, transform) {
	const inline = [];
	const protectedText = text.replace(/(`+)[^`\n]*?\1/g, (match) => {
		const marker = `\u0000INLINE${inline.length}\u0000`;
		inline.push(match);
		return marker;
	});
	return transform(protectedText).replace(/\u0000INLINE(\d+)\u0000/g, (_, index) => inline[Number(index)]);
}

function replaceMedia(body, postFile) {
	return transformOutsideCode(body, (text) => text.replace(/(?:https?:\/\/[^/\s"'<>)]*)?\/?usr\/uploads\/([^\s"'<>)]*)/g, (match, raw) => {
		const relative = decodeURIComponent(raw.split(/[?#]/, 1)[0]).replace(/[\\.,]+$/, "");
		const extension = path.extname(relative).toLowerCase();
		if (imageExtensions.has(extension)) return relativeImage(postFile, relative) ?? match;
		return copyAttachment(relative) ?? match;
	}));
}

function convertJoeShortcodes(body) {
	return transformOutsideCode(body, (line) => line
		.replace(/\{alert type="(info|warning|success|danger|important)"\}/g, (_, type) => `:::${({ info: "note", warning: "warning", success: "tip", danger: "caution", important: "important" })[type]}`)
		.replace(/\{\/alert\}/g, ":::")
		.replace(/\{cloud\s+title="[^"]*"\s+type="github"\s+url="https:\/\/github\.com\/([^"/]+\/[^"/]+)"\s+password=""\s*\/\}/g, (_, repo) => `::github{repo="${repo}"}`)
		.replace(/\{copy\s+showText=(.*?)\s+copyText=(.*?)\s*\/\}/g, (_, showText) => {
			const value = showText.trim();
			const extension = path.extname(value.split(/[?#]/, 1)[0]).toLowerCase();
			if (imageExtensions.has(extension)) return `![${value}](${value})`;
			return `\`${value.replaceAll("`", "\\`")}\``;
		})
		.replace(/\{collapse\}/g, "")
		.replace(/\{collapse-item label="([^"]+)"\}/g, "\n**$1**\n")
		.replace(/\{\/collapse-item\}/g, "\n")
		.replace(/\{\/collapse\}/g, "")
		.replace(/\{tabs\}/g, "")
		.replace(/\{tabs-pane label="([^"]+)"\}/g, "\n### $1\n")
		.replace(/\{\/tabs-pane\}/g, "\n")
		.replace(/\{\/tabs\}/g, "")
		.replace(/\{timeline\}/g, "")
		.replace(/\{timeline-item(?:\s+color="[^"]+")?\}\s*([\s\S]*?)\s*\{\/timeline-item\}/g, (_, content) => `\n- ${content.trim()}\n`)
		.replace(/\{\/timeline\}/g, ""))
		.replace(/^(\s*`{3,})zone(?=\s|$)/gm, "$1text")
		.replace(/^(\s*`{3,})conf(?=\s|$)/gm, "$1ini")
		.replace(/^(\s*`{3,})ninja(?=\s|$)/gm, "$1makefile");
}

function extractTitle(text) {
	const heading = text.match(/^#\s+(.+)$/m);
	return heading?.[1]?.trim() || "";
}

function importDatabase(file, locale, lang) {
	const sql = gunzipSync(fs.readFileSync(path.resolve(process.cwd(), file))).toString("utf8");
	const contents = objects(sql, "contents", ["cid", "title", "slug", "created", "modified", "text", "order", "authorId", "template", "type", "status", "password", "commentsNum", "allowComment", "allowPing", "allowFeed", "parent", "views", "agree"]);
	const fields = objects(sql, "fields", ["cid", "name", "type", "str_value", "int_value", "float_value"]);
	const metas = objects(sql, "metas", ["mid", "name", "slug", "type", "description", "count", "order", "parent"]);
	const relationships = objects(sql, "relationships", ["cid", "mid"]);
	const fieldMap = new Map();
	for (const field of fields) { if (!fieldMap.has(field.cid)) fieldMap.set(field.cid, {}); fieldMap.get(field.cid)[field.name] = field.str_value; }
	const metaMap = new Map(metas.map((meta) => [meta.mid, meta]));
	const relationMap = new Map();
	for (const relation of relationships) { if (!relationMap.has(relation.cid)) relationMap.set(relation.cid, []); if (metaMap.has(relation.mid)) relationMap.get(relation.cid).push(metaMap.get(relation.mid)); }
	const posts = contents.filter((entry) => entry.type === "post" && entry.status === "publish");
	for (const post of posts) {
		const slug = `${locale === "en-US" ? "en-" : ""}${post.slug || post.cid}`;
		const directory = path.join(postsRoot, slug);
		const filePath = path.join(directory, "index.md");
		fs.mkdirSync(directory, { recursive: true });
		const fieldsForPost = fieldMap.get(post.cid) ?? {};
		const categories = (relationMap.get(post.cid) ?? []).filter((meta) => meta.type === "category");
		const tags = (relationMap.get(post.cid) ?? []).filter((meta) => meta.type === "tag").map((meta) => meta.name);
		const body = convertJoeShortcodes(replaceMedia((post.text ?? "").replace(/^<!--markdown-->\s*/, ""), filePath));
		const imagePath = fieldsForPost.thumb?.match(/(?:https?:\/\/[^/]+)?\/?usr\/uploads\/(.+)$/)?.[1];
		const image = imagePath ? relativeImage(filePath, imagePath) ?? "" : "";
		const description = fieldsForPost.description || fieldsForPost.abstract || extractTitle(body);
		const frontmatter = [
			"---", `title: ${quote(decodeHtmlEntities(post.title))}`, `published: ${new Date(post.created * 1000).toISOString()}`,
			`updated: ${new Date(post.modified * 1000).toISOString()}`, `description: ${quote(description)}`,
			`image: ${quote(image)}`, `tags: [${tags.map(quote).join(", ")}]`, `category: ${quote(categories[0]?.name ?? "")}`,
			"draft: false", `lang: ${quote(lang)}`, "---", "", body,
		];
		fs.writeFileSync(filePath, frontmatter.join("\n"), "utf8");
	}
	const pages = contents.filter((entry) => entry.type === "page" && entry.status === "publish");
	for (const page of pages) {
		const prefix = locale === "en-US" ? "en-" : "";
		const directory = path.join(root, "src/content/spec/pages", `${prefix}${page.slug}`);
		const filePath = path.join(directory, "index.md");
		fs.mkdirSync(directory, { recursive: true });
		const body = convertJoeShortcodes(replaceMedia((page.text ?? "").replace(/^<!--markdown-->\s*/, ""), filePath));
		const frontmatter = [
			"---", `title: ${quote(decodeHtmlEntities(page.title))}`, `locale: ${quote(locale)}`,
			`lang: ${quote(lang)}`, `routeSlug: ${quote(page.slug)}`, "---", "", body,
		];
		fs.writeFileSync(filePath, frontmatter.join("\n"), "utf8");
	}
	return { posts: posts.length, pages: pages.length };
}

for (const name of fs.readdirSync(postsRoot)) {
	if (/^(?:zh|en)-\d+\.md$/.test(name)) fs.unlinkSync(path.join(postsRoot, name));
}
const zhCount = importDatabase(zhDump, "zh-CN", "zh_CN");
const enCount = importDatabase(enDump, "en-US", "en_US");
console.log(`Imported ${zhCount.posts} Chinese posts, ${enCount.posts} English posts, and ${zhCount.pages + enCount.pages} static pages.`);
