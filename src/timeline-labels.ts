import type { TimelineItem } from "./dashboard-types.ts";

export const requestStatuses = { completed: "已完成", failed: "失败", cancelled: "已取消" };

export function timelineLabel(item: TimelineItem, requestNumber: number): string {
  if (item.kind === "request") return `请求 ${requestNumber} · ${requestStatuses[item.status]}`;
  if (item.kind === "compaction") {
    return item.trigger === "auto" ? "自动压缩" : item.trigger === "manual" ? "手动压缩" : "上下文压缩";
  }
  return item.kind === "agent-start" ? "子代理启动" : "子代理结束";
}
