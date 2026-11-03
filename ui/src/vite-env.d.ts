/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// The vendored coss hook use-copy-to-clipboard types its timer as NodeJS.Timeout. The app
// compiles against DOM types only, so alias that name to the browser timer handle.
declare namespace NodeJS {
  type Timeout = ReturnType<typeof globalThis.setTimeout>;
}
