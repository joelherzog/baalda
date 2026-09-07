import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null),
  setVaultConfig: vi.fn(async () => {}),
  listTree: vi.fn(async () => ({ id: "root", name: "", path: "", isDir: true, children: [], childrenLoaded: true })),
  listNoteTitles: vi.fn(async () => []),
  writeNote: vi.fn(async () => {}),
  writeNoteIfMissing: vi.fn(async () => true),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { seedWelcomeContent } from "../../vault/seed";
import { VaultRegistry } from "../registry";
import { reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";

function emptyTree(): TreeNode {
  return { id: "root", name: "vault", path: "", isDir: true, children: [] };
}

/** Minimal fake of the ApiClient surface reconcile() touches. */
function fakeApi(opts: {
  vaults: Array<{ id: string; name: string; organization_id: string }>;
  notes?: Array<{ id: string; rel_path: string }>;
}) {
  const createVault = vi.fn(async (input: { name: string; organizationId: string }) => {
    const v = { id: `created-${input.name}`, name: input.name, organization_id: input.organizationId };
    opts.vaults.push(v);
    return v;
  });
  const createNote = vi.fn(async (input: { relPath: string }) => ({
    id: `note-${input.relPath}`,
    rel_path: input.relPath,
  }));
  const api = {
    listVaults: vi.fn(async () => opts.vaults),
    createVault,
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => ({ id: `folder-${input.path}` })),
    listNotes: vi.fn(async () => opts.notes ?? []),
    listNoteRegistry: vi.fn(async () => ({ notes: opts.notes ?? [], tombstones: [] })),
    createNote,
  } as unknown as ApiClient;
  return { api, createVault, createNote };
}

beforeEach(() => {
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.writeNote).mockClear();
  vi.mocked(ipc.writeNoteIfMissing).mockClear().mockResolvedValue(true);
  // Shared across the file: a test that describes a stray doc must not leave its
  // disk state standing for the next one.
  vi.mocked(ipc.listNoteTitles).mockClear().mockResolvedValue([]);
  vi.mocked(seedWelcomeContent).mockClear();
});

