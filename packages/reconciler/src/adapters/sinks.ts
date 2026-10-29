/**
 * Report sinks for local runs: console and files.
 *
 * The file sink writes the public daily report (`<dir>/<day>.json` and
 * `<day>.md`) and appends internal alerts to a separate file that must not be
 * published (alerts may carry escrow IDs and order references).
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Alert, ReportSink } from "../ports.js";
import { renderDailyMarkdown, type DailyReport } from "../report.js";

/** Prints reports and alerts to stdout / stderr. */
export class ConsoleReportSink implements ReportSink {
  async writeDaily(report: DailyReport): Promise<void> {
    process.stdout.write(renderDailyMarkdown(report));
  }
  async alert(alert: Alert): Promise<void> {
    process.stderr.write(`[${alert.severity}] ${alert.kind}: ${alert.message}\n`);
  }
}

export interface FileReportSinkOptions {
  /** Directory for public daily reports. */
  reportDir: string;
  /** File for internal alerts (JSON lines). Keep it out of anything you publish. */
  alertFile: string;
}

/** Writes daily reports as JSON plus Markdown and alerts as JSON lines. */
export class FileReportSink implements ReportSink {
  constructor(private readonly opts: FileReportSinkOptions) {}

  async writeDaily(report: DailyReport): Promise<void> {
    await mkdir(this.opts.reportDir, { recursive: true });
    const base = join(this.opts.reportDir, report.day);
    await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(`${base}.md`, renderDailyMarkdown(report));
  }

  async alert(alert: Alert): Promise<void> {
    await mkdir(dirname(this.opts.alertFile), { recursive: true });
    await appendFile(this.opts.alertFile, `${JSON.stringify(alert)}\n`);
  }
}
