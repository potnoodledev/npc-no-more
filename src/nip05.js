/**
 * NIP-05 subdomain management via the API service.
 * Lets users claim/release NIP-05 subdomains via the API service.
 */

import { getAuthHeaders } from "./nostr.js";

const API_URL = import.meta.env.VITE_API_URL || "";

export async function claimName(name, account) {
  const url = `${API_URL}/nip05/claim`;
  const headers = await getAuthHeaders(url, "POST", account);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

export async function releaseName(name, account) {
  const url = `${API_URL}/nip05/claim`;
  const headers = await getAuthHeaders(url, "DELETE", account);
  const res = await fetch(url, {
    method: "DELETE",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

export async function getMyNames(account) {
  const url = `${API_URL}/nip05/my-names`;
  const headers = await getAuthHeaders(url, "GET", account);
  const res = await fetch(url, { headers });
  return res.json();
}

export async function getAdminNip05Names(account) {
  const url = `${API_URL}/admin/nip05/names`;
  const headers = await getAuthHeaders(url, "GET", account);
  const res = await fetch(url, { headers });
  return res.json();
}

export async function adminRemoveName(name, account) {
  const url = `${API_URL}/admin/nip05/${name}`;
  const headers = await getAuthHeaders(url, "DELETE", account);
  const res = await fetch(url, { method: "DELETE", headers });
  return res.json();
}