describe("VaultRegistry.reconcile — vault adoption (joining member)", () => {
  it("adopts the org's existing server vault even when the local folder name differs", async () => {
    // Owner created the vault under a folder named "MyNotes"; the member's fresh
    // per-vault folder is slugged from the org name ("acme") — no name match.
    const { api, createVault } = fakeApi({
      vaults: [{ id: "v-owner", name: "MyNotes", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Team/hello.md" }],
    });
    const reg = new VaultRegistry(api);
    const { seeded } = await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());

    expect(createVault).not.toHaveBeenCalled();
    expect(reg.vaultId).toBe("v-owner");
    expect(seeded).toBe(false); // populated vault never gets welcome content
    // Server-only note materialized locally so the sidebar shows it. The third
    // argument is the vault-epoch pin (null here — no VaultScope in this unit
    // test); in the app it is what makes Rust refuse the write after a switch.
    expect(vi.mocked(ipc.writeNoteIfMissing)).toHaveBeenCalledWith("Team/hello.md", "", null);
    expect(reg.getMapping("Team/hello.md")).toEqual({ vaultId: "v-owner", docId: "n1" });
  });

  it("adopts by id (oldest in org) — a name-matching vault never wins over it", async () => {
    // Names collide and differ per device; every device must deterministically
    // land on the SAME server vault. The org's oldest vault is the canonical one,
    // even when a legacy fork happens to match this folder's name.
    const { api, createVault } = fakeApi({
      vaults: [
        { id: "v-original", name: "Old", organization_id: ORG },
        { id: "v-fork", name: "acme", organization_id: ORG },
      ],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());
    expect(createVault).not.toHaveBeenCalled();
    expect(reg.vaultId).toBe("v-original");
  });

  it("ignores server vaults from other orgs and creates one when the org has none", async () => {
    const { api, createVault } = fakeApi({
      vaults: [{ id: "v-other", name: "acme", organization_id: "other-org" }],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());
    expect(createVault).toHaveBeenCalledWith({ name: "acme", organizationId: ORG });
    expect(reg.vaultId).toBe("created-acme");
  });

  it("keeps the vault recorded in .context/config.json when it still exists", async () => {
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      JSON.stringify({ serverVaultId: "v-cfg", docs: {} }),
    );
    const { api, createVault } = fakeApi({
      vaults: [
        { id: "v-other", name: "acme", organization_id: ORG },
        { id: "v-cfg", name: "whatever", organization_id: ORG },
      ],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());
    expect(reg.vaultId).toBe("v-cfg"); // the recorded id wins over oldest-in-org
    expect(createVault).not.toHaveBeenCalled();
  });

  it("discards a config vault id that belongs to a DIFFERENT org", async () => {
    // A folder previously bound to org A must not drag A's vault into
    // org B — identity is (org id, vault id), never the folder.
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      JSON.stringify({ serverVaultId: "v-org-a", docs: {} }),
    );
    const { api, createVault } = fakeApi({
      vaults: [
        { id: "v-org-a", name: "acme", organization_id: "org-a" },
        { id: "v-org-b", name: "beta", organization_id: ORG },
      ],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());
    expect(reg.vaultId).toBe("v-org-b");
    expect(createVault).not.toHaveBeenCalled();
  });

  it("heals a stale config vault id (wiped/foreign server) by re-adopting the org vault", async () => {
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      JSON.stringify({ serverVaultId: "v-gone", docs: { "old.md": "dead-doc" } }),
    );
    const { api, createVault } = fakeApi({
      vaults: [{ id: "v-live", name: "Team Vault", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Welcome.md" }],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "some-folder" }, emptyTree());
    expect(reg.vaultId).toBe("v-live");
    expect(createVault).not.toHaveBeenCalled();
    // Mapping rebuilt from the live vault, not the dead config.
    expect(reg.getMapping("old.md")).toBeNull();
    expect(reg.getMapping("Welcome.md")).toEqual({ vaultId: "v-live", docId: "n1" });
  });
});

describe("VaultRegistry.reconcile — seeding and materialization rules", () => {
  it("seeds welcome content ONLY for a just-created vault (seedIfEmpty) with empty server + folder", async () => {
    const { api } = fakeApi({ vaults: [{ id: "v1", name: "fresh", organization_id: ORG }] });
    const reg = new VaultRegistry(api);
    const { seeded } = await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "fresh", seedIfEmpty: true },
      emptyTree(),
    );
    expect(seeded).toBe(true);
    expect(seedWelcomeContent).toHaveBeenCalledTimes(1);
  });

  it("does not seed without creation intent, even when server and folder are both empty", async () => {
    // Turning on sync for an opened folder, or joining an empty team vault,
    // must never invent content — only the "New vault" flows pass seedIfEmpty.
    const { api } = fakeApi({ vaults: [{ id: "v1", name: "fresh", organization_id: ORG }] });
    const reg = new VaultRegistry(api);
    const { seeded } = await reconcileWithTree(reg, { organizationId: ORG, vaultName: "fresh" }, emptyTree());
    expect(seeded).toBe(false);
    expect(seedWelcomeContent).not.toHaveBeenCalled();
  });

  it("does not seed when the local folder already has content", async () => {
    const { api, createNote } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
    });
    const reg = new VaultRegistry(api);
    const tree: TreeNode = {
      id: "root",
      name: "laptop",
      path: "",
      isDir: true,
      children: [{ id: "a", name: "Mine.md", path: "Mine.md", isDir: false }],
    };
    const { seeded } = await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "laptop", seedIfEmpty: true },
      tree,
    );
    expect(seeded).toBe(false);
    expect(seedWelcomeContent).not.toHaveBeenCalled();
    // The local-only note was registered on the server instead.
    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({ relPath: "Mine.md" }));
  });

  it("materializes only server-only notes; files already on disk are untouched", async () => {
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [
        { id: "n1", rel_path: "Shared.md" }, // server-only → materialize
        { id: "n2", rel_path: "Mine.md" }, // also local → leave alone
      ],
    });
    const reg = new VaultRegistry(api);
    const tree: TreeNode = {
      id: "root",
      name: "laptop",
      path: "",
      isDir: true,
      children: [{ id: "a", name: "Mine.md", path: "Mine.md", isDir: false }],
    };
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, tree);
    expect(vi.mocked(ipc.writeNoteIfMissing)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.writeNoteIfMissing)).toHaveBeenCalledWith("Shared.md", "", null);
  });

  // ── The 428-note regression ────────────────────────────────────────────────
  // `reconcile` used to take the tree from its caller, and the caller had only
  // the SIDEBAR's tree — which is lazy: top level only, every unexpanded folder
  // an empty `children` placeholder. Handed that, `flattenTree` saw root-level
  // notes and nothing else, so every nested note the server already knew about
  // was classified server-only and materialized as an EMPTY file over real
  // content. These two tests pin both halves of the fix.

  it("reads the FULL tree itself, so nested notes register instead of being missed", async () => {
    const { api, createNote } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
    });
    const reg = new VaultRegistry(api);
    const full: TreeNode = {
      id: "root",
      name: "laptop",
      path: "",
      isDir: true,
      children: [
        { id: "r", name: "Root.md", path: "Root.md", isDir: false },
        {
          id: "Context",
          name: "Context",
          path: "Context",
          isDir: true,
          children: [
            { id: "c1", name: "brand.md", path: "Context/brand.md", isDir: false },
            {
              id: "Context/brand",
              name: "brand",
              path: "Context/brand",
              isDir: true,
              children: [
                {
                  id: "c2",
                  name: "kit.md",
                  path: "Context/brand/kit.md",
                  isDir: false,
                },
              ],
            },
          ],
        },
      ],
    };
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, full);

    // Every depth reaches the server, not just the root.
    const registered = createNote.mock.calls.map((c) => c[0].relPath).sort();
    expect(registered).toEqual(["Context/brand.md", "Context/brand/kit.md", "Root.md"]);
    expect(reg.getMapping("Context/brand/kit.md")).not.toBeNull();
  });

  it("never materializes over a nested note that exists on disk", async () => {
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      // The server knows all three. All three are also on disk, nested.
      notes: [
        { id: "n1", rel_path: "Context/brand.md" },
        { id: "n2", rel_path: "Context/brand/kit.md" },
        { id: "n3", rel_path: "Daily/2026-08-03.md" },
      ],
    });
    const reg = new VaultRegistry(api);
    const dir = (path: string, children: TreeNode[]): TreeNode => ({
      id: path,
      name: path.split("/").pop()!,
      path,
      isDir: true,
      children,
    });
    const file = (path: string): TreeNode => ({
      id: path,
      name: path.split("/").pop()!,
      path,
      isDir: false,
    });
    const full: TreeNode = {
      id: "root",
      name: "laptop",
      path: "",
      isDir: true,
      children: [
        dir("Context", [
          file("Context/brand.md"),
          dir("Context/brand", [file("Context/brand/kit.md")]),
        ]),
        dir("Daily", [file("Daily/2026-08-03.md")]),
      ],
    };
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, full);

    // Nothing is server-only, so nothing is written at all. Before the fix this
    // fired three empty writes — one per nested note — and each one was a note
    // truncated to zero bytes.
    expect(vi.mocked(ipc.writeNoteIfMissing)).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.writeNote)).not.toHaveBeenCalled();
  });

  it("materialization is create-only, so a wrong server-only verdict costs nothing", async () => {
    // Belt and braces: even if the local list were short again (here the tree
    // omits a file the server has), the write must not be able to clobber. The
    // real command checks the filesystem; the mock stands in for a file that is
    // already there.
    vi.mocked(ipc.writeNoteIfMissing).mockResolvedValue(false);
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Context/brand.md" }],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());

    // It tried — and the create-only command refused, without failing the run.
    expect(vi.mocked(ipc.writeNoteIfMissing)).toHaveBeenCalledWith("Context/brand.md", "", null);
    expect(vi.mocked(ipc.writeNote)).not.toHaveBeenCalled();
    expect(reg.hasFailures()).toBe(false);
  });
});

