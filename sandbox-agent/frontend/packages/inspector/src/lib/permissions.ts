export const askForLocalNetworkAccess = async (): Promise<boolean> => {
  try {
    const status = await navigator.permissions.query({
      // @ts-expect-error - local-network-access is not in standard types
      name: "local-network-access",
    });
    if (status.state === "granted") {
      return true;
    }
    if (status.state === "denied") {
      return false;
    }
    // If promptable, return true - browser will prompt on first request
    return true;
  } catch {
    // Permissions API not supported or permission not recognized - try anyway
    return true;
  }
};

export const isHttpsToHttpConnection = (pageUrl: string, targetUrl: string): boolean => {
  try {
    const page = new URL(pageUrl);
    const target = new URL(targetUrl);
    return page.protocol === "https:" && target.protocol === "http:";
  } catch {
    return false;
  }
};

export const isLocalNetworkTarget = (targetUrl: string): boolean => {
  try {
    const url = new URL(targetUrl);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local") ||
      // Private IPv4 ranges
      /^10\./.test(hostname) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
      /^192\.168\./.test(hostname)
    );
  } catch {
    return false;
  }
};
