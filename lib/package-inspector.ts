import {
	DefaultPackageManager,
	type PackageSource,
	type PathMetadata,
	type ResolvedPaths,
	type ResolvedResource,
} from "@earendil-works/pi-coding-agent";

type ResourceKind = keyof ResolvedPaths;
type ResourceMap = Map<string, Pick<ResolvedResource, "enabled" | "metadata">>;
type Accumulator = Record<ResourceKind, ResourceMap>;
type PackageFilter = Exclude<PackageSource, string>;
export type ScopedPackage = { pkg: PackageSource; scope: "user" | "project" };

/** The subset of Pi's package internals used to match bundled resources to user copies. */
interface PackageInspector extends Pick<DefaultPackageManager, "getInstalledPath"> {
	dedupePackages<T extends ScopedPackage>(packages: T[]): T[];
	resolvePackageSources(packages: ScopedPackage[], accumulator: Accumulator, onMissing: () => Promise<"skip">): Promise<void>;
	parseSource(source: string): { type: "npm"; name: string } | { type: "git" | "local" };
	getPackageIdentity(source: string, scope?: "user" | "project"): string;
	createAccumulator(): Accumulator;
	getTargetMap(accumulator: Accumulator, kind: ResourceKind): ResourceMap;
	collectPackageResources(root: string, accumulator: Accumulator, filter: PackageFilter | undefined, metadata: PathMetadata): boolean;
	addManifestEntries(entries: string[] | undefined, root: string, kind: ResourceKind, target: ResourceMap, metadata: PathMetadata): void;
	toResolvedPaths(accumulator: Accumulator): ResolvedPaths;
}

export function packageInspector(options: ConstructorParameters<typeof DefaultPackageManager>[0]): PackageInspector {
	// Pi declares these methods private without their signatures. Its public API cannot resolve
	// only selected package resources (without scanning loose resources), expand a wrapper's
	// manifest entries or apply filters to a bundled stand-in for a missing package. Keep the
	// assertion at this boundary; tests/test_bundled.mjs exercises the pinned Pi.
	return new DefaultPackageManager(options) as unknown as PackageInspector;
}
