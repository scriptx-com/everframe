// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Compile-time guard, not a runtime test: checked by `tsc -p tsconfig.test.json`.
// Companion was removed, but code written against the old `companion.start()`
// options must keep compiling. Inline callbacks that read the old argument
// shapes (`msg.title`, `ws.send(...)`) and callbacks annotated with the old
// type names must still type-check against the deprecated stubs.
import { companion, start } from '../src/index.js';
import type {
  CompanionStartOptions,
  RelayMessage,
  RelayWSClient,
  ReportCounts,
  ReportSubmit,
} from '../src/index.js';

companion.start({
  onReportSubmit: (msg) => console.log(msg.title, msg.correlation_id, msg.includes.logs),
  onReportRequest: (correlationId, ws) => {
    ws.send({ type: 'report.cancelled', correlation_id: correlationId });
    ws.sendBinary(new ArrayBuffer(0));
    ws.stop();
    const token: string | null = ws.getCompanionAttribution();
    void token;
  },
  counts: { logs: 1, network: 2, uiTreeNodes: 0, breadcrumbs: 3 },
});

const onSubmit = (msg: ReportSubmit): void => console.log(msg.description.text);
const onRequest = (id: string, ws: RelayWSClient): void => ws.start();
const counts: ReportCounts = { logs: 0, network: 0, uiTreeNodes: 0 };
const options: CompanionStartOptions = {
  onReportSubmit: onSubmit,
  onReportRequest: onRequest,
  counts,
};
start(options);

const frame: RelayMessage = { type: 'report.cancelled', correlation_id: 'c' };
void frame;
