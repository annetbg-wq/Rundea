export type NodeBootstrap = { id: string; token: string };

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function createNodeInstallCommand(originInput: string, bootstrap: NodeBootstrap): string | null {
  const origin = originInput.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== origin
  ) {
    return null;
  }
  const installerUrl = `${origin}/v0/install.sh`;
  return `tmp="$(mktemp)" && { curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-redirs 0 ${shellQuote(installerUrl)} -o "$tmp" && sudo env RUNDEA_CONTROL_PLANE_URL=${shellQuote(origin)} RUNDEA_NODE_ID=${shellQuote(bootstrap.id)} RUNDEA_NODE_TOKEN=${shellQuote(bootstrap.token)} bash "$tmp"; status=$?; rm -f "$tmp"; exit $status; }`;
}
