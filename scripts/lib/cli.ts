/** Tiny helpers shared by the CLI entry points. */
import { pathToFileURL } from 'node:url';

/** True when the module at `metaUrl` is the process entry point (not imported by a test). */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && metaUrl === pathToFileURL(entry).href;
}

/** Runs an async main and maps errors to exit code 1 without dumping objects that might hold key material. */
export function runMain(main: () => Promise<number | void>): void {
  main().then(
    (code) => process.exit(typeof code === 'number' ? code : 0),
    (err: unknown) => {
      console.error(err instanceof Error ? `error: ${err.message}` : 'error: unknown failure');
      process.exit(1);
    },
  );
}

/** Output sink for CLIs (ReportSink-shaped); tests capture it. */
export interface Out {
  log(line: string): void;
}
export const consoleOut: Out = { log: (l) => console.log(l) };
