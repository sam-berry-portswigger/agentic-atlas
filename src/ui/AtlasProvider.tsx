import {
  ActionIcon,
  Button,
  Drawer,
  Input,
  MantineProvider,
  Modal,
  MultiSelect,
  Select,
  SegmentedControl,
  Tabs,
  Textarea,
  TextInput,
  createTheme,
} from "@mantine/core";
import {
  useLayoutEffect,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Notifications } from "@mantine/notifications";
import {
  AppearanceContext,
  appearanceKey,
  readAppearance,
  type Appearance,
} from "./Appearance";
import "./appearance.css";
const theme = createTheme({
  primaryColor: "sage",
  primaryShade: 6,
  autoContrast: true,
  colors: {
    dark: [
      "#e5eaf0",
      "#bac6d2",
      "#96a5b6",
      "#718195",
      "#4b5b70",
      "#354254",
      "#293541",
      "#202a35",
      "#19222c",
      "#141c25",
    ],
    sage: [
      "#f3f7f0",
      "#e9f0e3",
      "#d7e4cf",
      "#b8d0ad",
      "#94b68c",
      "#709b73",
      "#47795f",
      "#3e6c54",
      "#315843",
      "#234432",
    ],
    lavender: [
      "#f6f2fc",
      "#ede6f7",
      "#dbcfed",
      "#c4b2e1",
      "#ad95d5",
      "#9678c7",
      "#7a5caf",
      "#684b99",
      "#563d80",
      "#453066",
    ],
  },
  fontFamily: '"Avenir Next", -apple-system, BlinkMacSystemFont, sans-serif',
  headings: {
    fontFamily: '"Avenir Next", -apple-system, BlinkMacSystemFont, sans-serif',
  },
  fontSizes: { xs: "12px", sm: "13px", md: "14px", lg: "16px", xl: "20px" },
  defaultRadius: "md",
  radius: { xs: "4px", sm: "6px", md: "8px", lg: "12px", xl: "16px" },
  components: {
    Button: Button.extend({
      defaultProps: { size: "sm", fw: 500 },
      styles: { label: { gap: 8 } },
    }),
    ActionIcon: ActionIcon.extend({
      defaultProps: { variant: "subtle", color: "gray", size: "md" },
    }),
    Input: Input.extend({
      styles: { input: { borderColor: "var(--mantine-color-default-border)" } },
    }),
    TextInput: TextInput.extend({ defaultProps: { size: "sm" } }),
    Textarea: Textarea.extend({ defaultProps: { size: "sm" } }),
    Select: Select.extend({
      defaultProps: {
        size: "sm",
        allowDeselect: false,
        maxDropdownHeight: 240,
      },
    }),
    MultiSelect: MultiSelect.extend({
      defaultProps: { size: "sm", maxDropdownHeight: 240 },
    }),
    SegmentedControl: SegmentedControl.extend({
      defaultProps: {
        size: "sm",
        withItemsBorders: false,
        transitionDuration: 150,
      },
    }),
    Tabs: Tabs.extend({ defaultProps: { variant: "default", radius: "md" } }),
    Drawer: Drawer.extend({
      defaultProps: {
        position: "right",
        size: 460,
        padding: "lg",
        overlayProps: { backgroundOpacity: 0.15 },
      },
      styles: {
        content: { background: "var(--mantine-color-body)" },
        header: {
          background: "var(--mantine-color-body)",
          borderBottom: "1px solid var(--mantine-color-default-border)",
        },
        body: { paddingTop: 20 },
        title: { fontSize: 14, fontWeight: 600 },
      },
    }),
    Modal: Modal.extend({
      defaultProps: {
        centered: true,
        size: 560,
        padding: "lg",
        overlayProps: { backgroundOpacity: 0.25, blur: 3 },
      },
      styles: {
        content: {
          background: "var(--mantine-color-body)",
          border: "1px solid var(--mantine-color-default-border)",
        },
        header: { background: "var(--mantine-color-body)" },
        title: {
          fontSize: 20,
          lineHeight: 1.45,
          fontWeight: 600,
          overflowWrap: "anywhere",
        },
      },
    }),
  },
});
export default function AtlasProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState(readAppearance);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const resolvedMode =
    appearance.mode === "auto"
      ? systemDark
        ? "dark"
        : "light"
      : appearance.mode;
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    const storage = (event: StorageEvent) => {
      if (event.key === appearanceKey) setAppearance(readAppearance());
    };
    window.addEventListener("storage", storage);
    return () => {
      media.removeEventListener("change", change);
      window.removeEventListener("storage", storage);
    };
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.atlasAccent = appearance.accent;
  }, [appearance.accent]);
  const value = useMemo(
    () => ({
      appearance,
      resolvedMode,
      update: (next: Partial<Appearance>) =>
        setAppearance((old) => {
          const updated = { ...old, ...next };
          try {
            localStorage.setItem(appearanceKey, JSON.stringify(updated));
          } catch {
            /* Appearance still works when browser storage is unavailable. */
          }
          return updated;
        }),
    }),
    [appearance, resolvedMode],
  );
  return (
    <AppearanceContext.Provider value={value}>
      <MantineProvider
        theme={{ ...theme, primaryColor: appearance.accent }}
        forceColorScheme={resolvedMode}
        cssVariablesResolver={() => ({
          variables: {},
          light: {
            "--mantine-color-text": "#28323d",
            "--mantine-color-dimmed": "#65727d",
            "--mantine-color-placeholder": "#65727d",
          },
          dark: {
            "--mantine-color-body": "#1b222c",
            "--mantine-color-text": "#e5eaf0",
            "--mantine-color-dimmed": "#a9b5c3",
            "--mantine-color-placeholder": "#98a6b6",
          },
        })}
      >
        <Notifications
          position="bottom-center"
          autoClose={3500}
          transitionDuration={200}
          containerWidth={420}
          limit={3}
          zIndex={1000}
        />
        {children}
      </MantineProvider>
    </AppearanceContext.Provider>
  );
}
