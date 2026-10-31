import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "blog-deploy-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function makeArtifact(directory, version, { complete = true } = {}) {
	const site = join(directory, `site-${version}`);
	mkdirSync(join(site, "_astro"), { recursive: true });
	mkdirSync(join(site, "pagefind"));
	writeFileSync(join(site, "index.html"), `<h1>${version}</h1>`);
	writeFileSync(join(site, "_astro", `${version}.js`), version);
	if (complete) writeFileSync(join(site, "pagefind", "pagefind.js"), version);
	const artifact = join(directory, `${version}.tar`);
	execFileSync("tar", ["-cf", artifact, "-C", site, "."]);
	return artifact;
}

function activate(root, artifact, release, checksum, linkName = "current") {
	mkdirSync(join(root, "incoming"), { recursive: true });
	copyFileSync(artifact, join(root, "incoming", `${release}.tar`));
	return spawnSync(
		"bash",
		[
			join(scripts, "activate-cn-release.sh"),
			root,
			release,
			checksum ?? createHash("sha256").update(readFileSync(artifact)).digest("hex"),
			linkName,
		],
		{ encoding: "utf8" },
	);
}

test("activates complete releases and retains the previous version", (t) => {
	const directory = fixture(t);
	const root = join(directory, "web root");
	for (const version of ["first", "second"]) {
		const result = activate(root, makeArtifact(directory, version), version);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readlinkSync(join(root, "current")), `releases/${version}`);
		assert.equal(readFileSync(join(root, "current", "index.html"), "utf8"), `<h1>${version}</h1>`);
		assert.equal(existsSync(join(root, "incoming", `${version}.tar`)), false);
	}
	assert.equal(existsSync(join(root, "releases", "first", "index.html")), true);
});

test("rejects corrupted or incomplete archives without changing the live release", (t) => {
	const directory = fixture(t);
	const root = join(directory, "web");
	const artifact = makeArtifact(directory, "good");
	assert.equal(activate(root, artifact, "good").status, 0);
	const corrupted = activate(root, artifact, "corrupted", "0".repeat(64));
	assert.notEqual(corrupted.status, 0);
	assert.match(corrupted.stderr, /checksum does not match/);
	const incomplete = activate(root, makeArtifact(directory, "incomplete", { complete: false }), "incomplete");
	assert.notEqual(incomplete.status, 0);
	assert.match(incomplete.stderr, /Pagefind search index/);
	assert.equal(readlinkSync(join(root, "current")), "releases/good");
	assert.equal(existsSync(join(root, "releases", "incomplete")), false);
});

test("refuses to replace an existing site directory", (t) => {
	const directory = fixture(t);
	const root = join(directory, "web");
	mkdirSync(join(root, "current"), { recursive: true });
	writeFileSync(join(root, "current", "index.html"), "existing site");
	const result = activate(root, makeArtifact(directory, "new"), "new");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /not a symlink/);
	assert.equal(readFileSync(join(root, "current", "index.html"), "utf8"), "existing site");
});

test("supports a custom web root link name", (t) => {
	const directory = fixture(t);
	const root = join(directory, "web");
	const result = activate(root, makeArtifact(directory, "custom"), "custom", undefined, "www");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readlinkSync(join(root, "www")), "releases/custom");
	assert.equal(existsSync(join(root, "current")), false);
});

test("rejects link names that could overwrite deployment storage or escape it", (t) => {
	const directory = fixture(t);
	const root = join(directory, "web");
	const artifact = makeArtifact(directory, "new");
	for (const name of ["releases", "incoming", "../outside", "/tmp/outside", ".deploy.lock"]) {
		const result = activate(root, artifact, "new", undefined, name);
		assert.notEqual(result.status, 0, name);
		assert.match(result.stderr, /Invalid web root link name/);
	}
});

test("reports missing Secrets before opening a connection", (t) => {
	const directory = fixture(t);
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("DEPLOY_CN_")) delete env[key];
	}
	const result = spawnSync("bash", [join(scripts, "deploy-cn.sh"), makeArtifact(directory, "new"), "new"], { env, encoding: "utf8" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Missing GitHub Actions secret: DEPLOY_CN_HOST/);
});

test("uploads and activates through SSH with quoted paths and strict host checks", (t) => {
	const directory = fixture(t);
	const bin = join(directory, "bin");
	const temporary = join(directory, "temporary SSH files");
	const root = join(directory, "web's root $(touch injected)");
	mkdirSync(bin);
	mkdirSync(temporary);
	const key = join(directory, "key");
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
	writeFileSync(join(bin, "ssh"), `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (!args.includes('StrictHostKeyChecking=yes') || !args.includes('BatchMode=yes')) process.exit(99);
const result = spawnSync('/bin/sh', ['-c', args.at(-1)], {stdio: 'inherit'});
process.exit(result.status ?? 1);
`, { mode: 0o755 });
	const result = spawnSync("bash", [join(scripts, "deploy-cn.sh"), makeArtifact(directory, "pushed"), "pushed-123-1"], {
		cwd: directory,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			TMPDIR: temporary,
			DEPLOY_CN_HOST: "deploy.example.com",
			DEPLOY_CN_PORT: "2222",
			DEPLOY_CN_USER: "deploy",
			DEPLOY_CN_PATH: root,
			DEPLOY_CN_LINK_NAME: "www",
			DEPLOY_CN_SSH_KEY: readFileSync(key, "utf8"),
			DEPLOY_CN_KNOWN_HOSTS: "[deploy.example.com]:2222 ssh-ed25519 test",
		},
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readlinkSync(join(root, "www")), "releases/pushed-123-1");
	assert.equal(existsSync(join(directory, "injected")), false);
	assert.deepEqual(readdirSync(temporary), []);
});
