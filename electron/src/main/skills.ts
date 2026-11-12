import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Skills Claude Code loads: a folder with a SKILL.md in ~/.claude/skills (every project) or <project>/.claude/skills.
// Same layout as macOS Vibex (Skills/SkillsLibrary.swift) and `npx skills`: the files may live in .agents/skills and
// the .claude/skills entry may be a link to them. The marketplace (skills.sh) is not here: it needs the network.

export type SkillScope = 'global' | 'project';

export interface Skill { name: string; summary: string; scope: SkillScope; source?: string; folder: string }

/// Claude Code's own folder; CLAUDE_CONFIG_DIR moves it, as it moves the rest of Claude's config.
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

const claudeSkills = (scope: SkillScope, project: string) => path.join(scope === 'global' ? claudeDir() : path.join(project, '.claude'), 'skills');
const agentsSkills = (scope: SkillScope, project: string) => path.join(scope === 'global' ? os.homedir() : project, '.agents', 'skills');

/// `name:` and `description:` of a SKILL.md front matter, with folded (`>`) values joined.
export function frontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const values: Record<string, string> = {};
  let key: string | null = null;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    if (/^[ \t]/.test(line)) {
      if (key) values[key] = values[key] ? `${values[key]} ${line.trim()}` : line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      key = null;
      continue;
    }
    const name = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ([ '>', '|', '>-', '|-' ].includes(value)) value = '';
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
    key = name;
    values[name] = value;
  }
  return values;
}

/// Where each global skill came from, when `npx skills` or the marketplace installed it.
function lockSources(): Record<string, string> {
  try {
    const lock = JSON.parse(readFileSync(path.join(os.homedir(), '.agents', '.skill-lock.json'), 'utf8'));
    const out: Record<string, string> = {};
    for (const [name, entry] of Object.entries<any>(lock.skills ?? {})) if (typeof entry?.source === 'string') out[name] = entry.source;
    return out;
  } catch {
    return {};
  }
}

export function listSkills(scope: SkillScope, project: string): Skill[] {
  const root = claudeSkills(scope, project);
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
  const sources = scope === 'global' ? lockSources() : {};
  const skills: Skill[] = [];
  for (const name of names) {
    const folder = path.join(root, name);
    let text: string;
    try {
      text = readFileSync(path.join(folder, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    skills.push({ name, summary: frontmatter(text).description ?? '', scope, source: sources[name], folder });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/// A skill name is one folder name; anything with a separator or a dot path is refused, so a page cannot aim outside.
export function validSkillName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 128 && !/[\\/\0]/.test(name) && name !== '.' && name !== '..' && !name.startsWith('.');
}

export function skillFile(scope: SkillScope, project: string, name: string): string {
  if (!validSkillName(name)) throw new Error('That is not a skill name.');
  return path.join(claudeSkills(scope, project), name, 'SKILL.md');
}

export function readSkill(scope: SkillScope, project: string, name: string): string {
  const file = skillFile(scope, project, name);
  if (!existsSync(file)) throw new Error(`The skill ${name} is not there any more.`);
  return readFileSync(file, 'utf8').slice(0, 400_000);
}

interface Removed { scope: SkillScope; project: string; name: string; entry: string; linkTarget?: string; targetPath?: string; keep: string }

/// Moves a skill out of Claude's folder into the app's own removed-skills folder, so Undo can put it back.
/// A link in .claude/skills is removed, and its files are moved only when they live in our .agents/skills.
export function removeSkill(trashRoot: string, scope: SkillScope, project: string, name: string): string {
  if (!validSkillName(name)) throw new Error('That is not a skill name.');
  const entry = path.join(claudeSkills(scope, project), name);
  const stat = lstatSync(entry, { throwIfNoEntry: false });
  if (!stat) throw new Error(`The skill ${name} is not there any more.`);
  const keep = path.join(trashRoot, `${Date.now().toString(36)}-${scope}-${name}`);
  mkdirSync(keep, { recursive: true });
  const meta: Removed = { scope, project, name, entry, keep };
  if (stat.isSymbolicLink()) {
    meta.linkTarget = readlinkSync(entry);
    const target = path.resolve(path.dirname(entry), meta.linkTarget);
    dropLink(entry);
    const agents = path.resolve(agentsSkills(scope, project));
    if (target.startsWith(agents + path.sep) && existsSync(target)) {
      meta.targetPath = target;
      moveDir(target, path.join(keep, 'files'));
    }
  } else {
    moveDir(entry, path.join(keep, 'files'));
  }
  writeFileSync(path.join(keep, 'meta.json'), JSON.stringify(meta));
  return path.basename(keep);
}

/// Puts a removed skill back where it was. `token` is the folder name that removeSkill returned.
export function undoRemoveSkill(trashRoot: string, token: string): string {
  if (!validSkillName(token)) throw new Error('That removal is not known.');
  const keep = path.join(trashRoot, token);
  let meta: Removed;
  try {
    meta = JSON.parse(readFileSync(path.join(keep, 'meta.json'), 'utf8'));
  } catch {
    throw new Error('That removal is not known any more.');
  }
  if (existsSync(meta.entry) || lstatSync(meta.entry, { throwIfNoEntry: false })) throw new Error(`A skill named ${meta.name} is there already, so it was not put back.`);
  mkdirSync(path.dirname(meta.entry), { recursive: true });
  if (meta.linkTarget !== undefined) {
    if (meta.targetPath) {
      if (existsSync(meta.targetPath)) throw new Error(`Files for ${meta.name} are there already, so it was not put back.`);
      mkdirSync(path.dirname(meta.targetPath), { recursive: true });
      moveDir(path.join(keep, 'files'), meta.targetPath);
    }
    // A junction needs no special right on Windows; the target is made absolute for it.
    const target = process.platform === 'win32' ? path.resolve(path.dirname(meta.entry), meta.linkTarget) : meta.linkTarget;
    symlinkSync(target, meta.entry, process.platform === 'win32' ? 'junction' : undefined);
  } else {
    moveDir(path.join(keep, 'files'), meta.entry);
  }
  rmSync(keep, { recursive: true, force: true });
  return meta.name;
}

/// Removes a link and never the folder it points to. A Windows junction needs rmdir where a link needs unlink.
function dropLink(entry: string): void {
  try {
    unlinkSync(entry);
  } catch {
    rmdirSync(entry);
  }
}

function moveDir(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error: any) {
    // Another disk: copy, then remove.
    if (error?.code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

export function skillFolderReal(scope: SkillScope, project: string, name: string): string {
  if (!validSkillName(name)) throw new Error('That is not a skill name.');
  const folder = path.join(claudeSkills(scope, project), name);
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`The skill ${name} is not there any more.`);
  return realpathSync(folder);
}
