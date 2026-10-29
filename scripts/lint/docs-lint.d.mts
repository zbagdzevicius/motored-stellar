/** One lint finding. `line` is 0 for whole-file findings (a committed .env file). */
export interface LintFinding {
  file: string;
  line: number;
  rule: 'em-dash' | 'secret-key' | 'credential' | 'banned-term' | 'env-file';
  text: string;
}

/** Lints every text file under `root`; returns the findings (empty means clean). */
export function lintRepo(root: string): LintFinding[];
