// js-yaml comes with electron-updater and has no types here. Only the reader that the library itself uses is needed.
declare module 'js-yaml' {
  export function load(text: string): unknown;
}
