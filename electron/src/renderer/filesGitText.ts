// Words the Files and Git sections share with main. No DOM here, so the main process and the tests can import it.
export const SERVER_NOTE = 'Files and Git work on folders of this computer. This project is on a server: use its terminal tab for git and ls there.';
export const serverNote = (server: string, folder: string) => `Files and Git work on folders of this computer. This project is on ${server}, in ${folder}: use its terminal tab for git and ls there.`;
export const HOOKS_NOTE = 'This folder has Git hooks. Vibex PCA does not run them, because a folder can come from anyone. Run git in a terminal tab if you trust them.';
