export interface AppConfig {
  apiUrl: string;
  iceServers: RTCIceServer[];
}

let cachedConfig: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    // Load basic config (API URL and public STUN servers)
    const response = await fetch("/mikroroom.config.json");
    if (!response.ok) {
      throw new Error(`Failed to load config: ${response.status}`);
    }

    const config = await response.json();

    // Resolve "auto" to actual URL
    if (config.apiUrl === "auto") {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      config.apiUrl = `${protocol}//${window.location.host}/ws`;
    }

    // Fetch ICE servers (including TURN credentials) from server
    try {
      // Convert ws(s)://host/ws → http(s)://host
      const apiBaseUrl = config.apiUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
      const iceResponse = await fetch(`${apiBaseUrl}/config`);
      if (iceResponse.ok) {
        const iceConfig = await iceResponse.json();
        config.iceServers = iceConfig.iceServers;
        console.log("[Config] ICE servers loaded from server");
      }
    } catch (iceError) {
      console.warn("[Config] Failed to fetch ICE servers from server, using defaults:", iceError);
    }

    cachedConfig = config;
    console.log("[Config] Loaded:", config);
    return config;
  } catch (error) {
    console.warn("[Config] Failed to load config, using defaults:", error);

    // Fallback to auto-detected URL
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const fallback: AppConfig = {
      apiUrl: `${protocol}//${window.location.host}/ws`,
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    };

    cachedConfig = fallback;
    return fallback;
  }
}

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    throw new Error("Config not loaded yet. Call loadConfig() first.");
  }
  return cachedConfig;
}

export function getApiBaseUrl(): string {
  const config = getConfig();
  // Convert ws(s)://host/ws → http(s)://host
  return config.apiUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

export function clearConfigCache(): void {
  cachedConfig = null;
}
