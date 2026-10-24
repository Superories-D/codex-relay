import { deliveryChecksSchema, type DeliveryCheck } from "../shared/delivery";
const storageKey = (key: string) => `relay.deliveryDraft:${key}`;
export function readDeliveryDraft(
  key: string,
  storage: Storage = localStorage,
): DeliveryCheck[] {
  try {
    return deliveryChecksSchema.parse(
      JSON.parse(storage.getItem(storageKey(key)) || "[]"),
    );
  } catch {
    return [];
  }
}
export function writeDeliveryDraft(
  key: string,
  checks: DeliveryCheck[],
  storage: Storage = localStorage,
) {
  storage.setItem(
    storageKey(key),
    JSON.stringify(deliveryChecksSchema.parse(checks)),
  );
}
export function clearDeliveryDraft(
  key: string,
  submitted: DeliveryCheck[],
  storage: Storage = localStorage,
) {
  try {
    if (
      JSON.stringify(readDeliveryDraft(key, storage)) ===
      JSON.stringify(submitted)
    )
      storage.removeItem(storageKey(key));
  } catch {
    /* Do not turn an accepted task into a failed submission. */
  }
}
