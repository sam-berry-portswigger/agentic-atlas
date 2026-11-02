import { notifications } from "@mantine/notifications";
import { Check, Info } from "lucide-react";

export function notify(
  message: string,
  kind: "success" | "info" | "progress" = "success",
) {
  notifications.show({
    message,
    color: "blue",
    loading: kind === "progress",
    icon:
      kind === "progress" ? undefined : kind === "info" ? (
        <Info size={16} aria-hidden="true" />
      ) : (
        <Check size={16} aria-hidden="true" />
      ),
    withBorder: true,
    closeButtonProps: { "aria-label": "Dismiss notification" },
  });
}
