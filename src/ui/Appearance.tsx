import { createContext, useContext } from "react";
import { Group, SegmentedControl, Stack, Text } from "@mantine/core";

export type AppearanceMode = "light" | "dark" | "auto";
export type Accent = "sage" | "lavender" | "blue";
export type Appearance = { mode: AppearanceMode; accent: Accent };
export const appearanceKey = "atlas-appearance-v1";
export const defaultAppearance: Appearance = { mode: "light", accent: "sage" };
export function readAppearance(): Appearance {
  try {
    const value = JSON.parse(localStorage.getItem(appearanceKey) || "null");
    return {
      mode: ["light", "dark", "auto"].includes(value?.mode)
        ? value.mode
        : "light",
      accent: ["sage", "lavender", "blue"].includes(value?.accent)
        ? value.accent
        : "sage",
    };
  } catch {
    return defaultAppearance;
  }
}
export const AppearanceContext = createContext<{
  appearance: Appearance;
  resolvedMode: "light" | "dark";
  update: (value: Partial<Appearance>) => void;
}>({ appearance: defaultAppearance, resolvedMode: "light", update: () => {} });
export const useAppearance = () => useContext(AppearanceContext);

export function AppearanceControls() {
  const { appearance, update } = useAppearance();
  return (
    <Stack gap="sm" className="atlas-appearance-controls">
      <Text fw={600} size="sm">
        Appearance
      </Text>
      <SegmentedControl
        aria-label="Colour mode"
        value={appearance.mode}
        onChange={(mode) => update({ mode: mode as AppearanceMode })}
        data={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "auto", label: "System" },
        ]}
      />
      <Text size="sm" c="dimmed">
        Accent colour
      </Text>
      <Group gap="xs" aria-label="Accent colour">
        {(["sage", "lavender", "blue"] as const).map((accent) => (
          <button
            key={accent}
            type="button"
            className="atlas-accent-choice"
            aria-pressed={appearance.accent === accent}
            onClick={() => update({ accent })}
          >
            <i
              style={{
                background: {
                  sage: "#709b73",
                  lavender: "#9076c6",
                  blue: "#588ab9",
                }[accent],
              }}
            />
            {accent[0].toUpperCase() + accent.slice(1)}
          </button>
        ))}
      </Group>
      <Text size="xs" c="dimmed">
        Saved in this browser. System follows your device’s appearance.
      </Text>
    </Stack>
  );
}
