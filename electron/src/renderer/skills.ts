import { openDoc } from './docs';
import type { ProjectInfo } from './frame';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import type { Section } from './modules';
import { api, button, el, emptyState, groupHeader, iconButton, MOD, plain, problem } from './pcaUi';

// The Skills section, as macOS Vibex has it (Skills/SkillsSidebar.swift): the skills Claude Code loads in this
// project and in every project, each one readable, with Remove that Undo takes back.

interface Skill { name: string; summary: string; scope: 'global' | 'project'; source?: string; folder: string }

/// What the last removal can still undo, per project.
const undo = new Map<string, { token: string; name: string }>();
const failed = new Map<string, string>();

async function read(project: ProjectInfo, skill: Skill): Promise<void> {
  const element = el('div', 'doc-page');
  try {
    const text: string = await api().mod.invoke('mod:skills:read', project.id, skill.scope, skill.name);
    const head = el('header', 'doc-head');
    head.append(el('h1', '', skill.name), el('p', 'doc-sub', `${skill.scope === 'global' ? 'Every project' : 'This project'} · ${skill.folder}`));
    element.append(head, renderMarkdown(text));
  } catch (error) {
    element.append(problem(plain(error)));
  }
  openDoc(project.id, { key: `skill:${skill.scope}:${skill.name}`, title: `${skill.name} · SKILL.md`, icon: 'file', element });
}

function row(project: ProjectInfo, skill: Skill, paint: () => void): HTMLElement {
  const line = el('div', 'tool-row skill-row');
  line.tabIndex = 0;
  line.dataset.skill = skill.name;
  line.dataset.scope = skill.scope;
  line.title = skill.source ? `From ${skill.source} · ${skill.folder}` : skill.folder;
  const mark = icon('puzzle', 'row-icon skill-icon');
  const text = el('div', 'row-text');
  text.append(el('span', 'row-name', skill.name));
  if (skill.summary) text.append(el('span', 'row-sub clamp', skill.summary));
  const actions = el('div', 'row-actions');
  actions.append(
    iconButton('eye', `Read ${skill.name}`, () => void read(project, skill)),
    iconButton('folder', `Show ${skill.name} in the file manager`, () => void api().mod.invoke('mod:skills:reveal', project.id, skill.scope, skill.name)),
    iconButton('trash', `Remove ${skill.name} (you can undo)`, async () => {
      try {
        const token: string = await api().mod.invoke('mod:skills:remove', project.id, skill.scope, skill.name);
        undo.set(project.id, { token, name: skill.name });
        failed.delete(project.id);
      } catch (error) {
        failed.set(project.id, plain(error));
      }
      paint();
    }),
  );
  line.append(mark, text, actions);
  line.addEventListener('click', () => void read(project, skill));
  line.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void read(project, skill);
  });
  return line;
}

function group(project: ProjectInfo, title: string, detail: string, skills: Skill[], paint: () => void): HTMLElement {
  const box = el('section', 'tool-group');
  box.append(groupHeader(title, skills.length));
  if (!skills.length) box.append(el('p', 'tool-note', `${detail} None yet.`));
  else for (const skill of skills) box.append(row(project, skill, paint));
  return box;
}

export const skillsSection: Section = {
  id: 'skills',
  title: 'Skills',
  icon: 'puzzle',
  label: 'Skills',
  help: `Skills (${MOD()}+Shift+K)`,
  async render(body, project, live) {
    if (project.server) {
      body.append(emptyState('Skills of a server project', `Claude on ${project.server} loads its skills from that server. Open them there.`));
      return;
    }
    const paint = async (): Promise<void> => {
      let lists: { global: Skill[]; project: Skill[] };
      try {
        lists = await api().mod.invoke('mod:skills:list', project.id);
      } catch (error) {
        if (live()) body.replaceChildren(problem(plain(error)));
        return;
      }
      if (!live()) return;
      const head = el('div', 'tool-head');
      head.append(el('span', 'tool-head-title', 'What Claude loads here'), iconButton('refresh', 'Refresh the list', () => void paint()));
      const parts: HTMLElement[] = [head];
      const gone = undo.get(project.id);
      if (gone) {
        const notice = el('div', 'tool-notice');
        notice.setAttribute('role', 'status');
        notice.append(el('span', 'notice-text', `Removed “${gone.name}”`));
        notice.append(button('Undo', async () => {
          try {
            await api().mod.invoke('mod:skills:undo', gone.token);
            undo.delete(project.id);
            failed.delete(project.id);
          } catch (error) {
            failed.set(project.id, plain(error));
          }
          void paint();
        }, 'side-button small'), iconButton('close', 'Dismiss', () => { undo.delete(project.id); void paint(); }));
        parts.push(notice);
      }
      if (failed.has(project.id)) parts.push(problem(failed.get(project.id)!));
      parts.push(
        group(project, 'This project', `Loaded only in ${project.name}. Commit them to share with your team.`, lists.project, () => void paint()),
        group(project, 'Every project', 'Loaded in every project.', lists.global, () => void paint()),
      );
      body.replaceChildren(...parts);
    };
    await paint();
  },
};
