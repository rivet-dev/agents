import { escapeSingleQuotes } from "./format";

export const buildCurl = (method: string, url: string, body?: string, token?: string) => {
  const headers: string[] = [];
  if (token) {
    headers.push(`-H 'Authorization: Bearer ${escapeSingleQuotes(token)}'`);
  }
  if (body) {
    headers.push(`-H 'Content-Type: application/json'`);
  }
  const data = body ? `-d '${escapeSingleQuotes(body)}'` : "";
  return `curl -X ${method} ${headers.join(" ")} ${data} '${escapeSingleQuotes(url)}'`.replace(/\s+/g, " ").trim();
};
