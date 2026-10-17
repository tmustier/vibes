import { feature } from "../lib/feature.ts";
/** Records Pi's startup inventory when `vibes check` requests it. scripts/inventory redacts it before upload. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultPackageManager,
	type ExtensionAPI,
	getAgentDir,
	type ResolvedResource,
	SettingsManager,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { contextReport } from "../node_modules/pine-of-glass/extensions/pi-contextimate/report.ts";
import { bundles } from "../lib/bundled.ts";

const EXTENSIONS_DIR = dirname(fileURLToPath(import.meta.url));

function packageVersion(dir: string | undefined): string | undefined {
	if (!dir || !existsSync(join(dir, "package.json"))) return undefined;
	const manifest: { version?: string } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	return manifest.version;
}

export default feature(import.meta.url, (pi: ExtensionAPI) => {
	const target = process.env.VIBES_INVENTORY;
	if (!target) return;
	pi.registerCommand("vibes-inventory", {
		description: "Write the startup inventory for vibes check",
		handler: async (_args, ctx) => {
			try {
				const agentDir = getAgentDir();
				const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
				const packageManager = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager });
				const configured = await packageManager.resolve(async () => "skip");
				const context = contextReport(pi, ctx);
				const skillIndex = new Map(context.skills.map((skill) => [skill.location, skill]));
				const toolTokens = new Map(context.tools.map((tool) => [tool.name, tool.tokens]));
				const resource = (entry: ResolvedResource) => ({
					path: entry.path,
					enabled: entry.enabled,
					source: entry.metadata.source,
					scope: entry.metadata.scope,
					origin: entry.metadata.origin,
				});

				const loadedSkills = new Map(
					pi
						.getCommands()
						.filter((command) => command.source === "skill")
						.map((command) => [command.sourceInfo.path, command]),
				);
				const configuredSkills = new Map(configured.skills.map((entry) => [entry.path, entry]));
				const skillPaths = new Set([...configuredSkills.keys(), ...loadedSkills.keys()]);
				const skills = [...skillPaths].sort().map((path) => {
					const entry = configuredSkills.get(path);
					const command = loadedSkills.get(path);
					const indexed = skillIndex.get(path);
					return {
						name: command?.name.replace(/^skill:/, "") ?? indexed?.name,
						path,
						source: entry?.metadata.source ?? command?.sourceInfo.source,
						enabled: entry?.enabled ?? true,
						loaded: Boolean(command),
						inContext: Boolean(indexed),
						indexTokens: indexed?.tokens,
					};
				});
				const extensions = configured.extensions.map((entry) => {
					const wrapped = bundles.get(entry.path);
					return {
						...resource(entry),
						...(wrapped && {
							bundles: {
								...wrapped,
								version: packageVersion(join(EXTENSIONS_DIR, "..", "node_modules", wrapped.package)),
							},
						}),
					};
				});
				const active = new Set(pi.getActiveTools());
				const inventory = {
					schema: 1,
					generatedAt: new Date().toISOString(),
					pi: VERSION,
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
					thinking: pi.getThinkingLevel(),
					packages: packageManager
						.listConfiguredPackages()
						.map((entry) => ({ ...entry, version: packageVersion(entry.installedPath) })),
					extensions,
					skills,
					prompts: configured.prompts.map(resource),
					themes: configured.themes.map(resource),
					tools: pi
						.getAllTools()
						.map((tool) => ({
							name: tool.name,
							active: active.has(tool.name),
							tokens: toolTokens.get(tool.name),
							source: tool.sourceInfo.source,
							path: tool.sourceInfo.path,
						}))
						.sort((a, b) => a.name.localeCompare(b.name)),
					commands: pi
						.getCommands()
						.filter((command) => command.source !== "skill")
						.map((command) => ({
							name: command.name,
							kind: command.source,
							source: command.sourceInfo.source,
							path: command.sourceInfo.path,
						})),
					context: { heuristic: context.heuristic, totalTokens: context.totalTokens, sections: context.sections },
				};
				writeFileSync(target, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
			} catch (error) {
				writeFileSync(target, `${JSON.stringify({ error: error instanceof Error ? error.stack : String(error) })}\n`, {
					mode: 0o600,
				});
			}
		},
	});
});