describe("VaultRegistry.registerNote", () => {
  it("returns null before reconcile (sync not enabled yet)", async () => {
    const { api } = fakeApi({ vaults: [] });
    const reg = new VaultRegistry(api);
    expect(await reg.registerNote("New.md", "New")).toBeNull();
  });

  it("registers a new note into the adopted vault and persists the mapping", async () => {
    const { api, createNote } = fakeApi({
      vaults: [{ id: "v1", name: "acme", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Welcome.md" }],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());
    const mapping = await reg.registerNote("Ideas/New.md", "New");
    expect(createNote).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: "Ideas/New.md", vaultId: "v1" }),
    );
    expect(mapping).toEqual({ vaultId: "v1", docId: "note-Ideas/New.md" });
    // Idempotent: a second call returns the cached mapping without re-creating.
    const again = await reg.registerNote("Ideas/New.md", "New");
    expect(again).toEqual(mapping);
    expect(createNote).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// A local rename/move the server never learned about.
//
// The file moves on disk first (Rust, by doc_id) and the server row moves second.
// When that second step is lost — offline, a 400 for a destination folder the
// server doesn't know, an error that used to go only to the console — the row
// keeps the OLD path. Reconcile then saw a server path with no file under it and
// materialized an empty one beside the real note, while the note's new path looked
// unregistered and was registered a second time: one rename, two files.
// ---------------------------------------------------------------------------

/** Build a full vault tree from vault-relative note paths. */
function treeOf(paths: string[]): TreeNode {
  const root: TreeNode = { id: "root", name: "vault", path: "", isDir: true, children: [] };
  for (const p of paths) {
    const segs = p.split("/");
    let node = root;
    for (let i = 0; i < segs.length; i++) {
      const isDir = i < segs.length - 1;
      const path = segs.slice(0, i + 1).join("/");
      let next = (node.children ??= []).find((c) => c.path === path);
      if (!next) {
        next = { id: path, name: segs[i], path, isDir, children: isDir ? [] : undefined };
        node.children.push(next);
      }
      node = next;
    }
  }
  return root;
}

function strayApi(opts: {
  notes: Array<{ id: string; rel_path: string }>;
  folders?: Array<{ id: string; path: string }>;
  updateNote?: (id: string, input: Record<string, unknown>) => Promise<unknown>;
}) {
  const folders = opts.folders ?? [];
  const createNote = vi.fn(async (input: { relPath: string }) => ({
    id: `note-${input.relPath}`,
    rel_path: input.relPath,
  }));
  const createFolder = vi.fn(async (input: { path: string }) => {
    const f = { id: `folder-${input.path}`, path: input.path };
    folders.push(f);
    return f;
  });
  const updateNote = vi.fn(
    opts.updateNote ??
      (async (id: string, input: Record<string, unknown>) => ({
        id,
        rel_path: input.relPath as string,
      })),
  );
  const api = {
    listVaults: vi.fn(async () => [{ id: "v1", name: "acme", organization_id: ORG }]),
    listFolders: vi.fn(async () => folders),
    listFolderRegistry: vi.fn(async () => ({ folders, tombstones: [] })),
    createFolder,
    listNotes: vi.fn(async () => opts.notes),
    listNoteRegistry: vi.fn(async () => ({ notes: opts.notes, tombstones: [] })),
    createNote,
    updateNote,
  } as unknown as ApiClient;
  return { api, createNote, createFolder, updateNote };
}

describe("VaultRegistry — a local move the server hasn't learned about", () => {
  it("moves the server row onto the file instead of duplicating the note", async () => {
    // Server still says Notes/A.md; the file is at Notes/B.md under the same
    // doc_id (Rust renames by id, which is what makes this provable).
    const { api, createNote, updateNote } = strayApi({
      notes: [{ id: "n1", rel_path: "Notes/A.md" }],
      folders: [{ id: "f-notes", path: "Notes" }],
    });
    vi.mocked(ipc.listNoteTitles).mockResolvedValue([
      { id: "n1", path: "Notes/B.md", title: "B" },
    ]);
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, treeOf(["Notes/B.md"]));

    expect(updateNote).toHaveBeenCalledWith("n1", {
      relPath: "Notes/B.md",
      folderId: "f-notes",
    });
    // Neither half of the duplicate: no empty file at the stale path…
    expect(vi.mocked(ipc.writeNoteIfMissing)).not.toHaveBeenCalled();
    // …and no second row for the note's real path.
    expect(createNote).not.toHaveBeenCalled();
    expect(reg.getMapping("Notes/B.md")).toEqual({ vaultId: "v1", docId: "n1" });
    expect(reg.getMapping("Notes/A.md")).toBeNull();
    expect(reg.failures()).toEqual([]);
  });

  it("writes no empty twin when the move is refused, and records the failure", async () => {
    const { api, createNote, updateNote } = strayApi({
      notes: [{ id: "n1", rel_path: "Notes/A.md" }],
      folders: [{ id: "f-notes", path: "Notes" }],
      updateNote: async () => {
        throw new Error("offline");
      },
    });
    vi.mocked(ipc.listNoteTitles).mockResolvedValue([
      { id: "n1", path: "Notes/B.md", title: "B" },
    ]);
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, treeOf(["Notes/B.md"]));

    expect(updateNote).toHaveBeenCalled();
    expect(vi.mocked(ipc.writeNoteIfMissing)).not.toHaveBeenCalled();
    expect(createNote).not.toHaveBeenCalled();
    // The mapping stays on the SERVER's path: that is the self-consistent state,
    // and it is what stops inbound reading the untouched row as a remote move and
    // dragging the user's rename back on the next pass.
    expect(reg.getMapping("Notes/A.md")).toEqual({ vaultId: "v1", docId: "n1" });
    expect(reg.failures().map((f) => f.kind)).toContain("move");
  });

  it("registers a destination folder the server doesn't know before moving into it", async () => {
    // The everyday trigger: drag a note into a folder that hasn't registered yet.
    // Sending folderId: null with a nested relPath makes the server refuse with
    // `No folder at "New" — create it first`, and the move is lost.
    const { api, createFolder, updateNote } = strayApi({
      notes: [{ id: "n1", rel_path: "A.md" }],
      folders: [],
    });
    vi.mocked(ipc.listNoteTitles).mockResolvedValue([{ id: "n1", path: "New/A.md", title: "A" }]);
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, treeOf(["New/A.md"]));

    expect(createFolder).toHaveBeenCalledWith(
      expect.objectContaining({ path: "New", vaultId: "v1" }),
    );
    expect(updateNote).toHaveBeenCalledWith("n1", {
      relPath: "New/A.md",
      folderId: "folder-New",
    });
    expect(vi.mocked(ipc.writeNoteIfMissing)).not.toHaveBeenCalled();
  });

  it("never moves a row onto a path the filesystem walk doesn't show", async () => {
    // The SQLite index is derived state and can lag the filesystem. Trusting it
    // alone would move the server row to a path with no file under it, stranding
    // the note where no device can see it — worse than the twin we guard against.
    const { api, updateNote } = strayApi({
      notes: [{ id: "n1", rel_path: "A.md" }],
    });
    vi.mocked(ipc.listNoteTitles).mockResolvedValue([
      { id: "n1", path: "Ghost.md", title: "gone" },
    ]);
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, treeOf(["A.md"]));

    expect(updateNote).not.toHaveBeenCalled();
    expect(reg.getMapping("A.md")).toEqual({ vaultId: "v1", docId: "n1" });
  });

  it("propagates a rename when the map holds another spelling of the old path", async () => {
    // macOS/Windows store one file per case-insensitive name, so the map can hold
    // the server's spelling of a path the user typed differently. The exact-only
    // lookup this used to do made renamePath a silent no-op — the move never left
    // the device, and the twin appeared on the next pull.
    const { api, updateNote } = strayApi({
      notes: [{ id: "n1", rel_path: "notes/a.md" }],
      folders: [{ id: "f-notes", path: "notes" }],
    });
    vi.mocked(ipc.listNoteTitles).mockResolvedValue([
      { id: "n1", path: "notes/a.md", title: "A" },
    ]);
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, treeOf(["notes/a.md"]));
    expect(updateNote).not.toHaveBeenCalled(); // nothing stray yet

    await reg.renamePath("Notes/A.md", "notes/b.md");
    expect(updateNote).toHaveBeenCalledWith("n1", {
      relPath: "notes/b.md",
      folderId: "f-notes",
    });
    expect(reg.getMapping("notes/b.md")).toEqual({ vaultId: "v1", docId: "n1" });
  });
});
