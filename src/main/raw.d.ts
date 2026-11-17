/** Files bundled as text (Vite's `?raw`). */
declare module '*?raw' {
  const text: string
  export default text
}

/** Vite's import.meta.glob (the themes are read this way when the phone reader is set up). */
interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true; import: 'default' }): Record<string, T>
}
