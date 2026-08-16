/// <reference types="vite/client" />

/** package.json version, injected at build/dev time. */
declare const __APP_VERSION__: string;

/** Short SHA of main (or HEAD), injected at build/dev time; empty if unknown. */
declare const __GIT_COMMIT__: string;
