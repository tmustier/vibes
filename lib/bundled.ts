/**
 * Vibes ships each default extension through a stable-name wrapper in extensions/.
 *
 * A wrapper names the npm package it bundles. At load time it reads that package's own
 * `pi.extensions` manifest, so a new release that moves its files still loads without a
 * Vibes change. A default steps aside, file by file, where the user's own copy of the same
 * package (in their settings, or in a project Pi trusts) loads the same file, so nothing loads
 * twice. Skills and prompts from a bundled package are added through the wrapper for the same
 * reason, not the Vibes manifest. Personal copies produce one summary at startup or reload,
 * while the startup agent migrates them to Vibes. Stepping aside avoids double registration;
 * it is not a decision to keep an unmanaged copy.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	type ExtensionFactory as Factory,
	type ExtensionContext,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	parseArgs,
	type ResolvedPaths,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { feature } from "./feature.ts";
import { migrationRequest, requestRepair } from "./migration.ts";
import { packageInspector, type ScopedPackage } from "./package-inspector.ts";

type Kind = "extensions" | "skills" | "prompts";

type Bundle = {
	/** npm package name under Vibes' node_modules. */
	package: string;
	/** Skill and prompt paths inside the package. */
	skills?: string[];
	prompts?: string[];
} & ({ noExtensions: true; entry?: never } | { noExtensions?: false; entry?: string });

/** What the user's own copy of a package loads: files relative to the package, by kind. */
type Copy = Record<Kind, Set<string>>;
const KINDS = ["extensions", "skills", "prompts"] as const;

const nodeModules = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules");
interface Runtime {
	bundles: Map<string, { package: string; steppedAside: boolean }>;
	trust: Map<string, boolean>;
	pass?: LoadPass;
}
const RUNTIME = Symbol.for("vibes.bundleRuntime");
// Pi loads wrappers separately; the symbol keeps their state in one typed slot.
const shared = globalThis as typeof globalThis & { [RUNTIME]?: Runtime };
const runtime: Runtime = (shared[RUNTIME] ??= { bundles: new Map(), trust: new Map() });
export const bundles = runtime.bundles;

interface Manifest {
	name?: string;
	repository?: string | { url?: string };
	dependencies?: Record<string, string>;
	pi?: { extensions?: string[] };
}
const readJson = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8"));

/**
 * The user's own copies of packages, by npm name: global settings, plus project settings when
 * trusted. Pi's package manager applies each entry's filters exactly as it will at
 * startup.
 */
