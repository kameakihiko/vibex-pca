import { shell } from 'electron';
import { folderStamps, listFolder, readFile, safePath } from './files';
import { commit, createBranch, diffOf, gitStatus, initRepo, listBranches, log, showCommit, stage, switchBranch, unstage } from './git';
import type { ModuleHost, VibexModule } from './modules';
import { SERVER_NOTE } from '../renderer/filesGitText';

// IPC of the Files and Git sections. Every call names a project by id; the folder comes from main, never from the
// page. A server project has no folder on this computer, so these calls refuse it in plain words.

type Answer = { ok: true; value: unknown } | { ok: false; message: string };

export const filesGit: VibexModule = {
  name: 'files-git',
  start(host: ModuleHost) {
    const folderOf = (id: unknown): string => {
      const project = host.projects.get(String(id));
      if (!project) throw new Error('This project is not open any more.');
      if (project.server) throw new Error(SERVER_NOTE);
      return project.path;
    };
    /// An error travels as an answer, so the page shows git's plain words, not Electron's "Error invoking remote method".
    const on = (name: string, fn: (folder: string, ...args: any[]) => unknown) =>
      host.handle(`mod:${name}`, async (id: unknown, ...args: unknown[]): Promise<Answer> => {
        try {
          return { ok: true, value: await fn(folderOf(id), ...args) };
        } catch (e) {
          return { ok: false, message: e instanceof Error ? e.message : 'Something went wrong.' };
        }
      });

    on('files:list', (root, rel: string) => listFolder(root, String(rel ?? '')));
    on('files:read', (root, rel: string) => readFile(root, String(rel ?? '')));
    on('files:stamps', (root, rels: string[]) => folderStamps(root, Array.isArray(rels) ? rels.map(String) : []));
    on('files:reveal', (root, rel: string) => {
      shell.showItemInFolder(safePath(root, String(rel ?? '')));
    });

    on('git:status', (root) => gitStatus(root));
    on('git:init', (root) => initRepo(root));
    on('git:stage', (root, paths: string[]) => stage(root, paths));
    on('git:unstage', (root, paths: string[]) => unstage(root, paths));
    on('git:commit', (root, message: string) => commit(root, message));
    on('git:branches', (root) => listBranches(root));
    on('git:switch', (root, name: string) => switchBranch(root, name));
    on('git:create', (root, name: string) => createBranch(root, name));
    on('git:log', (root, count: number) => log(root, count));
    on('git:show', (root, hash: string) => showCommit(root, hash));
    on('git:diff', (root, change: any) =>
      diffOf(root, { path: String(change?.path), area: change?.area, kind: change?.kind, originalPath: change?.originalPath ? String(change.originalPath) : undefined }),
    );
  },
};
