export type TuiTheme = Readonly<{
  accent: string | undefined;
  background: string | undefined;
  colorEnabled: boolean;
  danger: string | undefined;
  foreground: string | undefined;
  muted: string | undefined;
  success: string | undefined;
  surface: string | undefined;
}>;

export function createTheme(env: Readonly<Record<string, string | undefined>> = process.env): TuiTheme {
  const colorEnabled = env.NO_COLOR === undefined;
  return Object.freeze(colorEnabled
    ? {
        accent: "#7aa2f7",
        background: "#101014",
        colorEnabled,
        danger: "#f7768e",
        foreground: "#e6e6e6",
        muted: "#8b8b98",
        success: "#9ece6a",
        surface: "#1a1b26",
      }
    : {
        accent: "white",
        background: "transparent",
        colorEnabled,
        danger: "white",
        foreground: "white",
        muted: "white",
        success: "white",
        surface: "transparent",
      });
}
