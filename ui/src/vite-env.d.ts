/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK?: string;
  /** Pins the browser mock's admin password (see mockAdminPassword in src/lib/mocks/db.ts). */
  readonly VITE_MOCK_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
