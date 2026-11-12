import { icon } from './icons';
import type { RendererModule } from './modules';
import { api, button, el, plain } from './pcaUi';
import { openServerForm, sectionExtras, type FormAddOn } from './servers';
import { setupExtras } from './setup';

// The PCA edition on screen: an offer in the Servers section, and two rows under the Setup checks. Each one waits for a
// click. Main side: ../main/pcaEdition.ts.

const invoke = (channel: string, ...args: unknown[]) => api().mod.invoke(`mod:pcaedition:${channel}`, ...args);

/// The key login of the PCA server, in the add form: asked once, because Edit does not show it. The login key stays on this PC;
/// only its one public line leaves, and only when the person sends it.
const pcaLogin: FormAddOn = ({ key, folder }) => {
  const box = el('div', 'sf-pca-login');
  const personKey = document.createElement('input');
  personKey.id = 'sf-person-key';
  personKey.type = 'text';
  personKey.spellcheck = false;
  personKey.autocomplete = 'off';
  const line = el('code', 'sf-pub-line');
  line.id = 'sf-pub-line';
  const note = el('span', 'sf-hint', 'Send this one line to the owner. The private key stays on this PC: never send it.');
  note.id = 'sf-pub-note';
  note.setAttribute('role', 'status');
  const copy = button('Copy', () => {
    navigator.clipboard.writeText(line.textContent ?? '').then(() => { note.textContent = 'Copied. Send this one line to the owner. The private key stays on this PC: never send it.'; }, (error: unknown) => { note.textContent = plain(error); });
  }, 'side-button');
  copy.id = 'sf-pub-copy';
  const shown = el('div', 'sf-pub');
  shown.hidden = true;
  shown.append(line, copy, note);
  const problem = el('span', 'sf-hint');
  problem.id = 'sf-key-problem';
  problem.setAttribute('role', 'alert');
  const show = (made: { file: string; line: string } | null) => {
    if (!made) return;
    key.value = made.file;
    line.textContent = made.line;
    note.textContent = 'Send this one line to the owner. The private key stays on this PC: never send it.';
    shown.hidden = false;
    problem.textContent = '';
  };
  const fail = (error: unknown) => { problem.textContent = plain(error); };
  // A double click is one action: main also joins two calls, and this shows that one runs.
  const make = button('Make a Key', () => {
    if (make.disabled) return;
    make.disabled = true;
    void invoke('make-key', personKey.value).then(show, fail).finally(() => { make.disabled = false; });
  }, 'side-button primary');
  make.id = 'sf-make-key';
  const pick = button('Pick a Key…', () => void invoke('pick-key').then(show, fail), 'side-button');
  pick.id = 'sf-pick-key';
  const label = el('label', 'sf-field');
  label.append(el('span', 'sf-label', 'Your key name'), personKey, el('span', 'sf-hint', 'The owner gives you this name. It opens your own folder on the server.'));
  const buttons = el('div', 'sf-buttons');
  buttons.append(make, pick);
  box.append(label, buttons, problem, shown);
  personKey.addEventListener('input', () => {
    void invoke('folder', personKey.value).then((value: string) => { folder.value = value; });
  });
  return {
    node: box,
    check: () => {
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(personKey.value)) return 'Enter the key name that the owner gave you: small letters, digits and dashes.';
      if (!key.value) return 'Make or pick your login key first.';
      return null;
    },
  };
};

async function offer(): Promise<HTMLElement | null> {
  const profile = await invoke('offer');
  if (!profile) return null;
  const box = el('div', 'tool-group');
  box.dataset.pcaOffer = '1';
  box.append(
    el('h3', 'sv-head', 'PCA server'),
    el('p', 'tool-note', 'A saved login for the PCA server is ready. You make a login key, and you type the key name that the owner gave you.'),
    button('Add the PCA server', () => void openServerForm(null, profile, pcaLogin), 'side-button primary'),
  );
  return box;
}

/// Names that are there, as "a, b".
const list = (names: string[]) => names.join(', ');

async function skillsRow(): Promise<HTMLElement> {
  let state = await invoke('status');
  const row = el('div', 'tool-row setup-extra');
  row.dataset.setupExtra = 'pca-skills';
  const sub = el('span', 'row-sub');
  const message = el('span', 'row-next');
  message.dataset.pcaSkillsMessage = '1';
  message.setAttribute('role', 'status');
  const show = () => {
    sub.textContent = state.available.length
      ? `${state.present.length} of ${state.available.length} installed. Copies the PCA skills into your personal Claude skills folder. A skill that is there already stays as it is.`
      : 'The skills pack is not in this build.';
  };
  show();
  const text = el('div', 'row-text');
  text.append(el('span', 'row-name', 'PCA skills'), sub);
  if (state.available.length) {
    const act = button('Install', async () => {
      act.disabled = true;
      try {
        const result = await invoke('install-skills');
        state = result;
        const parts: string[] = [];
        if (result.installed.length) parts.push(`Installed ${list(result.installed)}.`);
        if (result.skipped.length) parts.push(`${list(result.skipped)} ${result.skipped.length === 1 ? 'is' : 'are'} there already, so ${result.skipped.length === 1 ? 'it was' : 'they were'} not changed.`);
        message.textContent = result.installed.length ? parts.join(' ') : `Nothing changed. ${parts.join(' ')}`;
        show();
      } catch (error) {
        message.textContent = plain(error);
      }
      act.disabled = false;
    }, 'side-button small');
    text.append(act);
  }
  text.append(message);
  row.append(icon('skills', 'row-icon status-mark'), text);
  return row;
}

async function managedRow(): Promise<HTMLElement> {
  const state = await invoke('status');
  const row = el('div', 'tool-row setup-extra');
  row.dataset.setupExtra = 'managed-settings';
  const text = el('div', 'row-text');
  text.append(
    el('span', 'row-name', 'Claude Code managed settings'),
    el('span', 'row-sub', 'Safe defaults for the team: no bypass mode, no reading of .env files, sign-in with a Claude subscription. This app does not install them, because that needs an administrator.'),
    el('span', 'row-next', `Ask your administrator to copy the sample file to ${state.target}. The sample explains each key in pca/README.md.`),
  );
  text.append(button('Show the sample file', () => void invoke('show-sample').catch(() => undefined), 'side-button small'));
  row.append(icon('lock', 'row-icon status-mark'), text);
  return row;
}

export const pcaEditionRenderer: RendererModule = {
  name: 'pca-edition',
  start: () => {
    sectionExtras.push(offer);
    setupExtras.push(async () => {
      const head = el('h3', 'sv-head', 'PCA edition');
      const group = el('section', 'tool-group');
      group.append(await skillsRow(), await managedRow());
      return [head, group];
    });
  },
};
