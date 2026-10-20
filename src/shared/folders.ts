export type FolderLocation = { name: string; path: string; kind: 'home' | 'common' | 'drive' | 'recent'; openedAt?: number };
export type FolderLocations = { shortcuts: FolderLocation[]; recents: FolderLocation[]; nativeAvailable: boolean };
export type FolderListing = {
  path: string; parent: string | null; breadcrumbs: { name: string; path: string }[];
  folders: { name: string; path: string }[]; total: number; truncated: boolean;
};
