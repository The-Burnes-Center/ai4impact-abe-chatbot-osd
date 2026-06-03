/** registry — single source of truth for the demo set: component, TIMINGS, and
 *  card geometry. The recorder reads loopMs + viewport off `window.__DEMO__`
 *  (set by DemoGallery) so node never has to duplicate this config. */
import { type ComponentType } from "react";
import { loopMs } from "./demo-kit";
import ChatDemo, { TIMINGS as chatT, CARD as chatC } from "./ChatDemo";
import DataSyncDemo, { TIMINGS as dataT, CARD as dataC } from "./DataSyncDemo";
import ExcelDemo, { TIMINGS as excelT, CARD as excelC } from "./ExcelDemo";
import MetricsDemo, { TIMINGS as metricsT, CARD as metricsC } from "./MetricsDemo";
import EvalDemo, { TIMINGS as evalT, CARD as evalC } from "./EvalDemo";

export type Card = { width: number; bodyHeight: number };
export type DemoDef = {
  id: string;
  label: string;
  file: string; // output filename stem
  Comp: ComponentType;
  timings: number[];
  card: Card;
};

export const DEMOS: DemoDef[] = [
  { id: "chat", label: "Chat — semantic RAG + citations", file: "abe-demo-chat", Comp: ChatDemo, timings: chatT, card: chatC },
  { id: "data", label: "Data & Knowledge Base sync", file: "abe-demo-data", Comp: DataSyncDemo, timings: dataT, card: dataC },
  { id: "excel", label: "Excel index — structured query", file: "abe-demo-excel", Comp: ExcelDemo, timings: excelT, card: excelC },
  { id: "metrics", label: "Analytics dashboard", file: "abe-demo-metrics", Comp: MetricsDemo, timings: metricsT, card: metricsC },
  { id: "eval", label: "LLM evaluation (RAGAS)", file: "abe-demo-eval", Comp: EvalDemo, timings: evalT, card: evalC },
];

const CHROME = 46; // faux browser bar height
const PAD = 40; // outer padding (20 × 2)

export function viewportOf(card: Card) {
  return { width: card.width + PAD, height: card.bodyHeight + CHROME + PAD };
}
export const loopOf = (d: DemoDef) => loopMs(d.timings);
export const byId = (id: string) => DEMOS.find((d) => d.id === id);