function userCopies(cwd: string, trusted: boolean, pass: LoadPass, discovery?: ExtensionContext): Promise<Map<string, Copy>> {
	if (!pass.projects.has(cwd)) {
		pass.projects.set(cwd, (SettingsManager.create(cwd, getAgentDir(), { projectTrusted: true }).getProjectSettings().packages?.length ?? 0) > 0);
	}
	trusted &&= pass.projects.get(cwd)!;
	// Trusted project packages may be installed after factories run. Recheck once per discovery
	// event; otherwise reuse the load result, including across session_start.
	const key = trusted && discovery ? discovery : JSON.stringify([cwd, trusted]);
	const cached = pass.copies.get(key);
	if (cached) return cached;
	const bundleNames = Object.keys(readJson(join(nodeModules, "..", "package.json")).dependencies ?? {});
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
	const packageManager = packageInspector({ cwd, agentDir, settingsManager });
	const copies = new Map<string, Copy>();
	const names = new Map<string, string>();
	const nameOf = (baseDir: string) => {
		if (!names.has(baseDir)) {
			const manifest = join(baseDir, "package.json");
			names.set(baseDir, existsSync(manifest) ? (readJson(manifest).name ?? "") : "");
		}
		return names.get(baseDir)!;
	};
	const record = (resolved: ResolvedPaths, name?: string) => {
		for (const kind of KINDS) {
			for (const { path, enabled, metadata } of resolved[kind]) {
				if (!enabled) continue;
				assert(metadata.baseDir, "package resources need a base directory");
				const packageName = name ?? nameOf(metadata.baseDir);
				let copy = copies.get(packageName);
				if (!copy) {
					copy = { extensions: new Set(), skills: new Set(), prompts: new Set() };
					copies.set(packageName, copy);
				}
				copy[kind].add(relative(metadata.baseDir, path));
			}
		}
	};
	// We only need package resources, not Pi's full scan of loose extensions, skills, prompts
	// and themes. Find relevant identities before expanding any resource trees. Keep all entries
	// for each identity so project replacements and autoload:false deltas remain Pi's decision.
	const sources: Array<ScopedPackage & { source: string }> = [];
	for (const scope of ["project", "user"] as const) {
		const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
		for (const pkg of settings.packages ?? []) {
			sources.push({ pkg, source: typeof pkg === "string" ? pkg : pkg.source, scope });
		}
	}
	const relevant = new Set<string>();
	for (const { source, scope } of sources) {
		const installed = packageManager.getInstalledPath(source, scope);
		if (!installed) continue;
		const root = statSync(installed).isDirectory() ? installed : dirname(installed);
		if (bundleNames.includes(nameOf(root))) relevant.add(packageManager.getPackageIdentity(source, scope));
	}
	const selected = packageManager.dedupePackages(sources).filter(({ source, scope }) =>
		relevant.has(packageManager.getPackageIdentity(source, scope)),
	);
	const accumulator = packageManager.createAccumulator();
	const pending = packageManager.resolvePackageSources(selected, accumulator, async () => "skip").then(() => {
		record(packageManager.toResolvedPaths(accumulator));

		// A missing project package loads what its filter selects once Pi installs it. Vibes' own copy
		// of the same package stands in for it.
		for (const { pkg, source, scope } of sources) {
			if (scope !== "project") continue;
			if (packageManager.getInstalledPath(source, "project")) continue;
			const identity = packageManager.getPackageIdentity(source, "project");
			// Project deltas use the global install, not a bundled stand-in.
			if (typeof pkg === "object" && pkg.autoload === false && sources.some((entry) =>
				entry.scope === "user" && packageManager.getPackageIdentity(entry.source, "user") === identity,
			)) continue;
			const parsed = packageManager.parseSource(source);
			let name: string | undefined;
			if (parsed.type === "npm") name = parsed.name;
			if (parsed.type === "git") {
				name = bundleNames.find((bundle) => {
					const { repository } = readJson(join(nodeModules, bundle, "package.json"));
					const url = typeof repository === "string" ? repository : repository?.url;
					return (url && packageManager.getPackageIdentity(url.replace(/^git\+/, "")) === identity)
						|| basename(identity) === bundle.replace(/^@[^/]+\//, "");
				});
			}
			if (!name || !bundleNames.includes(name)) continue;
			const root = join(nodeModules, name);
			const accumulator = packageManager.createAccumulator();
			const filter = typeof pkg === "string" ? undefined : pkg;
			packageManager.collectPackageResources(root, accumulator, filter, { source, scope: "project", origin: "package", baseDir: root });
			record(packageManager.toResolvedPaths(accumulator), name);
		}
		return copies;
	});
	pass.copies.set(key, pending);
	return pending;
}

/**
 * Every wrapper asks the same question while Pi loads extensions, so the answer is shared for that
 * load pass. The first session_start after it ends the pass: a /reload asks again, and sees any
 * change to settings or installed packages since.
 */
interface LoadPass {
	cwd: Promise<string>;
	copies: Map<string | ExtensionContext, Promise<Map<string, Copy>>>;
	projects: Map<string, boolean>;
	bundles: Array<{ bundle: Bundle; state: { steppedAside: boolean } }>;
	notified: boolean;
}

function resourcePaths(bundle: Bundle, root: string, kind: "skills" | "prompts"): string[] {
	const packageManager = packageInspector({ cwd: root, agentDir: getAgentDir(), settingsManager: SettingsManager.inMemory() });
	const accumulator = packageManager.createAccumulator();
	packageManager.addManifestEntries(bundle[kind], root, kind, packageManager.getTargetMap(accumulator, kind), {
		source: bundle.package, scope: "temporary", origin: "package", baseDir: root,
	});
	return packageManager.toResolvedPaths(accumulator)[kind].map(({ path }) => path);
}

export function bundled(source: string, bundle: Bundle): Factory {
	return feature(source, async (pi) => {
		const first = !runtime.pass;
		const pass: LoadPass = (runtime.pass ??= {
			cwd: pi.exec("pwd", ["-P"]).then(({ code, stdout }) => {
				assert.equal(code, 0, "vibes: pwd failed while loading extensions");
				return stdout.trim();
			}),
			copies: new Map(), projects: new Map(), bundles: [], notified: false,
		});
		const state = { package: bundle.package, steppedAside: bundle.noExtensions ?? false };
		bundles.set(fileURLToPath(source), state);
		const root = join(nodeModules, bundle.package);
		pass.bundles.push({ bundle, state });
		// Discovery runs after all factories and session_start, with Pi's final trust decision.
		// One handler can therefore summarize every wrapper, including skill-only bundles.
		if (first) pi.on("resources_discover", async (event, ctx) => {
			if (pass.notified || ctx.mode !== "tui" || process.env.VIBES_CHECK_READY) return;
			pass.notified = true;
			const copies = await userCopies(event.cwd, ctx.isProjectTrusted(), pass, ctx);
			const names = new Set<string>();
			for (const { bundle, state } of pass.bundles) {
				const copy = copies.get(bundle.package);
				if (!copy) continue;
				const entry = bundle.entry && join(bundle.entry);
				const extensionsCovered = !bundle.noExtensions && state.steppedAside && [...copy.extensions].some((file) =>
					!entry || file === entry || file.startsWith(`${entry}/`));
				const root = join(nodeModules, bundle.package);
				const resourcesCovered = (["skills", "prompts"] as const).some((kind) =>
					resourcePaths(bundle, root, kind).some((file) => copy[kind].has(relative(root, file))));
				if (extensionsCovered || resourcesCovered) names.add(bundle.package);
			}
			if (names.size) {
				const packages = [...names].sort();
				const requested = requestRepair(pi, "vibes-resource-migration", `Separate copies overlap these Vibes packages: ${packages.join(", ")}.\n${migrationRequest()}`);
				ctx.ui.notify(
					`Pi is using your own copies of ${names.size} bundled package${names.size === 1 ? "" : "s"}. ${requested ? "Migrating duplicates to Vibes." : "Another Pi session is already repairing this setup."}\n${ctx.ui.theme.fg("dim", packages.map((name) => `- ${name}`).join("\n"))}`,
					"warning",
				);
			}
		});
		if ((bundle.skills?.length ?? 0) > 0 || (bundle.prompts?.length ?? 0) > 0) {
			pi.on("resources_discover", async (event, ctx) => {
				const copy = (await userCopies(event.cwd, ctx.isProjectTrusted(), pass, ctx)).get(bundle.package);
				const [skillPaths, promptPaths] = (["skills", "prompts"] as const).map((kind) =>
					resourcePaths(bundle, root, kind).filter((file) => !copy?.[kind].has(relative(root, file))));
				state.steppedAside &&= skillPaths.length === 0 && promptPaths.length === 0;
				return { skillPaths, promptPaths };
			});
		}

		// Extensions load now, before Pi decides trust.
		const cwd = await pass.cwd;
		pi.on("session_start", (_event, ctx) => {
			delete runtime.pass;
			runtime.trust.set(cwd, ctx.isProjectTrusted());
		});
		if (bundle.noExtensions) return;
		const args = parseArgs(process.argv.slice(2));
		let trusted = runtime.trust.get(cwd) ?? args.projectTrustOverride;
		if (trusted === undefined && !hasTrustRequiringProjectResources(cwd)) trusted = true;
		const interactive = args.mode === undefined && !args.print && !args.help && args.listModels === undefined
			&& process.stdin.isTTY && process.stdout.isTTY;
		// In a terminal Pi can still ask or overrule saved trust. Headless, follow its stored decision.
		if (trusted === undefined && !interactive) {
			trusted = new ProjectTrustStore(getAgentDir()).get(cwd)
				?? (SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getDefaultProjectTrust() === "always");
		}
		const covers = async (projectTrusted: boolean) => {
			const copy = (await userCopies(cwd, projectTrusted, pass)).get(bundle.package);
			if (!copy?.extensions.size) return false;
			const entry = bundle.entry && join(bundle.entry);
			return !entry || [...copy.extensions].some((file) => file === entry || file.startsWith(`${entry}/`));
		};
		// Until Pi decides, assume it will trust the folder: loading both copies would stop Pi.
		state.steppedAside = await covers(trusted ?? true);
		if (state.steppedAside) {
			// If only a project copy covers it and Pi then doesn't trust the folder, nothing loads it.
			const projectOnly = trusted !== false && !(await covers(false));
			pi.on("session_start", (_event, ctx) => {
				if (!projectOnly || ctx.isProjectTrusted()) return;
				const message = `Vibes left ${bundle.package} to this folder's own copy, which isn't loaded because the folder isn't trusted.`;
				if (ctx.hasUI) ctx.ui.notify(`${message} Run /reload to use the Vibes copy.`, "warning");
				else console.error(`${message} Trust the folder, or run with --no-approve to use the Vibes copy.`);
			});
			return;
		}

		const manifest = readJson(join(root, "package.json"));
		const entries = bundle.entry ? [bundle.entry] : (manifest.pi?.extensions ?? []);
		assert(entries.length > 0, `${bundle.package} declares no Pi extensions`);

		const files = entries.flatMap((entry) => {
			const path = join(root, entry);
			if (!statSync(path).isDirectory()) return [path];
			for (const index of ["index.ts", "index.js", "index.mjs"]) {
				if (existsSync(join(path, index))) return [join(path, index)];
			}
			return readdirSync(path)
				.filter((name) => /\.(ts|js|mjs)$/.test(name) && !/\.d\.ts$|\.test\.|\.spec\./.test(name))
				.sort().map((name) => join(path, name));
		});
		for (const file of files) {
			const module = (await import(pathToFileURL(file).href)) as { default: Factory };
			await module.default(pi);
		}
	});
}
