const sodium = require("libsodium-wrappers");
const https = require("https");

const PAT = process.env.GITHUB_PAT;
const REPO = "potnoodledev/npc-no-more";

const SECRETS = {};
// Collect from env
if (process.env.RAILWAY_TOKEN) SECRETS.RAILWAY_TOKEN = process.env.RAILWAY_TOKEN;
if (process.env.ADMIN_SECRET) SECRETS.ADMIN_SECRET = process.env.ADMIN_SECRET;

function httpReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const opts = {
      hostname: "api.github.com",
      path,
      method,
      headers: {
        Authorization: `token ${PAT}`,
        "Content-Type": "application/json",
        "User-Agent": "node",
      },
    };
    if (data) opts.headers["Content-Length"] = Buffer.byteLength(data);

    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: d ? JSON.parse(d) : {} });
        } catch {
          resolve({ status: res.statusCode, data: d });
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await sodium.ready;

  // Get repo public key
  const resp = await httpReq("GET", `/repos/${REPO}/actions/secrets/public-key`);
  console.log("Public key response:", resp.status, JSON.stringify(resp.data));

  const keyStr = resp.data.key;
  const keyId = resp.data.key_id;

  if (!keyStr) {
    console.error("Failed to get public key");
    process.exit(1);
  }

  const publicKey = sodium.from_base64(keyStr, sodium.base64_variants.ORIGINAL);

  for (const [name, value] of Object.entries(SECRETS)) {
    const messageBytes = Buffer.from(value);
    const encryptedBytes = sodium.crypto_box_seal(messageBytes, publicKey);
    const encrypted = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

    const result = await httpReq("PUT", `/repos/${REPO}/actions/secrets/${name}`, {
      encrypted_value: encrypted,
      key_id: keyId,
    });
    const ok = result.status === 201 || result.status === 204;
    console.log(`${name}: ${ok ? "✅" : "❌"} (${result.status})`);
  }
}

main().catch(console.error);
