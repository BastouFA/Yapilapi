interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}
declare const config: {
  poweredByHeader?: boolean;
  headers?: () => Promise<HeaderRule[]>;
} & Record<string, unknown>;
export default config;
