import type {DeliveryState} from "../shared/delivery";

/** Describe recorded evidence without implying that a past pass proves current bytes. */
export function deliveryStatus(delivery?: DeliveryState) {
  if (!delivery?.checks.length) return "未设置验收条件";
  if (delivery.pendingCompletion) return "正在验收交付产物";
  const report = delivery.reports.at(-1);
  if (report && delivery.staleEvidence?.reportId === report.id) return "交付证据已失效";
  if (!report || report.revision !== delivery.revision) return "等待交付验收";
  return {passed: "最近检查通过", failed: "验收未通过", unverified: "暂无法验证"}[report.status];
}
